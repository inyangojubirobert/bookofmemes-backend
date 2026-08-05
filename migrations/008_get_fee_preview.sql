-- Adds get_fee_preview(source, amount, currency), a single source of truth
-- for fee math the client can call instead of reimplementing the clamp
-- formula in JS (WalletService.js's computeClampedFee, now removed). If the
-- formula in process_transfer ever changes, this is the only other place
-- that needs to change with it -- previously there were two copies that could
-- silently drift apart.
--
-- Deliberately currency-agnostic about *whether* a fee applies: it just
-- answers "what would this source charge for this amount," given whatever is
-- in revenue_sources right now. Business rules like "wallet_transfer is
-- USD-only" stay in the caller (process_transfer decides whether to charge at
-- all; MoneyTransfer.js decides whether to even ask for a preview) rather
-- than being hardcoded into a function meant to be reusable across sources.

CREATE OR REPLACE FUNCTION public.get_fee_preview(p_source text, p_amount numeric, p_currency text DEFAULT 'USD'::text)
 RETURNS jsonb
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
    RETURN jsonb_build_object('amount', p_amount, 'fee', 0, 'currency', p_currency, 'net_amount', p_amount);
  END IF;

  SELECT fee_type, value, min_value, max_value INTO v_fee_type, v_fee_value, v_fee_min, v_fee_max
    FROM revenue_sources WHERE source = p_source AND enabled = true;

  IF v_fee_type IN ('tiered', 'percentage') AND v_fee_value IS NOT NULL THEN
    v_fee := ROUND(p_amount * v_fee_value / 100, 2);
    v_fee := GREATEST(COALESCE(v_fee_min, 0), LEAST(v_fee, COALESCE(v_fee_max, v_fee)));
  ELSIF v_fee_type = 'fixed' AND v_fee_value IS NOT NULL THEN
    v_fee := v_fee_value;
  END IF;

  RETURN jsonb_build_object(
    'amount', p_amount,
    'fee', v_fee,
    'currency', p_currency,
    'net_amount', p_amount - v_fee
  );
END;
$function$;

REVOKE ALL ON FUNCTION get_fee_preview(text, numeric, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_fee_preview(text, numeric, text) TO authenticated;
