-- 062: Bigger deposit ladder, open-amount links, admin check on large
-- deposits, and a public activity record for every listing.
--
-- Deposits only fund the buyer's marketplace funds; they never limit a bid.
-- A buyer can add as many deposits as they need, of any size up to the
-- ceiling, and combine them: the backend's deposit planner picks the packages
-- that cover a shortfall (Backend/config/depositTiers.js has the ladder).
--
--   * Ceiling per package raised to $50,000, daily total to $50,000, up to 10
--     deposits waiting at once (so a planned combination fits).
--   * Open-amount links: a wallet link where the buyer types the amount
--     (pay_amount NULL, min_amount..max_amount). Covers any random amount.
--   * Deposits of $1,000 or more (link_deposit_large_usd) must be confirmed by
--     an admin, not only an agent.
--   * market_listing_activity(listing): what anyone may see about a listing:
--     when it ends, the owner's decision deadline, how many bids, the top bid,
--     whether it sold (to whom, for how much), and how many bids were refunded.
BEGIN;

-- ── Limits ──────────────────────────────────────────────────────────────────
ALTER TABLE public.market_settings
  ADD COLUMN IF NOT EXISTS link_deposit_large_usd numeric NOT NULL DEFAULT 1000;
UPDATE public.market_settings SET link_deposit_max_package_usd = 50000 WHERE link_deposit_max_package_usd = 500;
UPDATE public.market_settings SET link_deposit_daily_cap_usd = 50000 WHERE link_deposit_daily_cap_usd = 500;
UPDATE public.market_settings SET link_deposit_max_open = 10 WHERE link_deposit_max_open = 3;
ALTER TABLE public.market_settings ALTER COLUMN link_deposit_max_package_usd SET DEFAULT 50000;
ALTER TABLE public.market_settings ALTER COLUMN link_deposit_daily_cap_usd SET DEFAULT 50000;
ALTER TABLE public.market_settings ALTER COLUMN link_deposit_max_open SET DEFAULT 10;

-- ── Open-amount links ───────────────────────────────────────────────────────
ALTER TABLE public.market_deposit_links ALTER COLUMN pay_amount DROP NOT NULL;
ALTER TABLE public.market_deposit_links
  ADD COLUMN IF NOT EXISTS min_amount numeric CHECK (min_amount > 0),
  ADD COLUMN IF NOT EXISTS max_amount numeric CHECK (max_amount > 0);
ALTER TABLE public.market_deposit_links DROP CONSTRAINT IF EXISTS market_deposit_links_amount_shape;
ALTER TABLE public.market_deposit_links ADD CONSTRAINT market_deposit_links_amount_shape CHECK (
  (pay_amount IS NOT NULL AND min_amount IS NULL AND max_amount IS NULL)
  OR (pay_amount IS NULL AND min_amount IS NOT NULL AND max_amount IS NOT NULL AND min_amount < max_amount));

-- ── Start a deposit (fixed package, or an amount on an open link) ───────────
DROP FUNCTION IF EXISTS public.market_start_link_deposit(uuid, uuid);
CREATE OR REPLACE FUNCTION public.market_start_link_deposit(p_user_id uuid, p_link_id uuid, p_amount numeric DEFAULT NULL)
RETURNS market_payments LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s market_settings%ROWTYPE;
  v_link market_deposit_links%ROWTYPE;
  v_amount numeric;
  v_q jsonb;
  v_credit numeric;
  v_agent uuid;
  v_code text;
  v_pay market_payments%ROWTYPE;
BEGIN
  SELECT * INTO s FROM market_settings WHERE id;
  SELECT * INTO v_link FROM market_deposit_links WHERE id = p_link_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'This deposit option is not available'; END IF;
  IF v_link.pay_amount IS NOT NULL THEN
    v_amount := v_link.pay_amount;
  ELSE
    v_amount := ROUND(p_amount, 2);
    IF v_amount IS NULL OR v_amount < v_link.min_amount OR v_amount > v_link.max_amount THEN
      RAISE EXCEPTION 'Enter an amount from % to %', market_money(v_link.min_amount, v_link.pay_currency), market_money(v_link.max_amount, v_link.pay_currency);
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM account_deletion_requests WHERE user_id = p_user_id AND status = 'pending') THEN
    RAISE EXCEPTION 'This account is being deleted';
  END IF;
  PERFORM 1 FROM profiles WHERE id = p_user_id FOR UPDATE;

  IF (SELECT count(*) FROM market_payments WHERE user_id = p_user_id AND method = 'wallet_link'
        AND status IN ('pending', 'submitted') AND expires_at > now()) >= s.link_deposit_max_open THEN
    RAISE EXCEPTION 'You have % deposits waiting. Finish or cancel one first.', s.link_deposit_max_open;
  END IF;

  v_q := market_link_deposit_quote(v_link.pay_currency, v_amount);
  IF (v_q ->> 'over_ceiling')::boolean THEN
    RAISE EXCEPTION 'One deposit can be at most %. Split it into more than one.', market_money(s.link_deposit_max_package_usd, 'USD');
  END IF;
  v_credit := (v_q ->> 'credit_usd')::numeric;
  IF v_credit < s.min_payment_usd THEN RAISE EXCEPTION 'This amount is below the minimum after fees'; END IF;
  IF COALESCE((SELECT sum(credit_amount) FROM market_payments WHERE user_id = p_user_id AND method = 'wallet_link'
        AND status IN ('pending', 'submitted', 'paid') AND created_at > now() - interval '24 hours'), 0) + v_credit
     > s.link_deposit_daily_cap_usd THEN
    RAISE EXCEPTION 'Link deposits are limited to % a day', market_money(s.link_deposit_daily_cap_usd, 'USD');
  END IF;

  SELECT a.user_id INTO v_agent FROM market_deposit_agents a
   WHERE a.is_active AND a.user_id <> p_user_id
     -- Large deposits go to an agent who is also an admin, when there is one.
     AND (v_credit < s.link_deposit_large_usd OR is_app_admin(a.user_id)
          OR NOT EXISTS (SELECT 1 FROM market_deposit_agents x WHERE x.is_active AND x.user_id <> p_user_id AND is_app_admin(x.user_id)))
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
  VALUES (p_user_id, 'wallet_link', 'USD', v_credit, v_link.pay_currency, v_amount, (v_q ->> 'mid_rate')::numeric,
          jsonb_build_object('action', 'deposit'), now() + make_interval(hours => s.link_deposit_hours),
          v_link.id, v_code, v_link.provider, v_agent,
          (v_q ->> 'fee_usd')::numeric, (v_q ->> 'spread_usd')::numeric)
  RETURNING * INTO v_pay;
  RETURN v_pay;
END;
$$;
REVOKE ALL ON FUNCTION public.market_start_link_deposit(uuid, uuid, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.market_start_link_deposit(uuid, uuid, numeric) TO service_role;

-- ── Large deposits: an admin confirms ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.market_large_deposit_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_large numeric;
BEGIN
  IF NEW.method = 'wallet_link' AND NEW.status = 'paid' AND OLD.status IS DISTINCT FROM 'paid' THEN
    SELECT link_deposit_large_usd INTO v_large FROM market_settings WHERE id;
    IF NEW.credit_amount >= v_large AND NOT is_app_admin(NEW.reviewed_by) THEN
      RAISE EXCEPTION 'Deposits of % or more must be confirmed by an admin', market_money(v_large, 'USD');
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS market_large_deposit_guard ON public.market_payments;
CREATE TRIGGER market_large_deposit_guard BEFORE UPDATE OF status ON public.market_payments
  FOR EACH ROW EXECUTE FUNCTION public.market_large_deposit_guard();

-- ── Public listing activity ─────────────────────────────────────────────────
-- Everything here is safe to show anyone: no bidder identities, only counts
-- and the top amount; the buyer's username once a sale has happened
-- (ownership history is already public).
CREATE OR REPLACE FUNCTION public.market_listing_activity(p_listing_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'status', l.status,
    'listed_at', l.created_at,
    'expires_at', l.expires_at,
    'decision_deadline', l.decision_deadline,
    'currency', l.listing_currency,
    'active_bids', (SELECT count(*) FROM marketplace_bids b WHERE b.listing_id = l.id AND b.status = 'active'),
    'bidders', (SELECT count(DISTINCT bidder_id) FROM marketplace_bids b WHERE b.listing_id = l.id),
    'top_bid', (SELECT max(amount) FROM marketplace_bids b WHERE b.listing_id = l.id AND b.status IN ('active', 'accepted')),
    'refunded_bids', (SELECT count(*) FROM marketplace_bids b WHERE b.listing_id = l.id
                        AND b.funding = 'cash' AND b.status IN ('rejected', 'expired', 'withdrawn', 'superseded')),
    'sale', (SELECT jsonb_build_object('price', h.sale_price, 'currency', h.settle_currency, 'at', h.transferred_at,
                                       'buyer', p.username, 'accepted_by_owner', b.decided_at IS NOT NULL AND b.decided_at < COALESCE(l.decision_deadline, 'infinity'))
             FROM marketplace_ownership_history h
             LEFT JOIN profiles p ON p.id = h.to_user_id
             LEFT JOIN marketplace_bids b ON b.id = h.bid_id
             WHERE h.listing_id = l.id ORDER BY h.transferred_at DESC LIMIT 1))
  FROM marketplace_listings l WHERE l.id = p_listing_id;
$$;
GRANT EXECUTE ON FUNCTION public.market_listing_activity(uuid) TO anon, authenticated;

COMMIT;
