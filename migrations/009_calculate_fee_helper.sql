-- Extracts the fee formula (ROUND -> GREATEST/LEAST clamp against
-- revenue_sources) into calculate_fee(source, amount), a single shared
-- helper. process_transfer and get_fee_preview both had their own copy of
-- this exact math -- fixing that duplication was the whole point of
-- get_fee_preview existing, but it recreated the same problem one level
-- down. Now both call the same function, so there's exactly one place the
-- formula lives (future pricing changes -- VIP tiers, promotions, different
-- rounding -- only need to change here).
--
-- calculate_fee is an internal helper, not a public RPC: it returns a bare
-- number with no context (currency, whether the source even applies to this
-- transaction type), so the client-facing surface stays get_fee_preview,
-- which wraps it with that context. Locked down the same way record_revenue
-- is -- callable via PERFORM/SELECT from other SECURITY DEFINER functions,
-- not directly over the REST API.

CREATE OR REPLACE FUNCTION public.calculate_fee(p_source text, p_amount numeric)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_fee_type text;
  v_fee_value NUMERIC;
  v_fee_min NUMERIC;
  v_fee_max NUMERIC;
  v_fee NUMERIC := 0;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN 0;
  END IF;

  SELECT fee_type, value, min_value, max_value INTO v_fee_type, v_fee_value, v_fee_min, v_fee_max
    FROM revenue_sources WHERE source = p_source AND enabled = true;

  IF v_fee_type IN ('tiered', 'percentage') AND v_fee_value IS NOT NULL THEN
    v_fee := ROUND(p_amount * v_fee_value / 100, 2);
    v_fee := GREATEST(COALESCE(v_fee_min, 0), LEAST(v_fee, COALESCE(v_fee_max, v_fee)));
  ELSIF v_fee_type = 'fixed' AND v_fee_value IS NOT NULL THEN
    v_fee := v_fee_value;
  END IF;

  RETURN v_fee;
END;
$function$;

REVOKE ALL ON FUNCTION calculate_fee(text, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION calculate_fee(text, numeric) FROM anon, authenticated;

-- get_fee_preview becomes a thin wrapper: context (currency, net_amount)
-- around calculate_fee's bare number.
CREATE OR REPLACE FUNCTION public.get_fee_preview(p_source text, p_amount numeric, p_currency text DEFAULT 'USD'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_fee NUMERIC;
BEGIN
  v_fee := calculate_fee(p_source, p_amount);
  RETURN jsonb_build_object(
    'amount', p_amount,
    'fee', v_fee,
    'currency', p_currency,
    'net_amount', p_amount - v_fee
  );
END;
$function$;

-- process_transfer: same signature as migration 007, its fee block now just
-- calls calculate_fee instead of duplicating the SELECT/ROUND/clamp inline.
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
    v_transfer_fee := calculate_fee('wallet_transfer', p_amount);

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
