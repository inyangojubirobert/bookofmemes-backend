-- Fixes process_transfer: it checked/debited wallet_currencies.balance for
-- EVERY currency including USD, but USD balance lives exclusively in
-- wallets.wallet_balance (every other money-moving function in this app --
-- convert_currency_to_usd, accept_marketplace_bid, create_marketplace_listing,
-- agent_confirm_cashout_paid -- already treats it that way). wallet_currencies
-- can hold a same-named USD row (confirmed live: balance 0.00, never synced),
-- so every USD transfer failed "Insufficient balance" regardless of the
-- sender's real balance. Non-USD transfers (a real wallet_currencies balance)
-- worked, but neither path ever wrote to wallet_ledger/wallet_transactions,
-- so even a successful transfer was invisible in the transaction history.
--
-- Old 4-arg signature confirmed via PostgREST's OpenAPI spec:
-- process_transfer(p_to_wallet_id uuid, p_amount numeric, p_currency text DEFAULT 'USD', p_note text DEFAULT NULL)
-- returning jsonb. DROP first since this replacement's behavior differs
-- enough from the original that leaving any doubt about a stale duplicate
-- overload isn't worth it (see 037_drop_stale_create_listing_overload.sql).
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
    IF v_from_wallet.wallet_balance < p_amount THEN
      RETURN jsonb_build_object('success', false, 'error', 'Insufficient balance');
    END IF;

    UPDATE wallets SET wallet_balance = wallet_balance - p_amount, updated_at = now() WHERE id = v_from_wallet.id;
    UPDATE wallets SET wallet_balance = wallet_balance + p_amount, updated_at = now() WHERE id = v_to_wallet.id;

    INSERT INTO wallet_ledger (wallet_id, transaction_type, debit, credit, balance_before, balance_after, reference_id)
      VALUES (v_from_wallet.id, 'transfer_out', p_amount, 0,
              v_from_wallet.wallet_balance, v_from_wallet.wallet_balance - p_amount, v_to_wallet.id);
    INSERT INTO wallet_ledger (wallet_id, transaction_type, debit, credit, balance_before, balance_after, reference_id)
      VALUES (v_to_wallet.id, 'transfer_in', 0, p_amount,
              v_to_wallet.wallet_balance, v_to_wallet.wallet_balance + p_amount, v_from_wallet.id);
  ELSE
    -- Non-USD: unchanged balance model (a real wallet_currencies row), just
    -- now also produces wallet_ledger/wallet_transactions entries.
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

  RETURN jsonb_build_object(
    'success', true,
    'data', jsonb_build_object(
      'transfer_id', v_transfer_id,
      'reference',   v_reference,
      'amount',      p_amount,
      'currency',    p_currency
    )
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$function$;
