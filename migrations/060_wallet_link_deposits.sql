-- 060: International deposits by wallet payment link, confirmed by a deposit agent.
--
-- For buyers who can't or won't use Paystack (naira) or USDT: Book of Memes
-- publishes fixed deposit packages, each a payment link from a regulated
-- wallet app, in the 10 most-traded currencies (USD, EUR, JPY, GBP, CNY, AUD,
-- CAD, CHF, HKD, SGD). The links have no API, so a person confirms each one:
--
--   1. The buyer picks a package. The server creates a pending deposit with a
--      unique code (BOM-XXXXXX) and assigns a verified deposit agent.
--   2. The buyer pays through the link, then enters the name on their wallet
--      account and the wallet's transaction ID (status 'submitted'), and can
--      message the agent on WhatsApp with the code.
--   3. The agent checks the payment IN THE WALLET APP'S OWN RECORDS (never a
--      screenshot) and confirms or rejects in Book of Memes. Only then are the
--      buyer's marketplace funds credited (in USD, at the day's rate less a
--      small spread), ready for bids and Buy Now.
--
-- Safeguards: an agent can't confirm their own deposit; one wallet
-- transaction ID can be claimed once; a few open deposits per buyer and a
-- daily cap; every decision is recorded with who made it. Refunds of these
-- funds can't go back automatically, so they appear in the admin withdrawal
-- queue as a manual "send back via the wallet app" task.
BEGIN;

-- ── Settings ────────────────────────────────────────────────────────────────
ALTER TABLE public.market_settings
  ADD COLUMN IF NOT EXISTS link_deposit_spread_pct numeric NOT NULL DEFAULT 1.5,
  ADD COLUMN IF NOT EXISTS link_deposit_max_open integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS link_deposit_daily_cap_usd numeric NOT NULL DEFAULT 500,
  ADD COLUMN IF NOT EXISTS link_deposit_hours integer NOT NULL DEFAULT 48;

-- Rates for the 10 deposit currencies. Listing in the new ones stays off
-- (is_enabled = false); the daily rate job fetches every row in this table.
INSERT INTO public.marketplace_currencies (code, name, symbol, settlement_currency, payment_methods, is_enabled, sort_order) VALUES
  ('JPY', 'Japanese yen',      '¥',   'USD', '{usdt}', false, 60),
  ('CNY', 'Chinese yuan',      'CN¥', 'USD', '{usdt}', false, 70),
  ('AUD', 'Australian dollar', 'A$',  'USD', '{usdt}', false, 80),
  ('CAD', 'Canadian dollar',   'C$',  'USD', '{usdt}', false, 90),
  ('CHF', 'Swiss franc',       'CHF ', 'USD', '{usdt}', false, 100),
  ('HKD', 'Hong Kong dollar',  'HK$', 'USD', '{usdt}', false, 110),
  ('SGD', 'Singapore dollar',  'S$',  'USD', '{usdt}', false, 120)
ON CONFLICT (code) DO NOTHING;

-- ── Deposit agents (verified people who confirm link deposits) ──────────────
-- Added by an admin. Their name and WhatsApp number are shown to the buyer
-- they are assigned to.
CREATE TABLE IF NOT EXISTS public.market_deposit_agents (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 2 AND 60),
  whatsapp text NOT NULL CHECK (whatsapp ~ '^\+[1-9][0-9]{7,14}$'),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.market_deposit_agents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.market_deposit_agents FROM anon, authenticated;
GRANT ALL ON public.market_deposit_agents TO service_role;

CREATE OR REPLACE FUNCTION public.is_deposit_agent(p_user_id uuid DEFAULT auth.uid())
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM market_deposit_agents WHERE user_id = p_user_id AND is_active);
$$;
GRANT EXECUTE ON FUNCTION public.is_deposit_agent(uuid) TO authenticated;

-- ── Deposit packages (one payment link each) ────────────────────────────────
CREATE TABLE IF NOT EXISTS public.market_deposit_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (length(provider) BETWEEN 2 AND 60),   -- the wallet app's name
  pay_currency text NOT NULL CHECK (pay_currency IN ('USD','EUR','JPY','GBP','CNY','AUD','CAD','CHF','HKD','SGD')),
  pay_amount numeric NOT NULL CHECK (pay_amount > 0),
  url text NOT NULL CHECK (url ~ '^https://[^\s]+$' AND length(url) <= 2048),
  instructions text CHECK (length(instructions) <= 500),
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.market_deposit_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS market_deposit_links_read ON public.market_deposit_links;
CREATE POLICY market_deposit_links_read ON public.market_deposit_links FOR SELECT TO authenticated USING (is_active);
REVOKE INSERT, UPDATE, DELETE ON public.market_deposit_links FROM anon, authenticated;
GRANT ALL ON public.market_deposit_links TO service_role;

-- ── market_payments: a third method ────────────────────────────────────────
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.market_payments'::regclass AND contype = 'c'
              AND (pg_get_constraintdef(oid) ILIKE '%(method = ANY%'
                   OR pg_get_constraintdef(oid) ILIKE '%(pay_currency = ANY%'
                   OR pg_get_constraintdef(oid) ILIKE '%(status = ANY%') LOOP
    EXECUTE format('ALTER TABLE public.market_payments DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;
ALTER TABLE public.market_payments
  ADD CONSTRAINT market_payments_method_check CHECK (method IN ('paystack', 'usdt', 'wallet_link')),
  ADD CONSTRAINT market_payments_pay_currency_check CHECK (pay_currency IN ('NGN','USDT','USD','EUR','JPY','GBP','CNY','AUD','CAD','CHF','HKD','SGD')),
  ADD CONSTRAINT market_payments_status_check CHECK (status IN ('pending', 'submitted', 'paid', 'failed'));

ALTER TABLE public.market_payments
  ADD COLUMN IF NOT EXISTS deposit_link_id uuid REFERENCES public.market_deposit_links(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS deposit_code text,
  ADD COLUMN IF NOT EXISTS deposit_provider text,
  ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS payer_name text,
  ADD COLUMN IF NOT EXISTS payer_tx_ref text,
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS review_note text;
CREATE UNIQUE INDEX IF NOT EXISTS market_payments_deposit_code_unique ON public.market_payments (deposit_code) WHERE deposit_code IS NOT NULL;
-- One wallet transaction can be claimed once (per wallet app).
CREATE UNIQUE INDEX IF NOT EXISTS market_payments_wallet_tx_unique
  ON public.market_payments (deposit_provider, lower(payer_tx_ref))
  WHERE method = 'wallet_link' AND payer_tx_ref IS NOT NULL AND status IN ('submitted', 'paid');
CREATE INDEX IF NOT EXISTS market_payments_agent_queue_idx ON public.market_payments (agent_id, status) WHERE method = 'wallet_link';

-- Agents see the deposits assigned to them (the buyer already sees their own).
DROP POLICY IF EXISTS agent_rows ON public.market_payments;
CREATE POLICY agent_rows ON public.market_payments FOR SELECT USING (method = 'wallet_link' AND agent_id = auth.uid() AND is_deposit_agent());

-- ── 1. Start a deposit ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.market_start_link_deposit(p_user_id uuid, p_link_id uuid)
RETURNS market_payments LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s market_settings%ROWTYPE;
  v_link market_deposit_links%ROWTYPE;
  v_mid numeric;
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

  -- USD credited: the link's amount at today's mid rate, less the spread.
  v_mid := market_rate(v_link.pay_currency);
  v_credit := ROUND(v_link.pay_amount / v_mid * (1 - CASE WHEN v_link.pay_currency = 'USD' THEN 0 ELSE s.link_deposit_spread_pct END / 100), 2);
  IF v_credit < s.min_payment_usd THEN RAISE EXCEPTION 'This deposit option is below the minimum'; END IF;
  IF COALESCE((SELECT sum(credit_amount) FROM market_payments WHERE user_id = p_user_id AND method = 'wallet_link'
        AND status IN ('pending', 'submitted', 'paid') AND created_at > now() - interval '24 hours'), 0) + v_credit
     > s.link_deposit_daily_cap_usd THEN
    RAISE EXCEPTION 'Link deposits are limited to % a day', market_money(s.link_deposit_daily_cap_usd, 'USD');
  END IF;

  -- The active agent (not the buyer) with the fewest deposits waiting.
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
                               purpose, expires_at, deposit_link_id, deposit_code, deposit_provider, agent_id)
  VALUES (p_user_id, 'wallet_link', 'USD', v_credit, v_link.pay_currency, v_link.pay_amount, v_mid,
          jsonb_build_object('action', 'deposit'), now() + make_interval(hours => s.link_deposit_hours),
          v_link.id, v_code, v_link.provider, v_agent)
  RETURNING * INTO v_pay;
  RETURN v_pay;
END;
$$;

-- ── 2. Buyer says they've paid ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.market_submit_link_deposit(p_user_id uuid, p_payment_id uuid, p_payer_name text, p_tx_ref text)
RETURNS market_payments LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_pay market_payments%ROWTYPE;
BEGIN
  p_payer_name := btrim(p_payer_name); p_tx_ref := btrim(p_tx_ref);
  IF length(COALESCE(p_payer_name, '')) NOT BETWEEN 2 AND 80 THEN RAISE EXCEPTION 'Enter the name on your wallet account'; END IF;
  IF length(COALESCE(p_tx_ref, '')) NOT BETWEEN 4 AND 120 THEN RAISE EXCEPTION 'Enter the transaction ID from your wallet app'; END IF;
  SELECT * INTO v_pay FROM market_payments WHERE id = p_payment_id AND user_id = p_user_id AND method = 'wallet_link' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Deposit not found'; END IF;
  IF v_pay.status <> 'pending' THEN RAISE EXCEPTION 'This deposit is already %', v_pay.status; END IF;
  IF v_pay.expires_at <= now() THEN RAISE EXCEPTION 'This deposit has expired. Start a new one.'; END IF;
  BEGIN
    UPDATE market_payments SET status = 'submitted', submitted_at = now(), payer_name = p_payer_name, payer_tx_ref = p_tx_ref
      WHERE id = p_payment_id RETURNING * INTO v_pay;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'That transaction ID has already been used for a deposit';
  END;
  INSERT INTO notifications (user_id, type, title, body, reference_id)
    VALUES (v_pay.agent_id, 'deposit_to_confirm', 'Deposit to confirm',
            v_pay.deposit_code || ': ' || market_money(v_pay.amount_due, v_pay.pay_currency) || ' via ' || v_pay.deposit_provider || ' from ' || p_payer_name, v_pay.id);
  RETURN v_pay;
END;
$$;

CREATE OR REPLACE FUNCTION public.market_cancel_link_deposit(p_user_id uuid, p_payment_id uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE market_payments SET status = 'failed', provider_data = jsonb_build_object('reason', 'cancelled by buyer')
   WHERE id = p_payment_id AND user_id = p_user_id AND method = 'wallet_link' AND status = 'pending';
$$;

-- ── 3. Agent confirms or rejects ────────────────────────────────────────────
-- p_amount_received is what the wallet app shows arrived, in the link's
-- currency. Less than the package amount can't be confirmed: reject it and
-- the agent sorts the money out with the buyer directly.
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
    -- market_confirm_payment only accepts 'pending'; this agent's check is the verification.
    UPDATE market_payments SET status = 'pending' WHERE id = p_payment_id;
    v_pay := market_confirm_payment(p_payment_id, p_amount_received,
      jsonb_build_object('agent', p_agent_id, 'payer_name', v_pay.payer_name, 'tx_ref', v_pay.payer_tx_ref, 'provider', v_pay.deposit_provider));
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

-- Unsubmitted deposits expire (submitted ones wait for the agent).
CREATE OR REPLACE FUNCTION public.market_expire_link_deposits()
RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH x AS (
    UPDATE market_payments SET status = 'failed', provider_data = jsonb_build_object('reason', 'expired')
     WHERE method = 'wallet_link' AND status = 'pending' AND expires_at <= now() RETURNING 1)
  SELECT count(*)::int FROM x;
$$;

-- Refund sources now also say how a link deposit was paid.
DROP FUNCTION IF EXISTS public.market_withdrawal_sources(uuid);
CREATE FUNCTION public.market_withdrawal_sources(p_withdrawal_id uuid)
RETURNS TABLE (payment_id uuid, method text, currency text, amount numeric, paystack_reference text, fx_rate numeric,
               usdt_network text, usdt_sender text, pay_currency text, fx_mid_rate numeric,
               deposit_provider text, deposit_code text, payer_name text, payer_tx_ref text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.id, p.method, l.currency, SUM(a.amount), p.paystack_reference, p.fx_rate, p.usdt_network, p.usdt_sender,
         p.pay_currency, p.fx_mid_rate, p.deposit_provider, p.deposit_code, p.payer_name, p.payer_tx_ref
  FROM market_lot_allocations a
  JOIN market_fund_lots l ON l.id = a.lot_id
  JOIN market_payments p ON p.id = l.payment_id
  WHERE a.withdrawal_id = p_withdrawal_id AND a.purpose = 'withdrawal' AND NOT a.released
  GROUP BY p.id, p.method, l.currency, p.paystack_reference, p.fx_rate, p.usdt_network, p.usdt_sender,
           p.pay_currency, p.fx_mid_rate, p.deposit_provider, p.deposit_code, p.payer_name, p.payer_tx_ref;
$$;

REVOKE ALL ON FUNCTION public.market_start_link_deposit(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.market_submit_link_deposit(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.market_cancel_link_deposit(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.market_review_link_deposit(uuid, uuid, boolean, numeric, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.market_expire_link_deposits() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.market_withdrawal_sources(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.market_start_link_deposit(uuid, uuid), public.market_submit_link_deposit(uuid, uuid, text, text),
  public.market_cancel_link_deposit(uuid, uuid), public.market_review_link_deposit(uuid, uuid, boolean, numeric, text),
  public.market_expire_link_deposits(), public.market_withdrawal_sources(uuid) TO service_role;

COMMIT;
