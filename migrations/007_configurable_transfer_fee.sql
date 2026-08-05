-- Introduces a DB-configurable wallet_transfer fee: a percentage-with-floor-
-- and-ceiling model (0.5% of the transfer, clamped between $0.10 and $0.50)
-- so small transfers aren't taxed at an effective 10-25% while larger ones
-- still get capped -- the same clamp shape already used for currency-
-- conversion fees (currencies.min_fee_usd/max_fee_usd, migration 003).
--
-- revenue_sources gets two new generic columns (min_value/max_value) rather
-- than a wallet-transfer-specific pair, so the same clamp shape is reusable
-- for retrofitting other fees later without another schema change.
--
-- Self-contained: upserts the wallet_transfer row directly rather than
-- assuming a prior migration already inserted it (an earlier flat-$0.50
-- version of this migration existed as 006 and was replaced by this one).

ALTER TABLE revenue_sources ADD COLUMN IF NOT EXISTS min_value numeric;
ALTER TABLE revenue_sources ADD COLUMN IF NOT EXISTS max_value numeric;

INSERT INTO revenue_sources (source, fee_type, value, min_value, max_value, description, category)
VALUES ('wallet_transfer', 'tiered', 0.50, 0.10, 0.50,
        'Percentage fee on USD peer-to-peer wallet transfers (process_transfer), clamped between min_value and max_value',
        'transfer')
ON CONFLICT (source) DO UPDATE SET
  fee_type = EXCLUDED.fee_type,
  value = EXCLUDED.value,
  min_value = EXCLUDED.min_value,
  max_value = EXCLUDED.max_value,
  description = EXCLUDED.description,
  category = EXCLUDED.category;

-- Fee config was previously unreadable by anyone but the service role (by
-- design, alongside revenue_transactions -- see migration 001's comment).
-- Letting the app preview an accurate fee before the user confirms means the
-- client needs to read it; the numbers themselves aren't sensitive (this is
-- the same info already shown as a hardcoded constant in MarketplaceModal.js),
-- so this is read-only, not a write policy.
DROP POLICY IF EXISTS revenue_sources_read_all ON revenue_sources;
CREATE POLICY revenue_sources_read_all ON revenue_sources
  FOR SELECT TO authenticated
  USING (true);

DROP FUNCTION IF EXISTS process_transfer(uuid, numeric, text, text);

CREATE OR REPLACE FUNCTION public.process_transfer(p_to_wallet_id uuid, p_amount numeric, p_currency text DEFAULT 'USD'::text, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_from_wallet wallets%ROWTYPE;
  v_to_wallet   wallets%ROWTYPE;
  v_sender_currency_balance NUMERIC;
  v_receiver_currency_before NUMERIC;
  v_fee_pct NUMERIC;
  v_fee_min NUMERIC;
  v_fee_max NUMERIC;
  v_transfer_fee NUMERIC := 0;
  v_reference   TEXT;
  v_transfer_id UUID;
BEGIN
  IF p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Amount must be greater than 0');
  END IF;

  SELECT * INTO v_from_wallet FROM wallets WHERE user_id = auth.uid() FOR UPDATE;
  IF v_from_wallet.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sender wallet not found');
  END IF;

  IF v_from_wallet.id = p_to_wallet_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cannot transfer to your own wallet');
  END IF;

  SELECT * INTO v_to_wallet FROM wallets WHERE id = p_to_wallet_id FOR UPDATE;
  IF v_to_wallet.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Recipient wallet not found');
  END IF;

  v_reference := 'TXN-' || upper(substring(gen_random_uuid()::text, 1, 8));

  IF p_currency = 'USD' THEN
    -- Fee comes from revenue_sources, not a hardcoded literal -- an admin can
    -- change the percent/min/max, or disable the fee entirely, with no
    -- redeploy. Missing/disabled config means no fee, same fail-safe
    -- philosophy as record_revenue's own enabled check.
    SELECT value, min_value, max_value INTO v_fee_pct, v_fee_min, v_fee_max
      FROM revenue_sources WHERE source = 'wallet_transfer' AND enabled = true;

    IF v_fee_pct IS NOT NULL THEN
      v_transfer_fee := ROUND(p_amount * v_fee_pct / 100, 2);
      v_transfer_fee := GREATEST(COALESCE(v_fee_min, 0), LEAST(v_transfer_fee, COALESCE(v_fee_max, v_transfer_fee)));
    END IF;

    IF v_from_wallet.wallet_balance < (p_amount + v_transfer_fee) THEN
      RETURN jsonb_build_object('success', false, 'error',
        'Insufficient balance -- need $' || (p_amount + v_transfer_fee) || ' (amount + $' || v_transfer_fee || ' transfer fee)');
    END IF;

    UPDATE wallets SET wallet_balance = wallet_balance - p_amount - v_transfer_fee, updated_at = now() WHERE id = v_from_wallet.id;
    UPDATE wallets SET wallet_balance = wallet_balance + p_amount, updated_at = now() WHERE id = v_to_wallet.id;

    INSERT INTO wallet_ledger (wallet_id, transaction_type, debit, credit, balance_before, balance_after, reference_id)
      VALUES (v_from_wallet.id, 'transfer_out', p_amount + v_transfer_fee, 0,
              v_from_wallet.wallet_balance, v_from_wallet.wallet_balance - p_amount - v_transfer_fee, v_to_wallet.id);
    INSERT INTO wallet_ledger (wallet_id, transaction_type, debit, credit, balance_before, balance_after, reference_id)
      VALUES (v_to_wallet.id, 'transfer_in', 0, p_amount,
              v_to_wallet.wallet_balance, v_to_wallet.wallet_balance + p_amount, v_from_wallet.id);

    IF v_transfer_fee > 0 THEN
      INSERT INTO wallet_transactions (wallet_id, type, amount, description, status, currency_code, metadata)
        VALUES (v_from_wallet.id, 'transfer_fee', -v_transfer_fee, 'Wallet transfer fee', 'completed', 'USD',
                jsonb_build_object('reference', v_reference));
    END IF;
  ELSE
    -- Non-USD: unchanged balance model (a real wallet_currencies row), fee-free.
    SELECT balance INTO v_sender_currency_balance
      FROM wallet_currencies WHERE wallet_id = v_from_wallet.id AND currency_code = p_currency FOR UPDATE;

    IF v_sender_currency_balance IS NULL OR v_sender_currency_balance < p_amount THEN
      RETURN jsonb_build_object('success', false, 'error', 'Insufficient balance');
    END IF;

    SELECT COALESCE(balance, 0) INTO v_receiver_currency_before
      FROM wallet_currencies WHERE wallet_id = p_to_wallet_id AND currency_code = p_currency FOR UPDATE;
    v_receiver_currency_before := COALESCE(v_receiver_currency_before, 0);

    UPDATE wallet_currencies
      SET balance = balance - p_amount, updated_at = now()
      WHERE wallet_id = v_from_wallet.id AND currency_code = p_currency;

    INSERT INTO wallet_currencies (wallet_id, currency_code, balance)
      VALUES (p_to_wallet_id, p_currency, p_amount)
      ON CONFLICT (wallet_id, currency_code)
      DO UPDATE SET balance = wallet_currencies.balance + EXCLUDED.balance, updated_at = now();

    INSERT INTO wallet_ledger (wallet_id, transaction_type, debit, credit, balance_before, balance_after, reference_id)
      VALUES (v_from_wallet.id, 'transfer_out', p_amount, 0,
              v_sender_currency_balance, v_sender_currency_balance - p_amount, v_to_wallet.id);
    INSERT INTO wallet_ledger (wallet_id, transaction_type, debit, credit, balance_before, balance_after, reference_id)
      VALUES (v_to_wallet.id, 'transfer_in', 0, p_amount,
              v_receiver_currency_before, v_receiver_currency_before + p_amount, v_from_wallet.id);
  END IF;

  INSERT INTO wallet_transactions (wallet_id, type, amount, description, status, currency_code, metadata)
    VALUES (v_from_wallet.id, 'transfer_out', -p_amount, COALESCE(p_note, 'Wallet transfer'), 'completed', p_currency,
            jsonb_build_object('to_wallet_id', p_to_wallet_id, 'reference', v_reference));
  INSERT INTO wallet_transactions (wallet_id, type, amount, description, status, currency_code, metadata)
    VALUES (p_to_wallet_id, 'transfer_in', p_amount, COALESCE(p_note, 'Wallet transfer'), 'completed', p_currency,
            jsonb_build_object('from_wallet_id', v_from_wallet.id, 'reference', v_reference));

  INSERT INTO p2p_transfers
    (sender_wallet_id, receiver_wallet_id, amount, currency_code, status, reference)
  VALUES
    (v_from_wallet.id, p_to_wallet_id, p_amount, p_currency, 'completed', v_reference)
  RETURNING id INTO v_transfer_id;

  IF v_transfer_fee > 0 THEN
    PERFORM record_revenue(
      p_source => 'wallet_transfer', p_user_id => v_from_wallet.user_id, p_reference_id => v_transfer_id,
      p_gross_amount => p_amount, p_revenue_amount => v_transfer_fee, p_currency => 'USD',
      p_payment_method => 'wallet', p_original_currency => 'USD', p_original_amount => p_amount,
      p_metadata => jsonb_build_object('to_wallet_id', p_to_wallet_id, 'reference', v_reference)
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'data', jsonb_build_object(
      'transfer_id', v_transfer_id,
      'reference',   v_reference,
      'amount',      p_amount,
      'fee',         v_transfer_fee,
      'currency',    p_currency
    )
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$function$;
