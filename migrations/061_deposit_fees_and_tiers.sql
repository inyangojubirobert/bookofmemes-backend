-- 061: Fees and a ceiling for wallet-link deposits.
--
-- Wallet apps charge for receiving money, so a link deposit now carries a
-- deposit fee (a percentage with a minimum) on top of the exchange spread for
-- non-dollar currencies. Both are taken from what is credited and shown to the
-- buyer before they pay:
--
--   credited = package value in USD - spread (non-USD) - deposit fee
--
-- Packages are tiers from about $5 up to a ceiling (link_deposit_max_package_usd,
-- default $500); the standard ladder per currency is in
-- Backend/config/depositTiers.js. Fee and spread are recorded as revenue when
-- the agent confirms.
BEGIN;

ALTER TABLE public.market_settings
  ADD COLUMN IF NOT EXISTS link_deposit_fee_pct numeric NOT NULL DEFAULT 2 CHECK (link_deposit_fee_pct BETWEEN 0 AND 20),
  ADD COLUMN IF NOT EXISTS link_deposit_fee_min_usd numeric NOT NULL DEFAULT 0.3 CHECK (link_deposit_fee_min_usd >= 0),
  ADD COLUMN IF NOT EXISTS link_deposit_max_package_usd numeric NOT NULL DEFAULT 500 CHECK (link_deposit_max_package_usd > 0);

ALTER TABLE public.market_payments
  ADD COLUMN IF NOT EXISTS deposit_fee numeric,      -- USD kept as the deposit fee
  ADD COLUMN IF NOT EXISTS deposit_spread numeric;   -- USD kept as exchange spread

INSERT INTO public.revenue_sources (source, fee_type, category, enabled, description) VALUES
  ('marketplace_deposit_fee', 'percentage', 'marketplace', true,
   'Fee and exchange spread on international wallet-link deposits (market_settings.link_deposit_*)')
ON CONFLICT (source) DO NOTHING;

-- USD value of a package, and what is kept from it. Shared by the app's
-- preview (through the backend) and by the deposit itself, so they agree.
CREATE OR REPLACE FUNCTION public.market_link_deposit_quote(p_currency text, p_amount numeric)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s market_settings%ROWTYPE;
  v_mid numeric;
  v_gross numeric;
  v_spread numeric;
  v_fee numeric;
BEGIN
  SELECT * INTO s FROM market_settings WHERE id;
  v_mid := market_rate(p_currency);
  v_gross := ROUND(p_amount / v_mid, 2);
  v_spread := CASE WHEN p_currency = 'USD' THEN 0 ELSE ROUND(v_gross * s.link_deposit_spread_pct / 100, 2) END;
  v_fee := ROUND(GREATEST(v_gross * s.link_deposit_fee_pct / 100, s.link_deposit_fee_min_usd), 2);
  RETURN jsonb_build_object(
    'mid_rate', v_mid, 'gross_usd', v_gross, 'spread_usd', v_spread, 'fee_usd', v_fee,
    'credit_usd', v_gross - v_spread - v_fee,
    'over_ceiling', v_gross > s.link_deposit_max_package_usd);
END;
$$;
REVOKE ALL ON FUNCTION public.market_link_deposit_quote(text, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.market_link_deposit_quote(text, numeric) TO service_role;

CREATE OR REPLACE FUNCTION public.market_start_link_deposit(p_user_id uuid, p_link_id uuid)
RETURNS market_payments LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s market_settings%ROWTYPE;
  v_link market_deposit_links%ROWTYPE;
  v_q jsonb;
  v_credit numeric;
  v_agent uuid;
  v_code text;
  v_pay market_payments%ROWTYPE;
BEGIN
  SELECT * INTO s FROM market_settings WHERE id;
  SELECT * INTO v_link FROM market_deposit_links WHERE id = p_link_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'This deposit option is not available'; END IF;
  IF EXISTS (SELECT 1 FROM account_deletion_requests WHERE user_id = p_user_id AND status = 'pending') THEN
    RAISE EXCEPTION 'This account is being deleted';
  END IF;
  PERFORM 1 FROM profiles WHERE id = p_user_id FOR UPDATE;  -- one start at a time per user

  IF (SELECT count(*) FROM market_payments WHERE user_id = p_user_id AND method = 'wallet_link'
        AND status IN ('pending', 'submitted') AND expires_at > now()) >= s.link_deposit_max_open THEN
    RAISE EXCEPTION 'You have % deposits waiting. Finish or cancel one first.', s.link_deposit_max_open;
  END IF;

  v_q := market_link_deposit_quote(v_link.pay_currency, v_link.pay_amount);
  IF (v_q ->> 'over_ceiling')::boolean THEN
    RAISE EXCEPTION 'This package is above the % deposit limit', market_money(s.link_deposit_max_package_usd, 'USD');
  END IF;
  v_credit := (v_q ->> 'credit_usd')::numeric;
  IF v_credit < s.min_payment_usd THEN RAISE EXCEPTION 'This deposit option is below the minimum'; END IF;
  IF COALESCE((SELECT sum(credit_amount) FROM market_payments WHERE user_id = p_user_id AND method = 'wallet_link'
        AND status IN ('pending', 'submitted', 'paid') AND created_at > now() - interval '24 hours'), 0) + v_credit
     > s.link_deposit_daily_cap_usd THEN
    RAISE EXCEPTION 'Link deposits are limited to % a day', market_money(s.link_deposit_daily_cap_usd, 'USD');
  END IF;

  SELECT a.user_id INTO v_agent FROM market_deposit_agents a
   WHERE a.is_active AND a.user_id <> p_user_id
   ORDER BY (SELECT count(*) FROM market_payments p WHERE p.agent_id = a.user_id AND p.method = 'wallet_link' AND p.status = 'submitted'), random()
   LIMIT 1;
  IF v_agent IS NULL THEN RAISE EXCEPTION 'No deposit agent is available right now. Please try again later.'; END IF;

  LOOP
    v_code := 'BOM-' || upper(substr(md5(random()::text || clock_timestamp()::text || p_user_id::text), 1, 6));
    EXIT WHEN NOT EXISTS (SELECT 1 FROM market_payments WHERE deposit_code = v_code);
  END LOOP;

  INSERT INTO market_payments (user_id, method, credit_currency, credit_amount, pay_currency, amount_due, fx_mid_rate,
                               purpose, expires_at, deposit_link_id, deposit_code, deposit_provider, agent_id,
                               deposit_fee, deposit_spread)
  VALUES (p_user_id, 'wallet_link', 'USD', v_credit, v_link.pay_currency, v_link.pay_amount, (v_q ->> 'mid_rate')::numeric,
          jsonb_build_object('action', 'deposit'), now() + make_interval(hours => s.link_deposit_hours),
          v_link.id, v_code, v_link.provider, v_agent,
          (v_q ->> 'fee_usd')::numeric, (v_q ->> 'spread_usd')::numeric)
  RETURNING * INTO v_pay;
  RETURN v_pay;
END;
$$;

CREATE OR REPLACE FUNCTION public.market_review_link_deposit(
  p_agent_id uuid, p_payment_id uuid, p_confirm boolean, p_amount_received numeric, p_note text
) RETURNS market_payments LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_pay market_payments%ROWTYPE;
BEGIN
  IF NOT is_deposit_agent(p_agent_id) THEN RAISE EXCEPTION 'Deposit agents only'; END IF;
  SELECT * INTO v_pay FROM market_payments WHERE id = p_payment_id AND method = 'wallet_link' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Deposit not found'; END IF;
  IF v_pay.agent_id IS DISTINCT FROM p_agent_id AND NOT is_app_admin(p_agent_id) THEN RAISE EXCEPTION 'This deposit is assigned to another agent'; END IF;
  IF v_pay.user_id = p_agent_id THEN RAISE EXCEPTION 'You cannot confirm your own deposit'; END IF;
  IF v_pay.status <> 'submitted' THEN RAISE EXCEPTION 'This deposit is %', v_pay.status; END IF;

  UPDATE market_payments SET reviewed_by = p_agent_id, reviewed_at = now(), review_note = NULLIF(btrim(p_note), '')
    WHERE id = p_payment_id;

  IF p_confirm THEN
    UPDATE market_payments SET status = 'pending' WHERE id = p_payment_id;
    v_pay := market_confirm_payment(p_payment_id, p_amount_received,
      jsonb_build_object('agent', p_agent_id, 'payer_name', v_pay.payer_name, 'tx_ref', v_pay.payer_tx_ref, 'provider', v_pay.deposit_provider));
    IF COALESCE(v_pay.deposit_fee, 0) + COALESCE(v_pay.deposit_spread, 0) > 0 THEN
      PERFORM record_revenue(
        p_source => 'marketplace_deposit_fee', p_user_id => v_pay.user_id, p_reference_id => v_pay.id,
        p_gross_amount => v_pay.credit_amount + COALESCE(v_pay.deposit_fee, 0) + COALESCE(v_pay.deposit_spread, 0),
        p_revenue_amount => COALESCE(v_pay.deposit_fee, 0) + COALESCE(v_pay.deposit_spread, 0), p_currency => 'USD',
        p_payment_method => 'wallet_link', p_original_currency => v_pay.pay_currency, p_original_amount => v_pay.amount_due,
        p_metadata => jsonb_build_object('fee', v_pay.deposit_fee, 'spread', v_pay.deposit_spread, 'provider', v_pay.deposit_provider));
    END IF;
    INSERT INTO notifications (user_id, type, title, body, reference_id)
      VALUES (v_pay.user_id, 'deposit_confirmed', 'Deposit confirmed',
              market_money(v_pay.credit_amount, 'USD') || ' was added to your marketplace funds (' || v_pay.deposit_code || ').', v_pay.id);
  ELSE
    IF length(COALESCE(btrim(p_note), '')) < 5 THEN RAISE EXCEPTION 'Tell the buyer why'; END IF;
    UPDATE market_payments SET status = 'failed', provider_data = jsonb_build_object('reason', 'rejected by agent', 'note', btrim(p_note))
      WHERE id = p_payment_id RETURNING * INTO v_pay;
    INSERT INTO notifications (user_id, type, title, body, reference_id)
      VALUES (v_pay.user_id, 'deposit_rejected', 'Deposit not confirmed', v_pay.deposit_code || ': ' || btrim(p_note), v_pay.id);
  END IF;
  RETURN v_pay;
END;
$$;

REVOKE ALL ON FUNCTION public.market_start_link_deposit(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.market_review_link_deposit(uuid, uuid, boolean, numeric, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.market_start_link_deposit(uuid, uuid), public.market_review_link_deposit(uuid, uuid, boolean, numeric, text) TO service_role;

COMMIT;
