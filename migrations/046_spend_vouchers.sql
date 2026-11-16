-- Spend vouchers are non-cash, non-transferable purchasing credits created only
-- by process_transfer from a sender's real USD wallet balance.
CREATE TABLE IF NOT EXISTS public.spend_vouchers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_wallet_id uuid NOT NULL REFERENCES public.wallets(id) ON DELETE CASCADE,
  sender_wallet_id    uuid NOT NULL REFERENCES public.wallets(id) ON DELETE RESTRICT,
  transfer_id         uuid REFERENCES public.p2p_transfers(id) ON DELETE SET NULL,
  amount              numeric(12,2) NOT NULL CHECK (amount > 0),
  remaining_amount    numeric(12,2) NOT NULL CHECK (remaining_amount >= 0 AND remaining_amount <= amount),
  currency_code       character(3) NOT NULL DEFAULT 'USD' CHECK (currency_code = 'USD'),
  expires_at          timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT spend_voucher_expiry CHECK (expires_at = created_at + interval '30 days')
);

CREATE INDEX IF NOT EXISTS spend_vouchers_recipient_active_idx
  ON public.spend_vouchers (recipient_wallet_id, expires_at)
  WHERE remaining_amount > 0;

ALTER TABLE wallet_transactions DROP CONSTRAINT IF EXISTS wallet_transactions_type_check;
ALTER TABLE wallet_transactions ADD CONSTRAINT wallet_transactions_type_check
  CHECK (type = ANY (ARRAY[
    'deposit'::text, 'cashout'::text, 'cashout_cancelled'::text,
    'token_purchase'::text, 'token_spend'::text, 'token_reward'::text,
    'transfer_in'::text, 'transfer_out'::text, 'transfer_fee'::text,
    'voucher_spend'::text, 'app_purchase'::text,
    'marketplace_listing_fee'::text, 'marketplace_featured_fee'::text,
    'marketplace_purchase'::text, 'marketplace_sale'::text,
    'marketplace_royalty'::text, 'currency_conversion'::text,
    'leadership_game_join_fee'::text, 'leadership_game_prize'::text
  ]));

ALTER TABLE public.spend_vouchers ENABLE ROW LEVEL SECURITY;

-- Recipients may see their own vouchers. There are deliberately no client
-- INSERT, UPDATE, or DELETE policies: all mutations go through SECURITY DEFINER RPCs.
DROP POLICY IF EXISTS spend_vouchers_recipient_select ON public.spend_vouchers;
CREATE POLICY spend_vouchers_recipient_select ON public.spend_vouchers
  FOR SELECT USING (
    recipient_wallet_id IN (SELECT id FROM public.wallets WHERE user_id = auth.uid())
  );

REVOKE ALL ON public.spend_vouchers FROM anon, authenticated;
GRANT SELECT ON public.spend_vouchers TO authenticated;

CREATE OR REPLACE FUNCTION public.get_spend_voucher_balance()
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(SUM(sv.remaining_amount), 0)::numeric(12,2)
  FROM spend_vouchers sv
  JOIN wallets w ON w.id = sv.recipient_wallet_id
  WHERE w.user_id = auth.uid()
    AND sv.remaining_amount > 0
    AND sv.expires_at > now();
$$;

GRANT EXECUTE ON FUNCTION public.get_spend_voucher_balance() TO authenticated;

-- App purchases call this function to consume the recipient's vouchers in FIFO
-- order. It never credits wallet_balance and cannot be used for cashout/P2P.
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
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not signed in');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Amount must be greater than 0');
  END IF;

  SELECT id INTO v_wallet_id FROM wallets WHERE user_id = auth.uid() FOR UPDATE;
  IF v_wallet_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Wallet not found');
  END IF;

  SELECT COALESCE(SUM(remaining_amount), 0) INTO v_remaining
  FROM spend_vouchers
  WHERE recipient_wallet_id = v_wallet_id AND remaining_amount > 0 AND expires_at > now();
  IF v_remaining < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error', 'Insufficient spend voucher balance');
  END IF;

  FOR v_voucher IN
    SELECT id, remaining_amount FROM spend_vouchers
    WHERE recipient_wallet_id = v_wallet_id AND remaining_amount > 0 AND expires_at > now()
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

    RETURN jsonb_build_object('success', true, 'spent', v_requested,
                            'remaining_balance', (SELECT COALESCE(SUM(remaining_amount), 0)
                              FROM spend_vouchers WHERE recipient_wallet_id = v_wallet_id
                              AND remaining_amount > 0 AND expires_at > now()));
END;
$$;

GRANT EXECUTE ON FUNCTION public.spend_voucher(numeric, text) TO authenticated;

-- Atomic helper for purchases that produce an in-app entitlement. Vouchers
-- are consumed first; any remainder is charged to the real USD wallet.
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
  SELECT * INTO v_wallet FROM wallets WHERE user_id = auth.uid() FOR UPDATE;
  IF v_wallet.id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Wallet not found'); END IF;

  SELECT COALESCE(SUM(remaining_amount), 0) INTO v_voucher_total
  FROM spend_vouchers WHERE recipient_wallet_id = v_wallet.id AND remaining_amount > 0 AND expires_at > now();
  v_voucher_to_use := LEAST(p_amount, v_voucher_total);
  v_voucher_used := v_voucher_to_use;
  v_wallet_to_use := p_amount - v_voucher_to_use;
  IF v_wallet.wallet_balance < v_wallet_to_use THEN
    RETURN jsonb_build_object('success', false, 'error', 'Insufficient wallet and spend voucher balance');
  END IF;

  FOR v_voucher IN
    SELECT id, remaining_amount FROM spend_vouchers
    WHERE recipient_wallet_id = v_wallet.id AND remaining_amount > 0 AND expires_at > now()
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
    jsonb_build_object('voucher_amount', v_voucher_total - v_voucher_to_use, 'wallet_amount', v_wallet_to_use));

  RETURN jsonb_build_object('success', true, 'voucher_amount', v_voucher_used,
    'wallet_amount', v_wallet_to_use, 'wallet_balance', v_wallet.wallet_balance - v_wallet_to_use);
END;
$$;
GRANT EXECUTE ON FUNCTION public.consume_app_balance(numeric, text) TO authenticated;

-- Replace the previous real-wallet P2P behavior with voucher issuance.
DROP FUNCTION IF EXISTS public.process_transfer(uuid, numeric, text, text);
CREATE OR REPLACE FUNCTION public.process_transfer(
  p_to_wallet_id uuid,
  p_amount numeric,
  p_currency text DEFAULT 'USD',
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_from wallets%ROWTYPE;
  v_to wallets%ROWTYPE;
  v_fee numeric := 0;
  v_transfer_id uuid;
  v_reference text;
  v_expires_at timestamptz;
BEGIN
  IF p_currency <> 'USD' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Only USD wallet funds can be sent as spend vouchers');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Amount must be greater than 0');
  END IF;

  SELECT * INTO v_from FROM wallets WHERE user_id = auth.uid() FOR UPDATE;
  SELECT * INTO v_to FROM wallets WHERE id = p_to_wallet_id FOR UPDATE;
  IF v_from.id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Sender wallet not found'); END IF;
  IF v_to.id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Recipient wallet not found'); END IF;
  IF v_from.id = v_to.id THEN RETURN jsonb_build_object('success', false, 'error', 'Cannot transfer to your own wallet'); END IF;

  v_fee := calculate_fee('wallet_transfer', p_amount);
  IF v_from.wallet_balance < p_amount + v_fee THEN
    RETURN jsonb_build_object('success', false, 'error', 'Insufficient balance including transfer fee');
  END IF;

  v_reference := 'VCH-' || upper(substring(gen_random_uuid()::text, 1, 8));
  v_expires_at := now() + interval '30 days';
  UPDATE wallets SET wallet_balance = wallet_balance - p_amount - v_fee, updated_at = now() WHERE id = v_from.id;

  INSERT INTO p2p_transfers (sender_wallet_id, receiver_wallet_id, amount, currency_code, status, reference)
  VALUES (v_from.id, v_to.id, p_amount, 'USD', 'completed', v_reference)
  RETURNING id INTO v_transfer_id;

  INSERT INTO spend_vouchers (recipient_wallet_id, sender_wallet_id, transfer_id, amount, remaining_amount, expires_at)
  VALUES (v_to.id, v_from.id, v_transfer_id, p_amount, p_amount, v_expires_at);

  INSERT INTO wallet_transactions (wallet_id, type, amount, description, status, currency_code, metadata)
  VALUES
    (v_from.id, 'transfer_out', -p_amount - v_fee, COALESCE(p_note, 'Spend voucher sent'), 'completed', 'USD',
      jsonb_build_object('to_wallet_id', v_to.id, 'reference', v_reference, 'voucher_expires_at', v_expires_at, 'fee', v_fee)),
    (v_to.id, 'transfer_in', p_amount, COALESCE(p_note, 'Spend voucher received'), 'completed', 'USD',
      jsonb_build_object('from_wallet_id', v_from.id, 'reference', v_reference, 'voucher_expires_at', v_expires_at));

  IF v_fee > 0 THEN
    INSERT INTO wallet_transactions (wallet_id, type, amount, description, status, currency_code, metadata)
    VALUES (v_from.id, 'transfer_fee', -v_fee, 'Spend voucher transfer fee', 'completed', 'USD',
      jsonb_build_object('reference', v_reference));
    PERFORM record_revenue(
      p_source => 'wallet_transfer', p_user_id => v_from.user_id, p_reference_id => v_transfer_id,
      p_gross_amount => p_amount, p_revenue_amount => v_fee, p_currency => 'USD',
      p_metadata => jsonb_build_object('voucher', true, 'reference', v_reference));
  END IF;

  RETURN jsonb_build_object('success', true, 'data', jsonb_build_object(
    'transfer_id', v_transfer_id, 'reference', v_reference, 'amount', p_amount,
    'fee', v_fee, 'currency', 'USD', 'expires_at', v_expires_at, 'voucher', true));
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;
GRANT EXECUTE ON FUNCTION public.process_transfer(uuid, numeric, text, text) TO authenticated;
