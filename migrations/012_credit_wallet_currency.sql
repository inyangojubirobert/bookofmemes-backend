-- credit_wallet_currency(p_wallet_id, p_currency, p_amount) is called by three
-- backend call sites for every non-USD credit (deposits.js's /verify handler,
-- server.js's Paystack webhook, walletApiRouter.js's money-transfer route) but
-- was never actually created in the database -- confirmed live via a direct
-- RPC call, which returns PGRST202 "Could not find the function". None of the
-- three call sites checked this call's error, so every non-USD credit has
-- been silently failing: the deposit/transfer gets marked 'completed' and a
-- wallet_transactions row gets logged, but wallet_currencies.balance was never
-- actually incremented -- money the user paid for (or was sent) never reached
-- their balance, with no error surfaced anywhere. This is the exact failure
-- class the USD path next to each of these calls was already fixed for
-- (migration 035) -- the non-USD path was just left calling a function that
-- doesn't exist.
--
-- (There's also a broken increment_wallet_balance(wallet_id_input,
-- currency_input, amount_input) already in the DB, unrelated to this call's
-- naming/signature -- it references a non-existent wallet_currencies.currency
-- column (the real column is currency_code) and has no insert-if-missing
-- fallback, so it would itself error on first use. Nothing calls it; leaving
-- it alone and creating the function the call sites actually name.)
CREATE OR REPLACE FUNCTION public.credit_wallet_currency(p_wallet_id uuid, p_currency text, p_amount numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN;
  END IF;

  UPDATE wallet_currencies
    SET balance = balance + p_amount, updated_at = now()
    WHERE wallet_id = p_wallet_id AND currency_code = p_currency;

  IF NOT FOUND THEN
    INSERT INTO wallet_currencies (wallet_id, currency_code, balance, is_primary)
      VALUES (p_wallet_id, p_currency, p_amount, false);
  END IF;
END;
$function$;

-- Backend-only (the server uses the service role key, which bypasses RLS
-- regardless) -- revoked from direct client roles so a client can't call this
-- to mint arbitrary currency balance for itself.
REVOKE ALL ON FUNCTION credit_wallet_currency(uuid, text, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION credit_wallet_currency(uuid, text, numeric) FROM anon, authenticated;
