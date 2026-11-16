-- Return unspent voucher value to the original sender when the 30-day
-- lifetime ends. The transfer fee is never refunded.
ALTER TABLE public.spend_vouchers
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS expired_at timestamptz,
  ADD COLUMN IF NOT EXISTS refunded_amount numeric(12,2) NOT NULL DEFAULT 0;

ALTER TABLE public.spend_vouchers DROP CONSTRAINT IF EXISTS spend_vouchers_status_check;
ALTER TABLE public.spend_vouchers ADD CONSTRAINT spend_vouchers_status_check
  CHECK (status IN ('active', 'expired'));

ALTER TABLE wallet_transactions DROP CONSTRAINT IF EXISTS wallet_transactions_type_check;
ALTER TABLE wallet_transactions ADD CONSTRAINT wallet_transactions_type_check
  CHECK (type = ANY (ARRAY[
    'deposit'::text, 'cashout'::text, 'cashout_cancelled'::text,
    'token_purchase'::text, 'token_spend'::text, 'token_reward'::text,
    'transfer_in'::text, 'transfer_out'::text, 'transfer_fee'::text,
    'voucher_spend'::text, 'voucher_expiry_refund'::text, 'app_purchase'::text,
    'marketplace_listing_fee'::text, 'marketplace_featured_fee'::text,
    'marketplace_purchase'::text, 'marketplace_sale'::text,
    'marketplace_royalty'::text, 'currency_conversion'::text,
    'leadership_game_join_fee'::text, 'leadership_game_prize'::text
  ]));

CREATE INDEX IF NOT EXISTS spend_vouchers_expiry_idx
  ON public.spend_vouchers (expires_at)
  WHERE status = 'active';

-- This function is intentionally idempotent. Row locks ensure a voucher can
-- only be refunded once, even if multiple callers trigger expiry processing.
CREATE OR REPLACE FUNCTION public.expire_spend_vouchers()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_voucher record;
  v_refunded numeric;
  v_count integer := 0;
  v_reference text;
BEGIN
  FOR v_voucher IN
    SELECT * FROM spend_vouchers
    WHERE status = 'active' AND expires_at <= now()
    ORDER BY expires_at, id
    FOR UPDATE SKIP LOCKED
  LOOP
    v_refunded := GREATEST(COALESCE(v_voucher.remaining_amount, 0), 0);
    v_reference := 'VRF-' || upper(substring(gen_random_uuid()::text, 1, 8));

    IF v_refunded > 0 THEN
      UPDATE wallets
      SET wallet_balance = wallet_balance + v_refunded, updated_at = now()
      WHERE id = v_voucher.sender_wallet_id;

      INSERT INTO wallet_ledger
        (wallet_id, transaction_type, debit, credit, balance_before, balance_after, reference_id)
      SELECT
        w.id, 'voucher_expiry_refund', 0, v_refunded,
        w.wallet_balance - v_refunded, w.wallet_balance, v_voucher.id
      FROM wallets w
      WHERE w.id = v_voucher.sender_wallet_id;

      INSERT INTO wallet_transactions
        (wallet_id, type, amount, description, status, currency_code, metadata)
      VALUES
        (v_voucher.sender_wallet_id, 'voucher_expiry_refund', v_refunded,
         'Refund for expired spend voucher', 'completed', 'USD',
         jsonb_build_object(
           'voucher_id', v_voucher.id,
           'reference', v_reference,
           'recipient_wallet_id', v_voucher.recipient_wallet_id
         ));
    END IF;

    UPDATE spend_vouchers
    SET status = 'expired', expired_at = now(), refunded_amount = v_refunded,
        remaining_amount = 0
    WHERE id = v_voucher.id;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.expire_spend_vouchers() FROM PUBLIC, anon, authenticated;

-- Run expiry processing before balance reads, so the displayed balance never
-- includes expired value and the sender gets the refund without waiting for a job.
DROP FUNCTION IF EXISTS public.get_spend_voucher_balance();
CREATE OR REPLACE FUNCTION public.get_spend_voucher_balance()
RETURNS numeric
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM expire_spend_vouchers();
  RETURN (
    SELECT COALESCE(SUM(sv.remaining_amount), 0)::numeric(12,2)
    FROM spend_vouchers sv
    JOIN wallets w ON w.id = sv.recipient_wallet_id
    WHERE w.user_id = auth.uid() AND sv.status = 'active'
      AND sv.remaining_amount > 0 AND sv.expires_at > now()
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_spend_voucher_balance() TO authenticated;

-- Ensure all voucher spending paths expire/refund first.
CREATE OR REPLACE FUNCTION public.spend_voucher(
  p_amount numeric,
  p_description text DEFAULT 'In-app purchase'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wallet_id uuid;
  v_remaining numeric;
  v_requested numeric := p_amount;
  v_voucher record;
  v_take numeric;
BEGIN
  IF auth.uid() IS NULL OR p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid voucher spend request');
  END IF;
  PERFORM expire_spend_vouchers();
  SELECT id INTO v_wallet_id FROM wallets WHERE user_id = auth.uid() FOR UPDATE;
  IF v_wallet_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Wallet not found'); END IF;

  SELECT COALESCE(SUM(remaining_amount), 0) INTO v_remaining
  FROM spend_vouchers WHERE recipient_wallet_id = v_wallet_id AND status = 'active' AND remaining_amount > 0;
  IF v_remaining < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error', 'Insufficient spend voucher balance');
  END IF;

  FOR v_voucher IN
    SELECT id, remaining_amount FROM spend_vouchers
    WHERE recipient_wallet_id = v_wallet_id AND status = 'active' AND remaining_amount > 0
    ORDER BY expires_at, created_at, id FOR UPDATE
  LOOP
    EXIT WHEN p_amount <= 0;
    v_take := LEAST(p_amount, v_voucher.remaining_amount);
    UPDATE spend_vouchers SET remaining_amount = remaining_amount - v_take WHERE id = v_voucher.id;
    p_amount := p_amount - v_take;
  END LOOP;

  INSERT INTO wallet_transactions (wallet_id, type, amount, description, status, currency_code, metadata)
  VALUES (v_wallet_id, 'voucher_spend', -v_requested, p_description, 'completed', 'USD',
          jsonb_build_object('source', 'spend_voucher'));
  RETURN jsonb_build_object('success', true, 'spent', v_requested);
END;
$$;
GRANT EXECUTE ON FUNCTION public.spend_voucher(numeric, text) TO authenticated;

-- Existing consumers can use the same voucher-first path without ever
-- receiving permission to write voucher rows directly.
CREATE OR REPLACE FUNCTION public.consume_app_balance(
  p_amount numeric,
  p_description text DEFAULT 'In-app purchase'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wallet wallets%ROWTYPE;
  v_voucher_total numeric;
  v_voucher_to_use numeric;
  v_voucher_used numeric;
  v_wallet_to_use numeric;
  v_voucher record;
  v_take numeric;
BEGIN
  IF auth.uid() IS NULL OR p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid purchase request');
  END IF;
  PERFORM expire_spend_vouchers();
  SELECT * INTO v_wallet FROM wallets WHERE user_id = auth.uid() FOR UPDATE;
  IF v_wallet.id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Wallet not found'); END IF;

  SELECT COALESCE(SUM(remaining_amount), 0) INTO v_voucher_total
  FROM spend_vouchers WHERE recipient_wallet_id = v_wallet.id AND status = 'active' AND remaining_amount > 0;
  v_voucher_to_use := LEAST(p_amount, v_voucher_total);
  v_voucher_used := v_voucher_to_use;
  v_wallet_to_use := p_amount - v_voucher_to_use;
  IF v_wallet.wallet_balance < v_wallet_to_use THEN
    RETURN jsonb_build_object('success', false, 'error', 'Insufficient wallet and spend voucher balance');
  END IF;

  FOR v_voucher IN
    SELECT id, remaining_amount FROM spend_vouchers
    WHERE recipient_wallet_id = v_wallet.id AND status = 'active' AND remaining_amount > 0
    ORDER BY expires_at, created_at, id FOR UPDATE
  LOOP
    EXIT WHEN v_voucher_to_use <= 0;
    v_take := LEAST(v_voucher_to_use, v_voucher.remaining_amount);
    UPDATE spend_vouchers SET remaining_amount = remaining_amount - v_take WHERE id = v_voucher.id;
    v_voucher_to_use := v_voucher_to_use - v_take;
  END LOOP;

  IF v_wallet_to_use > 0 THEN
    UPDATE wallets SET wallet_balance = wallet_balance - v_wallet_to_use, updated_at = now() WHERE id = v_wallet.id;
  END IF;
  INSERT INTO wallet_transactions (wallet_id, type, amount, description, status, currency_code, metadata)
  VALUES (v_wallet.id, 'app_purchase', -p_amount, p_description, 'completed', 'USD',
    jsonb_build_object('voucher_amount', v_voucher_used, 'wallet_amount', v_wallet_to_use));
  RETURN jsonb_build_object('success', true, 'voucher_amount', v_voucher_used,
    'wallet_amount', v_wallet_to_use, 'wallet_balance', v_wallet.wallet_balance - v_wallet_to_use);
END;
$$;
GRANT EXECUTE ON FUNCTION public.consume_app_balance(numeric, text) TO authenticated;
