-- 057: Marketplace currencies (One Dream's rule) on top of 055.
--
-- Listings are priced in US dollars unless the seller picks another currency.
-- NGN listings are paid and settled in naira through Paystack; every other
-- currency settles in US dollars (USD listings: Paystack or USDT; GBP/EUR/GHS:
-- USDT, converted once at the bid at a recorded rate). Every balance, payment,
-- earning, withdrawal and ledger row now carries its currency (USD or NGN).
--
-- 055 created the money tables in dollars only. They hold no data yet, so
-- this migration rebuilds them in the per-currency shape. It refuses to run
-- if any marketplace payment, earning or withdrawal already exists.
--
-- Run after 055 and 056. Safe to re-run.

BEGIN;

-- ── Upgrade guard: only while no marketplace money exists ──────────────────
DO $$
BEGIN
  IF to_regclass('public.market_payments') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'market_payments' AND column_name = 'amount_usd') THEN
    IF EXISTS (SELECT 1 FROM public.market_payments) OR EXISTS (SELECT 1 FROM public.market_earnings)
       OR EXISTS (SELECT 1 FROM public.market_withdrawals) THEN
      RAISE EXCEPTION '057 rebuilds the marketplace money tables and can only run before any marketplace payment exists';
    END IF;
    DROP TABLE IF EXISTS public.market_lot_allocations, public.market_fund_lots, public.market_earnings,
      public.market_withdrawals, public.market_ledger, public.market_payments CASCADE;
  END IF;
END $$;

-- Functions whose arguments or return shape changed (055 versions).
DROP FUNCTION IF EXISTS public.market_bid_fee(numeric);
DROP FUNCTION IF EXISTS public.market_funds_balance(uuid);
DROP FUNCTION IF EXISTS public.market_earnings_summary(uuid);
DROP FUNCTION IF EXISTS public.market_take_funds(uuid, numeric, text, uuid, uuid);
DROP FUNCTION IF EXISTS public.market_create_payment(uuid, text, numeric, jsonb, text);
DROP FUNCTION IF EXISTS public.settle_cash_sale(uuid, uuid, numeric, uuid);
DROP FUNCTION IF EXISTS public.request_market_withdrawal(text, numeric, uuid);
DROP FUNCTION IF EXISTS public.market_withdrawal_sources(uuid);
ALTER TABLE public.marketplace_bids DROP COLUMN IF EXISTS fee_usd;

-- Settings added since 055.
ALTER TABLE public.market_settings ADD COLUMN IF NOT EXISTS max_rate_jump_percent numeric NOT NULL DEFAULT 15;
ALTER TABLE public.market_settings ALTER COLUMN fx_max_age_hours SET DEFAULT 26;
UPDATE public.market_settings SET fx_max_age_hours = 26 WHERE fx_max_age_hours = 12;


-- ════════════════════════════════════════════════════════════════════════════
-- 0. Settings, currencies, rates, admins, revenue sources
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.market_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  platform_fee_pct      numeric NOT NULL DEFAULT 5,
  bid_fee_pct           numeric NOT NULL DEFAULT 2.5,
  bid_fee_min_usd       numeric NOT NULL DEFAULT 0.25,   -- converted for NGN listings
  bid_fee_max_usd       numeric NOT NULL DEFAULT 10,
  clearing_days         integer NOT NULL DEFAULT 30,
  fx_spread_pct         numeric NOT NULL DEFAULT 1.5,    -- on naira paid for USD listings
  fx_max_age_hours      integer NOT NULL DEFAULT 26,     -- the rate source publishes daily
  max_rate_jump_percent numeric NOT NULL DEFAULT 15,     -- backend refuses bigger jumps
  min_withdrawal_usd    numeric NOT NULL DEFAULT 10,     -- converted for NGN
  min_payment_usd       numeric NOT NULL DEFAULT 1,      -- converted for NGN
  auction_default_days  integer NOT NULL DEFAULT 7,
  auction_max_days      integer NOT NULL DEFAULT 14,
  fixed_max_days        integer NOT NULL DEFAULT 30,
  decision_hours        integer NOT NULL DEFAULT 48,
  royalty_default_pct   numeric NOT NULL DEFAULT 5,
  royalty_max_pct       numeric NOT NULL DEFAULT 10,
  max_active_bids       integer NOT NULL DEFAULT 20,
  payouts_enabled       boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.market_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
ALTER TABLE public.market_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS market_settings_read ON public.market_settings;
CREATE POLICY market_settings_read ON public.market_settings FOR SELECT USING (true);
REVOKE INSERT, UPDATE, DELETE ON public.market_settings FROM anon, authenticated;

-- Listing currencies. settlement_currency is derived: NGN settles in NGN,
-- everything else in USD. payment_methods follows One Dream: NGN -> Paystack,
-- USD -> Paystack or USDT, other currencies -> USDT.
CREATE TABLE IF NOT EXISTS public.marketplace_currencies (
  code text PRIMARY KEY CHECK (code ~ '^[A-Z]{3}$'),
  name text NOT NULL,
  symbol text NOT NULL,
  settlement_currency text NOT NULL CHECK (settlement_currency IN ('NGN', 'USD')),
  payment_methods text[] NOT NULL,
  is_enabled boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 100,
  CHECK (settlement_currency = CASE WHEN code = 'NGN' THEN 'NGN' ELSE 'USD' END)
);
INSERT INTO public.marketplace_currencies (code, name, symbol, settlement_currency, payment_methods, sort_order) VALUES
  ('USD', 'US dollar',      '$',   'USD', '{paystack,usdt}', 10),
  ('NGN', 'Nigerian naira', '₦',   'NGN', '{paystack}',      20),
  ('GBP', 'British pound',  '£',   'USD', '{usdt}',          30),
  ('EUR', 'Euro',           '€',   'USD', '{usdt}',          40),
  ('GHS', 'Ghanaian cedi',  'GH₵', 'USD', '{usdt}',          50)
ON CONFLICT (code) DO NOTHING;
ALTER TABLE public.marketplace_currencies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS marketplace_currencies_read ON public.marketplace_currencies;
CREATE POLICY marketplace_currencies_read ON public.marketplace_currencies FOR SELECT USING (true);
REVOKE INSERT, UPDATE, DELETE ON public.marketplace_currencies FROM anon, authenticated;

-- Exchange rates (units per 1 USD), written by the backend from open.er-api.com.
CREATE TABLE IF NOT EXISTS public.market_fx_rates (
  currency text PRIMARY KEY,
  units_per_usd numeric NOT NULL CHECK (units_per_usd > 0),
  fetched_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.market_fx_rates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS market_fx_rates_read ON public.market_fx_rates;
CREATE POLICY market_fx_rates_read ON public.market_fx_rates FOR SELECT USING (true);
REVOKE INSERT, UPDATE, DELETE ON public.market_fx_rates FROM anon, authenticated;

-- Admins are added by hand in the SQL editor:
--   INSERT INTO app_admins (user_id) VALUES ('<your profile id>');
CREATE TABLE IF NOT EXISTS public.app_admins (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.app_admins ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS app_admins_self ON public.app_admins;
CREATE POLICY app_admins_self ON public.app_admins FOR SELECT USING (auth.uid() = user_id);
REVOKE INSERT, UPDATE, DELETE ON public.app_admins FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.is_app_admin(p_user_id uuid DEFAULT auth.uid())
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM app_admins WHERE user_id = p_user_id);
$$;
GRANT EXECUTE ON FUNCTION public.is_app_admin(uuid) TO authenticated;

INSERT INTO public.revenue_sources (source, fee_type, category, enabled, description) VALUES
  ('marketplace_bid_fee', 'percentage', 'marketplace', true, 'Non-refundable fee on every paid bid and Buy Now purchase (market_settings.bid_fee_*)'),
  ('marketplace_fx_spread', 'spread', 'exchange', true, 'Spread on naira paid for USD listings (market_settings.fx_spread_pct)')
ON CONFLICT (source) DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. Profile deletion and foreign keys: nothing that holds money cascades away
-- ════════════════════════════════════════════════════════════════════════════

-- A user could delete their own profile row directly, cascading away their
-- listings, bids and ownership records. Deletion now goes only through
-- request_account_deletion() and the backend.
DROP POLICY IF EXISTS "Allow user deletes" ON public.profiles;
REVOKE DELETE ON public.profiles FROM anon, authenticated;

ALTER TABLE public.marketplace_listings DROP CONSTRAINT IF EXISTS marketplace_listings_creator_id_fkey;
ALTER TABLE public.marketplace_listings ALTER COLUMN creator_id DROP NOT NULL;
ALTER TABLE public.marketplace_listings
  ADD CONSTRAINT marketplace_listings_creator_id_fkey FOREIGN KEY (creator_id) REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE public.marketplace_listings DROP CONSTRAINT IF EXISTS marketplace_listings_seller_id_fkey;
ALTER TABLE public.marketplace_listings ALTER COLUMN seller_id DROP NOT NULL;
ALTER TABLE public.marketplace_listings
  ADD CONSTRAINT marketplace_listings_seller_id_fkey FOREIGN KEY (seller_id) REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE public.marketplace_bids DROP CONSTRAINT IF EXISTS marketplace_bids_bidder_id_fkey;
ALTER TABLE public.marketplace_bids ALTER COLUMN bidder_id DROP NOT NULL;
ALTER TABLE public.marketplace_bids
  ADD CONSTRAINT marketplace_bids_bidder_id_fkey FOREIGN KEY (bidder_id) REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE public.marketplace_bids DROP CONSTRAINT IF EXISTS marketplace_bids_listing_id_fkey;
ALTER TABLE public.marketplace_bids
  ADD CONSTRAINT marketplace_bids_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES public.marketplace_listings(id) ON DELETE RESTRICT;

ALTER TABLE public.marketplace_ownership_history DROP CONSTRAINT IF EXISTS marketplace_ownership_history_to_user_id_fkey;
ALTER TABLE public.marketplace_ownership_history ALTER COLUMN to_user_id DROP NOT NULL;
ALTER TABLE public.marketplace_ownership_history
  ADD CONSTRAINT marketplace_ownership_history_to_user_id_fkey FOREIGN KEY (to_user_id) REFERENCES public.profiles(id) ON DELETE SET NULL;

-- ════════════════════════════════════════════════════════════════════════════
-- 2. Listing and bid columns
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.marketplace_listings ADD COLUMN IF NOT EXISTS listing_currency text NOT NULL DEFAULT 'USD';
ALTER TABLE public.marketplace_listings DROP CONSTRAINT IF EXISTS marketplace_listings_currency_fkey;
ALTER TABLE public.marketplace_listings
  ADD CONSTRAINT marketplace_listings_currency_fkey FOREIGN KEY (listing_currency) REFERENCES public.marketplace_currencies(code);
ALTER TABLE public.marketplace_listings ADD COLUMN IF NOT EXISTS decision_deadline timestamptz;
ALTER TABLE public.marketplace_listings ADD COLUMN IF NOT EXISTS ending_reminder_sent boolean NOT NULL DEFAULT false;
ALTER TABLE public.marketplace_listings ADD COLUMN IF NOT EXISTS closed_at timestamptz;

ALTER TABLE public.marketplace_listings DROP CONSTRAINT IF EXISTS marketplace_listings_status_check;
ALTER TABLE public.marketplace_listings ADD CONSTRAINT marketplace_listings_status_check
  CHECK (status IN ('active', 'awaiting_decision', 'sold', 'cancelled', 'expired')) NOT VALID;

-- One open listing per item, including one waiting for the owner's decision.
DROP INDEX IF EXISTS public.marketplace_listings_one_active_per_item;
CREATE UNIQUE INDEX marketplace_listings_one_active_per_item
  ON public.marketplace_listings(item_type, item_id) WHERE status IN ('active', 'awaiting_decision');

ALTER TABLE public.marketplace_listings DROP CONSTRAINT IF EXISTS marketplace_listings_royalty_range;
ALTER TABLE public.marketplace_listings
  ADD CONSTRAINT marketplace_listings_royalty_range CHECK (royalty_pct >= 0 AND royalty_pct <= 10) NOT VALID;

-- Paid bids. amount is in the listing currency; settle_amount is what was
-- escrowed, in the settlement currency (equal to amount unless the listing
-- is in GBP/EUR/GHS, where it was converted to USD at fx_rate).
ALTER TABLE public.marketplace_bids ADD COLUMN IF NOT EXISTS funding text NOT NULL DEFAULT 'credits';
ALTER TABLE public.marketplace_bids ADD COLUMN IF NOT EXISTS fee_amount numeric NOT NULL DEFAULT 0;
ALTER TABLE public.marketplace_bids ADD COLUMN IF NOT EXISTS settle_currency text;
ALTER TABLE public.marketplace_bids ADD COLUMN IF NOT EXISTS settle_amount numeric;
ALTER TABLE public.marketplace_bids ADD COLUMN IF NOT EXISTS fx_rate numeric;
ALTER TABLE public.marketplace_bids DROP CONSTRAINT IF EXISTS marketplace_bids_status_check;
ALTER TABLE public.marketplace_bids ADD CONSTRAINT marketplace_bids_status_check
  CHECK (status IN ('active', 'accepted', 'rejected', 'expired', 'withdrawn', 'superseded')) NOT VALID;

ALTER TABLE public.marketplace_ownership_history ADD COLUMN IF NOT EXISTS settle_currency text;

-- Bids are binding: the client UPDATE path from 054 is closed. Every bid
-- change goes through the functions below.
DROP POLICY IF EXISTS marketplace_bids_withdraw ON public.marketplace_bids;
REVOKE UPDATE ON public.marketplace_bids FROM anon, authenticated;

-- Listing cancel stays a client UPDATE (status only, from 054), but a
-- listing with paid bids can't be cancelled.
CREATE OR REPLACE FUNCTION public.guard_listing_cancel()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'cancelled' AND OLD.status <> 'cancelled'
     AND COALESCE(current_setting('app.force_cancel', true), '') <> 'on'
     AND EXISTS (SELECT 1 FROM marketplace_bids WHERE listing_id = NEW.id AND status = 'active') THEN
    RAISE EXCEPTION 'This listing has paid bids, so it can''t be cancelled. Accept a bid, or wait for it to close and the bids will be refunded.';
  END IF;
  IF NEW.listing_currency IS DISTINCT FROM OLD.listing_currency THEN
    RAISE EXCEPTION 'A listing''s currency can''t be changed';
  END IF;
  IF NEW.status IN ('sold', 'cancelled', 'expired') AND OLD.status NOT IN ('sold', 'cancelled', 'expired') THEN
    NEW.closed_at := now();
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_guard_listing_cancel ON public.marketplace_listings;
CREATE TRIGGER trg_guard_listing_cancel BEFORE UPDATE ON public.marketplace_listings
  FOR EACH ROW EXECUTE FUNCTION public.guard_listing_cancel();

-- Close out bids only when a listing actually closes (not when it moves to
-- awaiting_decision).
CREATE OR REPLACE FUNCTION public.reject_bids_on_listing_close()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status IN ('sold', 'cancelled', 'expired') THEN
    UPDATE marketplace_bids
      SET status = CASE WHEN NEW.status = 'expired' THEN 'expired' ELSE 'rejected' END,
          decided_at = now()
      WHERE listing_id = NEW.id AND status = 'active';
  END IF;
  RETURN NEW;
END;
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- 3. Marketplace money tables (every amount carries its currency: USD or NGN)
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.market_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  method text NOT NULL CHECK (method IN ('paystack', 'usdt')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed')),
  credit_currency text NOT NULL CHECK (credit_currency IN ('USD', 'NGN')),
  credit_amount numeric NOT NULL CHECK (credit_amount > 0),  -- added to funds once paid
  pay_currency text NOT NULL CHECK (pay_currency IN ('NGN', 'USDT')),
  amount_due numeric NOT NULL CHECK (amount_due > 0),         -- what the payer must send
  amount_received numeric,
  fx_rate numeric,       -- NGN per USD charged incl. spread (Paystack payments for USD funds)
  fx_mid_rate numeric,   -- market NGN per USD at the time
  paystack_reference text UNIQUE,
  usdt_network text CHECK (usdt_network IN ('tron', 'bsc')),
  usdt_tx_hash text,
  usdt_sender text,
  purpose jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '2 hours',
  CHECK (NOT (method = 'usdt' AND credit_currency = 'NGN')),
  CHECK ((method = 'usdt') = (pay_currency = 'USDT'))
);
CREATE UNIQUE INDEX IF NOT EXISTS market_payments_usdt_tx_unique
  ON public.market_payments (usdt_network, lower(usdt_tx_hash)) WHERE usdt_tx_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS market_payments_user_idx ON public.market_payments(user_id, created_at DESC);

-- Each paid-in payment becomes a lot. Spending and refunds move money in and
-- out of lots, so every unit can be traced back to where it came from.
CREATE TABLE IF NOT EXISTS public.market_fund_lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  payment_id uuid NOT NULL UNIQUE REFERENCES public.market_payments(id) ON DELETE RESTRICT,
  currency text NOT NULL CHECK (currency IN ('USD', 'NGN')),
  original_amount numeric NOT NULL CHECK (original_amount > 0),
  remaining_amount numeric NOT NULL CHECK (remaining_amount >= 0 AND remaining_amount <= original_amount),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS market_fund_lots_user_idx ON public.market_fund_lots(user_id, currency, created_at);

CREATE TABLE IF NOT EXISTS public.market_lot_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id uuid NOT NULL REFERENCES public.market_fund_lots(id) ON DELETE RESTRICT,
  amount numeric NOT NULL CHECK (amount > 0),
  purpose text NOT NULL CHECK (purpose IN ('bid', 'fee', 'purchase', 'withdrawal')),
  bid_id uuid REFERENCES public.marketplace_bids(id) ON DELETE RESTRICT,
  withdrawal_id uuid,
  released boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS market_lot_allocations_bid_idx ON public.market_lot_allocations(bid_id) WHERE bid_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS market_lot_allocations_wd_idx ON public.market_lot_allocations(withdrawal_id) WHERE withdrawal_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.market_earnings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('sale', 'royalty')),
  currency text NOT NULL CHECK (currency IN ('USD', 'NGN')),
  amount numeric NOT NULL CHECK (amount > 0),
  available_at timestamptz NOT NULL,
  listing_id uuid REFERENCES public.marketplace_listings(id) ON DELETE RESTRICT,
  ownership_id uuid REFERENCES public.marketplace_ownership_history(id) ON DELETE RESTRICT,
  forfeited boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS market_earnings_user_idx ON public.market_earnings(user_id, currency);

CREATE TABLE IF NOT EXISTS public.payout_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  method text NOT NULL CHECK (method IN ('bank_ngn', 'usdt_tron', 'usdt_bsc')),
  bank_code text,
  bank_name text,
  account_number text,
  account_name text,          -- as returned by Paystack's account lookup
  recipient_code text,        -- Paystack transfer recipient
  usdt_address text,
  is_active boolean NOT NULL DEFAULT true,
  verified_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (method = 'bank_ngn' AND bank_code IS NOT NULL AND account_number ~ '^[0-9]{10}$' AND account_name IS NOT NULL)
    OR (method = 'usdt_tron' AND usdt_address ~ '^T[1-9A-HJ-NP-Za-km-z]{33}$')
    OR (method = 'usdt_bsc' AND usdt_address ~ '^0x[0-9a-fA-F]{40}$')
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS payout_accounts_one_active_per_method
  ON public.payout_accounts(user_id, method) WHERE is_active;

CREATE TABLE IF NOT EXISTS public.market_withdrawals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  bucket text NOT NULL CHECK (bucket IN ('earnings', 'funds')),
  currency text NOT NULL CHECK (currency IN ('USD', 'NGN')),
  amount numeric NOT NULL CHECK (amount > 0),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'paid', 'rejected', 'failed')),
  payout_account_id uuid REFERENCES public.payout_accounts(id) ON DELETE SET NULL,  -- earnings only
  payout_details jsonb,         -- snapshot of the account at request time
  fx_rate numeric,
  amount_paid numeric,
  currency_paid text,
  provider_ref text,
  failure_reason text,
  admin_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  admin_note text,
  auto_created boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  paid_at timestamptz
);
CREATE INDEX IF NOT EXISTS market_withdrawals_user_idx ON public.market_withdrawals(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS market_withdrawals_status_idx ON public.market_withdrawals(status, created_at);

ALTER TABLE public.market_lot_allocations DROP CONSTRAINT IF EXISTS market_lot_allocations_withdrawal_fk;
ALTER TABLE public.market_lot_allocations
  ADD CONSTRAINT market_lot_allocations_withdrawal_fk FOREIGN KEY (withdrawal_id) REFERENCES public.market_withdrawals(id) ON DELETE RESTRICT;

-- Append-only audit trail of every marketplace money movement.
CREATE TABLE IF NOT EXISTS public.market_ledger (
  id bigserial PRIMARY KEY,
  user_id uuid,
  bucket text NOT NULL CHECK (bucket IN ('funds', 'earnings', 'platform')),
  kind text NOT NULL,
  currency text NOT NULL CHECK (currency IN ('USD', 'NGN')),
  amount numeric NOT NULL,
  reference_id uuid,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS market_ledger_user_idx ON public.market_ledger(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.account_deletion_requests (
  user_id uuid PRIMARY KEY,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'cancelled')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  notes text
);

-- Row-level security: users read their own rows; nobody writes directly.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['market_payments','market_fund_lots','market_earnings','payout_accounts',
                           'market_withdrawals','market_ledger','account_deletion_requests','market_lot_allocations']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON public.%I FROM anon, authenticated', t);
  END LOOP;
END $$;

DROP POLICY IF EXISTS own_rows ON public.market_payments;
CREATE POLICY own_rows ON public.market_payments FOR SELECT USING (auth.uid() = user_id OR is_app_admin());
DROP POLICY IF EXISTS own_rows ON public.market_fund_lots;
CREATE POLICY own_rows ON public.market_fund_lots FOR SELECT USING (auth.uid() = user_id OR is_app_admin());
DROP POLICY IF EXISTS own_rows ON public.market_earnings;
CREATE POLICY own_rows ON public.market_earnings FOR SELECT USING (auth.uid() = user_id OR is_app_admin());
DROP POLICY IF EXISTS own_rows ON public.payout_accounts;
CREATE POLICY own_rows ON public.payout_accounts FOR SELECT USING (auth.uid() = user_id OR is_app_admin());
DROP POLICY IF EXISTS own_rows ON public.market_withdrawals;
CREATE POLICY own_rows ON public.market_withdrawals FOR SELECT USING (auth.uid() = user_id OR is_app_admin());
DROP POLICY IF EXISTS own_rows ON public.market_ledger;
CREATE POLICY own_rows ON public.market_ledger FOR SELECT USING (auth.uid() = user_id OR is_app_admin());
DROP POLICY IF EXISTS own_rows ON public.account_deletion_requests;
CREATE POLICY own_rows ON public.account_deletion_requests FOR SELECT USING (auth.uid() = user_id OR is_app_admin());
DROP POLICY IF EXISTS admin_rows ON public.market_lot_allocations;
CREATE POLICY admin_rows ON public.market_lot_allocations FOR SELECT USING (is_app_admin());

-- ════════════════════════════════════════════════════════════════════════════
-- 4. Helpers
-- ════════════════════════════════════════════════════════════════════════════

-- Units of p_code per 1 USD, refusing stale rates. USD is always 1.
CREATE OR REPLACE FUNCTION public.market_rate(p_code text)
RETURNS numeric LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_rate numeric;
  v_age integer;
BEGIN
  IF p_code = 'USD' THEN RETURN 1; END IF;
  SELECT fx_max_age_hours INTO v_age FROM market_settings WHERE id;
  SELECT units_per_usd INTO v_rate FROM market_fx_rates
    WHERE currency = p_code AND fetched_at >= now() - make_interval(hours => v_age);
  IF v_rate IS NULL THEN
    RAISE EXCEPTION 'The % exchange rate is unavailable right now. Try again in a few minutes.', p_code;
  END IF;
  RETURN v_rate;
END;
$$;
GRANT EXECUTE ON FUNCTION public.market_rate(text) TO anon, authenticated;

-- Converts between currencies through USD, rounded to 2 decimals.
CREATE OR REPLACE FUNCTION public.market_convert(p_amount numeric, p_from text, p_to text)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN p_from = p_to THEN ROUND(p_amount, 2)
              ELSE ROUND(p_amount / market_rate(p_from) * market_rate(p_to), 2) END;
$$;
GRANT EXECUTE ON FUNCTION public.market_convert(numeric, text, text) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.market_settle_currency(p_listing_currency text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_listing_currency = 'NGN' THEN 'NGN' ELSE 'USD' END;
$$;

CREATE OR REPLACE FUNCTION public.market_money(p_amount numeric, p_currency text)
RETURNS text LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT COALESCE((SELECT symbol FROM marketplace_currencies WHERE code = p_currency), p_currency || ' ')
         || to_char(p_amount, 'FM999,999,999,990.00');
$$;

-- Bid fee in the settlement currency (min/max are set in USD and converted).
CREATE OR REPLACE FUNCTION public.market_bid_fee(p_amount numeric, p_currency text)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT ROUND(LEAST(GREATEST(p_amount * s.bid_fee_pct / 100, market_convert(s.bid_fee_min_usd, 'USD', p_currency)),
                     market_convert(s.bid_fee_max_usd, 'USD', p_currency)), 2)
  FROM market_settings s WHERE s.id;
$$;
GRANT EXECUTE ON FUNCTION public.market_bid_fee(numeric, text) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.market_funds_balance(p_user_id uuid, p_currency text)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(SUM(remaining_amount), 0) FROM market_fund_lots WHERE user_id = p_user_id AND currency = p_currency;
$$;
REVOKE ALL ON FUNCTION public.market_funds_balance(uuid, text) FROM PUBLIC, anon, authenticated;

-- Earnings in one currency: cleared, pending (still clearing), and already
-- withdrawn or reserved for a withdrawal.
CREATE OR REPLACE FUNCTION public.market_earnings_summary(p_user_id uuid, p_currency text)
RETURNS TABLE (cleared numeric, pending numeric, reserved numeric, withdrawable numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH e AS (
    SELECT
      COALESCE(SUM(amount) FILTER (WHERE NOT forfeited AND available_at <= now()), 0) AS cleared,
      COALESCE(SUM(amount) FILTER (WHERE NOT forfeited AND available_at > now()), 0) AS pending
    FROM market_earnings WHERE user_id = p_user_id AND currency = p_currency
  ), w AS (
    SELECT COALESCE(SUM(amount), 0) AS reserved
    FROM market_withdrawals
    WHERE user_id = p_user_id AND bucket = 'earnings' AND currency = p_currency
      AND status IN ('pending', 'processing', 'paid')
  )
  SELECT e.cleared, e.pending, w.reserved, GREATEST(e.cleared - w.reserved, 0) FROM e, w;
$$;
REVOKE ALL ON FUNCTION public.market_earnings_summary(uuid, text) FROM PUBLIC, anon, authenticated;

-- The signed-in user's marketplace wallet, per currency.
CREATE OR REPLACE FUNCTION public.get_market_balances()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_cur text;
  v_e record;
  v_in_bids numeric;
  v_out jsonb := '{}'::jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  FOREACH v_cur IN ARRAY ARRAY['USD', 'NGN'] LOOP
    SELECT * INTO v_e FROM market_earnings_summary(v_uid, v_cur);
    SELECT COALESCE(SUM(a.amount), 0) INTO v_in_bids
      FROM market_lot_allocations a
      JOIN market_fund_lots l ON l.id = a.lot_id
      JOIN marketplace_bids b ON b.id = a.bid_id
      WHERE b.bidder_id = v_uid AND b.status = 'active' AND a.purpose = 'bid' AND NOT a.released AND l.currency = v_cur;
    v_out := v_out || jsonb_build_object(v_cur, jsonb_build_object(
      'funds', market_funds_balance(v_uid, v_cur),
      'held_in_bids', v_in_bids,
      'earnings_withdrawable', v_e.withdrawable,
      'earnings_pending', v_e.pending,
      'earnings_reserved', v_e.reserved));
  END LOOP;
  RETURN v_out;
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_market_balances() TO authenticated;

-- Take p_amount (in p_currency) out of a user's lots, oldest first.
CREATE OR REPLACE FUNCTION public.market_take_funds(
  p_user_id uuid, p_currency text, p_amount numeric, p_purpose text, p_bid_id uuid DEFAULT NULL, p_withdrawal_id uuid DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_left numeric := ROUND(p_amount, 2);
  v_lot record;
  v_take numeric;
BEGIN
  IF v_left <= 0 THEN RETURN; END IF;
  IF market_funds_balance(p_user_id, p_currency) < v_left THEN
    RAISE EXCEPTION 'Not enough marketplace funds';
  END IF;
  FOR v_lot IN
    SELECT id, remaining_amount FROM market_fund_lots
    WHERE user_id = p_user_id AND currency = p_currency AND remaining_amount > 0
    ORDER BY created_at, id FOR UPDATE
  LOOP
    EXIT WHEN v_left <= 0;
    v_take := LEAST(v_left, v_lot.remaining_amount);
    UPDATE market_fund_lots SET remaining_amount = remaining_amount - v_take WHERE id = v_lot.id;
    INSERT INTO market_lot_allocations (lot_id, amount, purpose, bid_id, withdrawal_id)
      VALUES (v_lot.id, v_take, p_purpose, p_bid_id, p_withdrawal_id);
    v_left := v_left - v_take;
  END LOOP;
  IF v_left > 0 THEN RAISE EXCEPTION 'Not enough marketplace funds'; END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.market_take_funds(uuid, text, numeric, text, uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Put allocations back into their original lots (bid refund, withdrawal rejected).
CREATE OR REPLACE FUNCTION public.market_release_allocations(p_bid_id uuid, p_withdrawal_id uuid, p_purpose text)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_total numeric := 0;
  v_a record;
BEGIN
  FOR v_a IN
    SELECT id, lot_id, amount FROM market_lot_allocations
    WHERE NOT released AND purpose = p_purpose
      AND ((p_bid_id IS NOT NULL AND bid_id = p_bid_id) OR (p_withdrawal_id IS NOT NULL AND withdrawal_id = p_withdrawal_id))
    FOR UPDATE
  LOOP
    UPDATE market_fund_lots SET remaining_amount = remaining_amount + v_a.amount WHERE id = v_a.lot_id;
    UPDATE market_lot_allocations SET released = true WHERE id = v_a.id;
    v_total := v_total + v_a.amount;
  END LOOP;
  RETURN v_total;
END;
$$;
REVOKE ALL ON FUNCTION public.market_release_allocations(uuid, uuid, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.market_notify(p_user_id uuid, p_type text, p_title text, p_body text, p_ref uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_user_id IS NULL THEN RETURN; END IF;
  INSERT INTO notifications (user_id, type, title, body, reference_id) VALUES (p_user_id, p_type, p_title, p_body, p_ref);
EXCEPTION WHEN others THEN
  NULL;  -- a notification must never block a money operation
END;
$$;
REVOKE ALL ON FUNCTION public.market_notify(uuid, text, text, text, uuid) FROM PUBLIC, anon, authenticated;

-- Refund a paid bid's escrow when it leaves 'active' for any reason other
-- than being accepted. The bid fee is never refunded.
CREATE OR REPLACE FUNCTION public.refund_cash_bid_on_close()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_refunded numeric;
BEGIN
  IF NEW.funding = 'cash' AND OLD.status = 'active'
     AND NEW.status IN ('rejected', 'expired', 'withdrawn', 'superseded') THEN
    v_refunded := market_release_allocations(NEW.id, NULL, 'bid');
    IF v_refunded > 0 THEN
      INSERT INTO market_ledger (user_id, bucket, kind, currency, amount, reference_id)
        VALUES (NEW.bidder_id, 'funds', 'bid_refund', NEW.settle_currency, v_refunded, NEW.id);
      PERFORM market_notify(NEW.bidder_id, 'marketplace_bid_refunded', 'Bid refunded',
        'Your bid didn''t win. ' || market_money(v_refunded, NEW.settle_currency) || ' is back in your marketplace funds.', NEW.listing_id);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_refund_cash_bid_on_close ON public.marketplace_bids;
CREATE TRIGGER trg_refund_cash_bid_on_close AFTER UPDATE ON public.marketplace_bids
  FOR EACH ROW EXECUTE FUNCTION public.refund_cash_bid_on_close();

-- ════════════════════════════════════════════════════════════════════════════
-- 5. Payments in (called by the backend with the service role after it has
--    verified the payment with Paystack or on-chain)
-- ════════════════════════════════════════════════════════════════════════════

-- Creates a pending payment and returns what the user must pay.
--   NGN funds:  Paystack, in naira, no conversion.
--   USD funds:  Paystack (naira at the day's rate + spread) or USDT (1:1 plus
--               a unique sub-cent tag).
-- Rates are read server-side; the client never supplies one.
CREATE OR REPLACE FUNCTION public.market_create_payment(
  p_user_id uuid, p_method text, p_credit_currency text, p_amount numeric, p_purpose jsonb, p_reference text DEFAULT NULL
) RETURNS market_payments LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s market_settings%ROWTYPE;
  v_min numeric;
  v_mid numeric;
  v_rate numeric;
  v_due numeric;
  v_pay market_payments%ROWTYPE;
BEGIN
  SELECT * INTO s FROM market_settings WHERE id;
  IF p_credit_currency NOT IN ('USD', 'NGN') THEN RAISE EXCEPTION 'Unknown currency'; END IF;
  p_amount := ROUND(p_amount, 2);
  v_min := market_convert(s.min_payment_usd, 'USD', p_credit_currency);
  IF p_amount IS NULL OR p_amount < v_min THEN
    RAISE EXCEPTION 'Minimum payment is %', market_money(v_min, p_credit_currency);
  END IF;
  IF EXISTS (SELECT 1 FROM account_deletion_requests WHERE user_id = p_user_id AND status = 'pending') THEN
    RAISE EXCEPTION 'This account is being deleted';
  END IF;

  IF p_method = 'paystack' AND p_credit_currency = 'NGN' THEN
    INSERT INTO market_payments (user_id, method, credit_currency, credit_amount, pay_currency, amount_due, paystack_reference, purpose)
      VALUES (p_user_id, 'paystack', 'NGN', p_amount, 'NGN', p_amount, p_reference, COALESCE(p_purpose, '{}'))
      RETURNING * INTO v_pay;
  ELSIF p_method = 'paystack' THEN
    v_mid := market_rate('NGN');
    v_rate := ROUND(v_mid * (1 + s.fx_spread_pct / 100), 4);
    v_due := CEIL(p_amount * v_rate);  -- whole naira, rounded up
    INSERT INTO market_payments (user_id, method, credit_currency, credit_amount, pay_currency, amount_due, fx_rate, fx_mid_rate, paystack_reference, purpose)
      VALUES (p_user_id, 'paystack', 'USD', p_amount, 'NGN', v_due, v_rate, v_mid, p_reference, COALESCE(p_purpose, '{}'))
      RETURNING * INTO v_pay;
  ELSIF p_method = 'usdt' THEN
    IF p_credit_currency <> 'USD' THEN RAISE EXCEPTION 'Naira listings are paid by Paystack only'; END IF;
    -- The receiving addresses are shared with One Dream, so a transfer can
    -- only be claimed if it (a) comes from the sender address the payer
    -- declared up front, (b) is for this payment's exact amount, which carries
    -- a unique sub-cent tag, and (c) happened after this payment was created.
    -- The backend enforces (a)-(c) on-chain before confirming.
    IF p_purpose ->> 'sender' IS NULL OR p_purpose ->> 'network' NOT IN ('tron', 'bsc') THEN
      RAISE EXCEPTION 'USDT payments need the network and the address you will send from';
    END IF;
    v_due := p_amount + (floor(random() * 98) + 1) / 10000.0;
    INSERT INTO market_payments (user_id, method, credit_currency, credit_amount, pay_currency, amount_due, purpose, usdt_network, expires_at)
      VALUES (p_user_id, 'usdt', 'USD', p_amount, 'USDT', v_due, p_purpose, p_purpose ->> 'network', now() + interval '24 hours')
      RETURNING * INTO v_pay;
  ELSE
    RAISE EXCEPTION 'Unknown payment method';
  END IF;
  RETURN v_pay;
END;
$$;
REVOKE ALL ON FUNCTION public.market_create_payment(uuid, text, text, numeric, jsonb, text) FROM PUBLIC, anon, authenticated;

-- Marks a verified payment paid and turns it into spendable funds. Idempotent.
CREATE OR REPLACE FUNCTION public.market_confirm_payment(
  p_payment_id uuid, p_amount_received numeric, p_provider_data jsonb,
  p_usdt_network text DEFAULT NULL, p_usdt_tx_hash text DEFAULT NULL, p_usdt_sender text DEFAULT NULL
) RETURNS market_payments LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_pay market_payments%ROWTYPE;
  v_spread numeric;
BEGIN
  SELECT * INTO v_pay FROM market_payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment not found'; END IF;
  IF v_pay.status = 'paid' THEN RETURN v_pay; END IF;
  IF v_pay.status <> 'pending' THEN RAISE EXCEPTION 'Payment is %', v_pay.status; END IF;
  IF p_amount_received IS NULL OR p_amount_received < v_pay.amount_due THEN
    RAISE EXCEPTION 'Amount received (%) is less than amount due (%)', p_amount_received, v_pay.amount_due;
  END IF;
  IF v_pay.method = 'usdt' AND (p_usdt_tx_hash IS NULL OR p_usdt_sender IS NULL OR p_usdt_network IS NULL) THEN
    RAISE EXCEPTION 'USDT confirmation needs the network, transaction hash and sender';
  END IF;

  UPDATE market_payments SET
    status = 'paid', paid_at = now(), amount_received = p_amount_received, provider_data = p_provider_data,
    usdt_network = COALESCE(p_usdt_network, usdt_network),
    usdt_tx_hash = COALESCE(p_usdt_tx_hash, usdt_tx_hash),
    usdt_sender = COALESCE(p_usdt_sender, usdt_sender)
  WHERE id = p_payment_id RETURNING * INTO v_pay;

  INSERT INTO market_fund_lots (user_id, payment_id, currency, original_amount, remaining_amount)
    VALUES (v_pay.user_id, v_pay.id, v_pay.credit_currency, v_pay.credit_amount, v_pay.credit_amount);
  INSERT INTO market_ledger (user_id, bucket, kind, currency, amount, reference_id, meta)
    VALUES (v_pay.user_id, 'funds', 'payment_in', v_pay.credit_currency, v_pay.credit_amount, v_pay.id,
            jsonb_build_object('method', v_pay.method, 'paid', p_amount_received, 'pay_currency', v_pay.pay_currency));

  IF v_pay.method = 'paystack' AND v_pay.credit_currency = 'USD' AND v_pay.fx_mid_rate IS NOT NULL THEN
    v_spread := ROUND(v_pay.amount_due / v_pay.fx_mid_rate - v_pay.credit_amount, 2);
    PERFORM record_revenue(
      p_source => 'marketplace_fx_spread', p_user_id => v_pay.user_id, p_reference_id => v_pay.id,
      p_gross_amount => v_pay.credit_amount, p_revenue_amount => v_spread, p_currency => 'USD',
      p_payment_method => 'paystack', p_original_currency => 'NGN', p_original_amount => v_pay.amount_due,
      p_metadata => '{}'::jsonb);
  END IF;
  RETURN v_pay;
END;
$$;
REVOKE ALL ON FUNCTION public.market_confirm_payment(uuid, numeric, jsonb, text, text, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.market_fail_payment(p_payment_id uuid, p_reason text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE market_payments SET status = 'failed', provider_data = jsonb_build_object('reason', p_reason)
  WHERE id = p_payment_id AND status = 'pending';
$$;
REVOKE ALL ON FUNCTION public.market_fail_payment(uuid, text) FROM PUBLIC, anon, authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 6. Listings (credits pay the listing fee; marketplace money pays for items)
-- ════════════════════════════════════════════════════════════════════════════

-- The listing currency is a new trailing parameter, so the 10-argument
-- version from 054 is dropped to keep a single, unambiguous function.
DROP FUNCTION IF EXISTS public.create_marketplace_listing(text, uuid, uuid, numeric, numeric, numeric, numeric, numeric, timestamptz, text);

CREATE OR REPLACE FUNCTION public.create_marketplace_listing(
  p_item_type text, p_item_id uuid, p_seller_id uuid, p_asking_price numeric,
  p_buy_now_price numeric DEFAULT NULL, p_reserve_price numeric DEFAULT NULL, p_minimum_increment numeric DEFAULT NULL,
  p_royalty_pct numeric DEFAULT NULL, p_expires_at timestamptz DEFAULT NULL, p_listing_type text DEFAULT NULL,
  p_listing_currency text DEFAULT 'USD'
)
 RETURNS marketplace_listings
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  s market_settings%ROWTYPE;
  v_cur marketplace_currencies%ROWTYPE;
  v_listing_fee numeric := 0.50;
  v_author_id uuid;
  v_current_owner uuid;
  v_wallet wallets%ROWTYPE;
  v_listing marketplace_listings%ROWTYPE;
  v_listing_type text;
  v_buy_now_price numeric;
  v_royalty_pct numeric;
  v_increment numeric;
  v_expires timestamptz;
  v_max_days integer;
  v_min_price numeric;
BEGIN
  SELECT * INTO s FROM market_settings WHERE id;
  IF p_seller_id IS NULL OR p_seller_id <> auth.uid() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF EXISTS (SELECT 1 FROM account_deletion_requests WHERE user_id = p_seller_id AND status = 'pending') THEN
    RAISE EXCEPTION 'This account is being deleted';
  END IF;
  IF p_item_type NOT IN ('stories', 'memes', 'puzzles', 'kids_collections', 'music_box', 'podcast_box', 'tv_box') THEN
    RAISE EXCEPTION 'Invalid item_type: %', p_item_type;
  END IF;

  SELECT * INTO v_cur FROM marketplace_currencies WHERE code = COALESCE(p_listing_currency, 'USD') AND is_enabled;
  IF NOT FOUND THEN RAISE EXCEPTION 'That currency isn''t available for listings'; END IF;

  -- Minimum price: the equivalent of $1 (needs a fresh rate for non-USD).
  v_min_price := market_convert(1, 'USD', v_cur.code);
  IF p_asking_price IS NULL OR p_asking_price < v_min_price THEN
    RAISE EXCEPTION 'Starting price must be at least %', market_money(v_min_price, v_cur.code);
  END IF;
  IF p_reserve_price IS NOT NULL AND p_reserve_price < 0 THEN
    RAISE EXCEPTION 'reserve_price cannot be negative';
  END IF;
  v_increment := COALESCE(p_minimum_increment, v_min_price);
  IF v_increment <= 0 THEN
    RAISE EXCEPTION 'minimum_increment must be greater than 0';
  END IF;

  v_listing_type := COALESCE(p_listing_type, CASE WHEN p_buy_now_price IS NOT NULL THEN 'auction_buy_now' ELSE 'auction' END);
  IF v_listing_type NOT IN ('auction', 'auction_buy_now', 'fixed_price') THEN
    RAISE EXCEPTION 'Invalid listing_type: %', v_listing_type;
  END IF;

  v_buy_now_price := p_buy_now_price;
  IF v_listing_type = 'fixed_price' THEN
    v_buy_now_price := COALESCE(v_buy_now_price, p_asking_price);
  END IF;
  IF v_listing_type = 'auction' AND v_buy_now_price IS NOT NULL THEN
    RAISE EXCEPTION 'An auction listing (no instant purchase) cannot have a buy_now_price -- use auction_buy_now instead';
  END IF;
  IF v_listing_type IN ('auction_buy_now', 'fixed_price') AND (v_buy_now_price IS NULL OR v_buy_now_price < v_min_price) THEN
    RAISE EXCEPTION 'buy_now_price is required for listing_type %', v_listing_type;
  END IF;
  IF v_listing_type = 'auction_buy_now' AND v_buy_now_price < p_asking_price THEN
    RAISE EXCEPTION 'Buy Now price can''t be below the starting bid';
  END IF;

  -- Every listing ends.
  v_max_days := CASE WHEN v_listing_type = 'fixed_price' THEN s.fixed_max_days ELSE s.auction_max_days END;
  v_expires := COALESCE(p_expires_at, now() + make_interval(days => s.auction_default_days));
  IF v_expires < now() + interval '1 hour' OR v_expires > now() + make_interval(days => v_max_days) THEN
    RAISE EXCEPTION 'A listing must run between 1 hour and % days', v_max_days;
  END IF;

  EXECUTE format('SELECT author_id FROM %I WHERE id = $1', p_item_type) INTO v_author_id USING p_item_id;
  IF v_author_id IS NULL THEN
    RAISE EXCEPTION 'Item not found';
  END IF;

  SELECT to_user_id INTO v_current_owner FROM marketplace_ownership_history
    WHERE item_type = p_item_type AND item_id = p_item_id
    ORDER BY transferred_at DESC LIMIT 1;
  IF NOT FOUND THEN
    v_current_owner := v_author_id;
  END IF;
  IF v_current_owner IS NULL OR v_current_owner <> p_seller_id THEN
    RAISE EXCEPTION 'You do not own this item';
  END IF;

  -- Royalty: the creator chooses it while they still own the item; once it
  -- has sold, the rate locked in at the first sale applies to every resale.
  IF p_seller_id = v_author_id AND NOT EXISTS (
    SELECT 1 FROM marketplace_ownership_history WHERE item_type = p_item_type AND item_id = p_item_id
  ) THEN
    v_royalty_pct := COALESCE(p_royalty_pct, s.royalty_default_pct);
    IF v_royalty_pct < 0 OR v_royalty_pct > s.royalty_max_pct THEN
      RAISE EXCEPTION 'Royalty must be between 0%% and %', s.royalty_max_pct || '%';
    END IF;
  ELSE
    SELECT l.royalty_pct INTO v_royalty_pct
      FROM marketplace_ownership_history h
      JOIN marketplace_listings l ON l.id = h.listing_id
      WHERE h.item_type = p_item_type AND h.item_id = p_item_id
      ORDER BY h.transferred_at ASC LIMIT 1;
    v_royalty_pct := LEAST(GREATEST(COALESCE(v_royalty_pct, s.royalty_default_pct), 0), s.royalty_max_pct);
  END IF;

  PERFORM ensure_wallet(p_seller_id);
  SELECT * INTO v_wallet FROM wallets WHERE user_id = p_seller_id FOR UPDATE;
  IF wallet_available_balance(v_wallet.id) < v_listing_fee THEN
    RAISE EXCEPTION 'Insufficient credits for the listing fee ($% required)', v_listing_fee;
  END IF;

  INSERT INTO marketplace_listings (
    item_type, item_id, seller_id, creator_id, asking_price, buy_now_price,
    reserve_price, minimum_increment, royalty_pct, expires_at, listing_fee_paid, listing_type, listing_currency
  ) VALUES (
    p_item_type, p_item_id, p_seller_id, v_author_id, ROUND(p_asking_price, 2), ROUND(v_buy_now_price, 2),
    ROUND(p_reserve_price, 2), v_increment, v_royalty_pct, v_expires, v_listing_fee, v_listing_type, v_cur.code
  ) RETURNING * INTO v_listing;

  UPDATE wallets SET wallet_balance = wallet_balance - v_listing_fee, updated_at = now()
    WHERE id = v_wallet.id;
  INSERT INTO wallet_ledger (wallet_id, transaction_type, debit, credit, balance_before, balance_after, reference_id)
    VALUES (v_wallet.id, 'marketplace_listing_fee', v_listing_fee, 0,
            v_wallet.wallet_balance, v_wallet.wallet_balance - v_listing_fee, v_listing.id);
  INSERT INTO wallet_transactions (wallet_id, type, amount, description, status, currency_code, metadata)
    VALUES (v_wallet.id, 'marketplace_listing_fee', -v_listing_fee, 'Marketplace listing fee', 'completed', 'USD',
            jsonb_build_object('listing_id', v_listing.id, 'item_type', v_listing.item_type, 'item_id', v_listing.item_id));

  PERFORM record_revenue(
    p_source => 'marketplace_listing', p_user_id => p_seller_id, p_reference_id => v_listing.id,
    p_gross_amount => v_listing_fee, p_revenue_amount => v_listing_fee, p_currency => 'USD',
    p_payment_method => 'wallet', p_original_currency => 'USD', p_original_amount => v_listing_fee,
    p_metadata => jsonb_build_object('item_type', v_listing.item_type, 'item_id', v_listing.item_id)
  );

  RETURN v_listing;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.create_marketplace_listing(text, uuid, uuid, numeric, numeric, numeric, numeric, numeric, timestamptz, text, text) TO authenticated;

-- Credit-funded bidding and buying are retired: items are paid for with
-- marketplace money only (Google Play credits can never reach a withdrawal).
REVOKE EXECUTE ON FUNCTION public.place_marketplace_bid(uuid, uuid, numeric, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.accept_marketplace_bid(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.accept_marketplace_buy_now(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Lowest amount (in the listing currency) the next bid must be.
CREATE OR REPLACE FUNCTION public.market_min_bid(p_listing_id uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN MAX(b.amount) IS NULL THEN l.asking_price ELSE MAX(b.amount) + l.minimum_increment END
  FROM marketplace_listings l
  LEFT JOIN marketplace_bids b ON b.listing_id = l.id AND b.status = 'active'
  WHERE l.id = p_listing_id
  GROUP BY l.asking_price, l.minimum_increment;
$$;
GRANT EXECUTE ON FUNCTION public.market_min_bid(uuid) TO anon, authenticated;

-- What paying p_amount (listing currency) on this listing costs right now, in
-- the settlement currency.
CREATE OR REPLACE FUNCTION public.market_quote(p_listing_id uuid, p_amount numeric)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_l marketplace_listings%ROWTYPE;
  v_settle text;
  v_amount numeric;
  v_fee numeric;
BEGIN
  SELECT * INTO v_l FROM marketplace_listings WHERE id = p_listing_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Listing not found'; END IF;
  v_settle := market_settle_currency(v_l.listing_currency);
  v_amount := market_convert(p_amount, v_l.listing_currency, v_settle);
  v_fee := market_bid_fee(v_amount, v_settle);
  RETURN jsonb_build_object(
    'listing_currency', v_l.listing_currency, 'amount', ROUND(p_amount, 2),
    'settle_currency', v_settle, 'settle_amount', v_amount, 'fee', v_fee, 'total', v_amount + v_fee,
    'rate', CASE WHEN v_l.listing_currency = v_settle THEN NULL ELSE market_rate(v_l.listing_currency) END,
    'payment_methods', (SELECT payment_methods FROM marketplace_currencies WHERE code = v_l.listing_currency));
END;
$$;
GRANT EXECUTE ON FUNCTION public.market_quote(uuid, numeric) TO anon, authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 7. Bidding and buying with marketplace money
-- ════════════════════════════════════════════════════════════════════════════

-- Places a paid bid from the caller's funds in the listing's settlement
-- currency: the bid is held in escrow and the bid fee is charged. GBP/EUR/GHS
-- bids are converted to USD once, here, and the rate is recorded on the bid.
CREATE OR REPLACE FUNCTION public.place_cash_bid(p_listing_id uuid, p_amount numeric)
RETURNS marketplace_bids LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s market_settings%ROWTYPE;
  v_uid uuid := auth.uid();
  v_listing marketplace_listings%ROWTYPE;
  v_settle text;
  v_settle_amount numeric;
  v_min numeric;
  v_fee numeric;
  v_bid marketplace_bids%ROWTYPE;
  v_prev record;
BEGIN
  SELECT * INTO s FROM market_settings WHERE id;
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF EXISTS (SELECT 1 FROM account_deletion_requests WHERE user_id = v_uid AND status = 'pending') THEN
    RAISE EXCEPTION 'This account is being deleted';
  END IF;
  p_amount := ROUND(p_amount, 2);

  SELECT * INTO v_listing FROM marketplace_listings WHERE id = p_listing_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Listing not found'; END IF;
  IF v_listing.status <> 'active' OR (v_listing.expires_at IS NOT NULL AND v_listing.expires_at <= now()) THEN
    RAISE EXCEPTION 'Bidding on this listing has closed';
  END IF;
  IF v_listing.listing_type = 'fixed_price' THEN
    RAISE EXCEPTION 'This is a fixed-price listing. Use Buy Now instead.';
  END IF;
  IF v_listing.seller_id = v_uid THEN RAISE EXCEPTION 'You can''t bid on your own listing'; END IF;
  IF v_listing.buy_now_price IS NOT NULL AND p_amount >= v_listing.buy_now_price THEN
    RAISE EXCEPTION 'Your bid reaches the Buy Now price. Use Buy Now instead.';
  END IF;

  v_min := market_min_bid(p_listing_id);
  IF p_amount IS NULL OR p_amount < v_min THEN
    RAISE EXCEPTION 'Bid must be at least %', market_money(v_min, v_listing.listing_currency);
  END IF;
  IF (SELECT count(*) FROM marketplace_bids WHERE bidder_id = v_uid AND status = 'active') >= s.max_active_bids THEN
    RAISE EXCEPTION 'You have too many open bids. Wait for some to close.';
  END IF;

  v_settle := market_settle_currency(v_listing.listing_currency);
  v_settle_amount := market_convert(p_amount, v_listing.listing_currency, v_settle);
  v_fee := market_bid_fee(v_settle_amount, v_settle);

  -- Raising your own bid: the earlier one is refunded (its fee is kept).
  FOR v_prev IN SELECT id FROM marketplace_bids
    WHERE listing_id = p_listing_id AND bidder_id = v_uid AND status = 'active' FOR UPDATE
  LOOP
    UPDATE marketplace_bids SET status = 'superseded', decided_at = now() WHERE id = v_prev.id;
  END LOOP;

  INSERT INTO marketplace_bids (listing_id, bidder_id, amount, status, expires_at, funding, fee_amount,
                                settle_currency, settle_amount, fx_rate)
    VALUES (p_listing_id, v_uid, p_amount, 'active',
            v_listing.expires_at + make_interval(hours => s.decision_hours), 'cash', v_fee,
            v_settle, v_settle_amount,
            CASE WHEN v_listing.listing_currency = v_settle THEN NULL ELSE market_rate(v_listing.listing_currency) END)
    RETURNING * INTO v_bid;

  PERFORM market_take_funds(v_uid, v_settle, v_settle_amount, 'bid', v_bid.id, NULL);
  PERFORM market_take_funds(v_uid, v_settle, v_fee, 'fee', v_bid.id, NULL);

  INSERT INTO market_ledger (user_id, bucket, kind, currency, amount, reference_id) VALUES
    (v_uid, 'funds', 'bid_escrow', v_settle, -v_settle_amount, v_bid.id),
    (v_uid, 'funds', 'bid_fee', v_settle, -v_fee, v_bid.id),
    (NULL, 'platform', 'bid_fee', v_settle, v_fee, v_bid.id);
  PERFORM record_revenue(
    p_source => 'marketplace_bid_fee', p_user_id => v_uid, p_reference_id => v_bid.id,
    p_gross_amount => v_settle_amount, p_revenue_amount => v_fee, p_currency => v_settle,
    p_payment_method => 'marketplace_funds', p_original_currency => v_listing.listing_currency, p_original_amount => p_amount,
    p_metadata => jsonb_build_object('listing_id', p_listing_id));

  PERFORM market_notify(v_listing.seller_id, 'marketplace_bid_received', 'New paid bid',
    'Someone bid ' || market_money(p_amount, v_listing.listing_currency) || ' on your listing.', p_listing_id);
  RETURN v_bid;
END;
$$;
GRANT EXECUTE ON FUNCTION public.place_cash_bid(uuid, numeric) TO authenticated;

-- The sale itself: escrowed money (settlement currency) becomes the seller's
-- and creator's earnings (after clearing) and the platform's fee.
CREATE OR REPLACE FUNCTION public.settle_cash_sale(
  p_listing_id uuid, p_buyer_id uuid, p_listing_amount numeric, p_settle_amount numeric, p_bid_id uuid
) RETURNS marketplace_ownership_history LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s market_settings%ROWTYPE;
  v_listing marketplace_listings%ROWTYPE;
  v_cur text;
  v_platform_fee numeric;
  v_royalty numeric;
  v_proceeds numeric;
  v_history marketplace_ownership_history%ROWTYPE;
  v_available_at timestamptz;
BEGIN
  SELECT * INTO s FROM market_settings WHERE id;
  SELECT * INTO v_listing FROM marketplace_listings WHERE id = p_listing_id;
  v_cur := market_settle_currency(v_listing.listing_currency);
  v_available_at := now() + make_interval(days => s.clearing_days);

  v_platform_fee := ROUND(p_settle_amount * s.platform_fee_pct / 100, 2);
  v_royalty := CASE
    WHEN v_listing.creator_id IS NULL OR v_listing.creator_id = v_listing.seller_id THEN 0
    ELSE ROUND(p_settle_amount * LEAST(GREATEST(v_listing.royalty_pct, 0), s.royalty_max_pct) / 100, 2)
  END;
  v_proceeds := p_settle_amount - v_platform_fee - v_royalty;
  IF v_proceeds < 0 THEN RAISE EXCEPTION 'Invalid fee split'; END IF;

  INSERT INTO marketplace_ownership_history (
    item_type, item_id, listing_id, bid_id, from_user_id, to_user_id,
    sale_price, platform_fee_pct, platform_fee_amount, royalty_amount, royalty_recipient_id, seller_proceeds, settle_currency
  ) VALUES (
    v_listing.item_type, v_listing.item_id, v_listing.id, p_bid_id, v_listing.seller_id, p_buyer_id,
    p_settle_amount, s.platform_fee_pct, v_platform_fee, v_royalty,
    CASE WHEN v_royalty > 0 THEN v_listing.creator_id END, v_proceeds, v_cur
  ) RETURNING * INTO v_history;

  IF v_proceeds > 0 AND v_listing.seller_id IS NOT NULL THEN
    INSERT INTO market_earnings (user_id, kind, currency, amount, available_at, listing_id, ownership_id)
      VALUES (v_listing.seller_id, 'sale', v_cur, v_proceeds, v_available_at, v_listing.id, v_history.id);
  END IF;
  IF v_royalty > 0 THEN
    INSERT INTO market_earnings (user_id, kind, currency, amount, available_at, listing_id, ownership_id)
      VALUES (v_listing.creator_id, 'royalty', v_cur, v_royalty, v_available_at, v_listing.id, v_history.id);
  END IF;

  INSERT INTO market_ledger (user_id, bucket, kind, currency, amount, reference_id, meta) VALUES
    (v_listing.seller_id, 'earnings', 'sale_proceeds', v_cur, v_proceeds, v_history.id,
     jsonb_build_object('listing_currency', v_listing.listing_currency, 'listing_amount', p_listing_amount)),
    (NULL, 'platform', 'commission', v_cur, v_platform_fee, v_history.id, '{}'::jsonb);
  IF v_royalty > 0 THEN
    INSERT INTO market_ledger (user_id, bucket, kind, currency, amount, reference_id)
      VALUES (v_listing.creator_id, 'earnings', 'royalty', v_cur, v_royalty, v_history.id);
  END IF;

  PERFORM record_revenue(
    p_source => 'marketplace_commission', p_user_id => v_listing.seller_id, p_reference_id => v_listing.id,
    p_gross_amount => p_settle_amount, p_revenue_amount => v_platform_fee, p_currency => v_cur,
    p_payment_method => 'marketplace_funds', p_original_currency => v_listing.listing_currency, p_original_amount => p_listing_amount,
    p_metadata => jsonb_build_object('listing_id', v_listing.id, 'bid_id', p_bid_id, 'buyer_id', p_buyer_id));

  UPDATE marketplace_listings SET status = 'sold', updated_at = now() WHERE id = v_listing.id;

  PERFORM market_notify(v_listing.seller_id, 'marketplace_sold', 'Sold!',
    'Your item sold. ' || market_money(v_proceeds, v_cur) || ' is in your earnings and can be withdrawn after '
    || s.clearing_days || ' days.', v_listing.id);
  PERFORM market_notify(p_buyer_id, 'marketplace_won', 'You own it',
    'Your purchase went through. The item is now yours.', v_listing.id);
  IF v_royalty > 0 THEN
    PERFORM market_notify(v_listing.creator_id, 'marketplace_royalty', 'Royalty earned',
      'Your work was resold. You earned a ' || market_money(v_royalty, v_cur) || ' royalty.', v_listing.id);
  END IF;
  RETURN v_history;
END;
$$;
REVOKE ALL ON FUNCTION public.settle_cash_sale(uuid, uuid, numeric, numeric, uuid) FROM PUBLIC, anon, authenticated;

-- Accept one bid: internal so both the owner and the deadline job use it.
CREATE OR REPLACE FUNCTION public.market_accept_bid_internal(p_bid_id uuid)
RETURNS marketplace_ownership_history LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_bid marketplace_bids%ROWTYPE;
  v_listing marketplace_listings%ROWTYPE;
  v_escrow numeric;
  v_history marketplace_ownership_history%ROWTYPE;
BEGIN
  SELECT * INTO v_bid FROM marketplace_bids WHERE id = p_bid_id FOR UPDATE;
  IF NOT FOUND OR v_bid.status <> 'active' OR v_bid.funding <> 'cash' THEN
    RAISE EXCEPTION 'Bid is not active';
  END IF;
  SELECT * INTO v_listing FROM marketplace_listings WHERE id = v_bid.listing_id FOR UPDATE;
  IF v_listing.status NOT IN ('active', 'awaiting_decision') THEN
    RAISE EXCEPTION 'Listing is closed';
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_escrow FROM market_lot_allocations
    WHERE bid_id = v_bid.id AND purpose = 'bid' AND NOT released;
  IF v_escrow < v_bid.settle_amount THEN
    RAISE EXCEPTION 'This bid is not fully funded';
  END IF;

  UPDATE marketplace_bids SET status = 'accepted', decided_at = now() WHERE id = v_bid.id;
  v_history := settle_cash_sale(v_listing.id, v_bid.bidder_id, v_bid.amount, v_bid.settle_amount, v_bid.id);
  -- settle_cash_sale marks the listing sold; the close trigger refunds every other bid.
  RETURN v_history;
END;
$$;
REVOKE ALL ON FUNCTION public.market_accept_bid_internal(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.accept_cash_bid(p_bid_id uuid)
RETURNS marketplace_ownership_history LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_listing marketplace_listings%ROWTYPE;
BEGIN
  SELECT l.* INTO v_listing FROM marketplace_listings l JOIN marketplace_bids b ON b.listing_id = l.id WHERE b.id = p_bid_id;
  IF NOT FOUND OR v_listing.seller_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF v_listing.status = 'awaiting_decision' AND v_listing.decision_deadline <= now() THEN
    RAISE EXCEPTION 'The decision window for this listing has passed';
  END IF;
  RETURN market_accept_bid_internal(p_bid_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.accept_cash_bid(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.buy_now_cash(p_listing_id uuid)
RETURNS marketplace_ownership_history LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_listing marketplace_listings%ROWTYPE;
  v_settle text;
  v_amount numeric;
  v_fee numeric;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF EXISTS (SELECT 1 FROM account_deletion_requests WHERE user_id = v_uid AND status = 'pending') THEN
    RAISE EXCEPTION 'This account is being deleted';
  END IF;
  SELECT * INTO v_listing FROM marketplace_listings WHERE id = p_listing_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Listing not found'; END IF;
  IF v_listing.status <> 'active' OR (v_listing.expires_at IS NOT NULL AND v_listing.expires_at <= now()) THEN
    RAISE EXCEPTION 'This listing has closed';
  END IF;
  IF v_listing.buy_now_price IS NULL THEN RAISE EXCEPTION 'This listing has no Buy Now price'; END IF;
  IF v_listing.seller_id = v_uid THEN RAISE EXCEPTION 'You can''t buy your own listing'; END IF;

  v_settle := market_settle_currency(v_listing.listing_currency);
  v_amount := market_convert(v_listing.buy_now_price, v_listing.listing_currency, v_settle);
  v_fee := market_bid_fee(v_amount, v_settle);
  PERFORM market_take_funds(v_uid, v_settle, v_amount, 'purchase', NULL, NULL);
  PERFORM market_take_funds(v_uid, v_settle, v_fee, 'fee', NULL, NULL);
  INSERT INTO market_ledger (user_id, bucket, kind, currency, amount, reference_id) VALUES
    (v_uid, 'funds', 'purchase', v_settle, -v_amount, v_listing.id),
    (v_uid, 'funds', 'purchase_fee', v_settle, -v_fee, v_listing.id),
    (NULL, 'platform', 'purchase_fee', v_settle, v_fee, v_listing.id);
  PERFORM record_revenue(
    p_source => 'marketplace_bid_fee', p_user_id => v_uid, p_reference_id => v_listing.id,
    p_gross_amount => v_amount, p_revenue_amount => v_fee, p_currency => v_settle,
    p_payment_method => 'marketplace_funds', p_original_currency => v_listing.listing_currency,
    p_original_amount => v_listing.buy_now_price, p_metadata => jsonb_build_object('listing_id', p_listing_id, 'buy_now', true));

  RETURN settle_cash_sale(v_listing.id, v_uid, v_listing.buy_now_price, v_amount, NULL);
END;
$$;
GRANT EXECUTE ON FUNCTION public.buy_now_cash(uuid) TO authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 8. Deadlines (run every 5 minutes by pg_cron; also callable by the backend)
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.process_marketplace_deadlines()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s market_settings%ROWTYPE;
  v_l record;
  v_top record;
  n_reminded int := 0; n_awaiting int := 0; n_expired int := 0; n_auto_sold int := 0; n_unfeatured int := 0;
BEGIN
  SELECT * INTO s FROM market_settings WHERE id;

  -- 24h warning to owners of listings with bids.
  FOR v_l IN
    SELECT l.id, l.seller_id FROM marketplace_listings l
    WHERE l.status = 'active' AND NOT l.ending_reminder_sent
      AND l.expires_at <= now() + interval '24 hours' AND l.expires_at > now()
      AND EXISTS (SELECT 1 FROM marketplace_bids b WHERE b.listing_id = l.id AND b.status = 'active')
    FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE marketplace_listings SET ending_reminder_sent = true WHERE id = v_l.id;
    PERFORM market_notify(v_l.seller_id, 'marketplace_ending', 'Your listing ends within 24 hours',
      'You have paid bids waiting. Accept one, or after it ends you get ' || s.decision_hours
      || ' hours before the highest bid wins automatically.', v_l.id);
    n_reminded := n_reminded + 1;
  END LOOP;

  -- Ended listings: with bids -> owner's decision window; without -> expired.
  FOR v_l IN
    SELECT l.id, l.seller_id, l.expires_at FROM marketplace_listings l
    WHERE l.status = 'active' AND l.expires_at IS NOT NULL AND l.expires_at <= now()
    FOR UPDATE SKIP LOCKED
  LOOP
    IF EXISTS (SELECT 1 FROM marketplace_bids WHERE listing_id = v_l.id AND status = 'active') THEN
      UPDATE marketplace_listings SET status = 'awaiting_decision',
        decision_deadline = v_l.expires_at + make_interval(hours => s.decision_hours), updated_at = now()
        WHERE id = v_l.id;
      PERFORM market_notify(v_l.seller_id, 'marketplace_decide', 'Choose a winning bid',
        'Your listing has ended. Accept a bid within ' || s.decision_hours
        || ' hours, or the highest bid that meets your reserve wins automatically.', v_l.id);
      n_awaiting := n_awaiting + 1;
    ELSE
      UPDATE marketplace_listings SET status = 'expired', updated_at = now() WHERE id = v_l.id;
      n_expired := n_expired + 1;
    END IF;
  END LOOP;

  -- Decision window over: highest bid meeting the reserve wins, else refund all.
  -- Bids and the reserve are both in the listing currency.
  FOR v_l IN
    SELECT l.id, l.reserve_price FROM marketplace_listings l
    WHERE l.status = 'awaiting_decision' AND l.decision_deadline <= now()
    FOR UPDATE SKIP LOCKED
  LOOP
    SELECT b.id INTO v_top FROM marketplace_bids b
      WHERE b.listing_id = v_l.id AND b.status = 'active' AND b.funding = 'cash'
        AND b.amount >= COALESCE(v_l.reserve_price, 0)
      ORDER BY b.amount DESC, b.created_at ASC LIMIT 1;
    IF FOUND THEN
      PERFORM market_accept_bid_internal(v_top.id);
      n_auto_sold := n_auto_sold + 1;
    ELSE
      UPDATE marketplace_listings SET status = 'expired', updated_at = now() WHERE id = v_l.id;
      n_expired := n_expired + 1;
    END IF;
  END LOOP;

  UPDATE marketplace_listings SET featured = false, updated_at = now()
    WHERE featured AND featured_until IS NOT NULL AND featured_until <= now();
  GET DIAGNOSTICS n_unfeatured = ROW_COUNT;

  -- Abandoned payment sessions.
  UPDATE market_payments SET status = 'failed', provider_data = jsonb_build_object('reason', 'expired')
    WHERE status = 'pending' AND expires_at <= now();

  RETURN jsonb_build_object('reminded', n_reminded, 'awaiting_decision', n_awaiting,
    'expired', n_expired, 'auto_sold', n_auto_sold, 'unfeatured', n_unfeatured);
END;
$$;
REVOKE ALL ON FUNCTION public.process_marketplace_deadlines() FROM PUBLIC, anon, authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 9. Withdrawals
-- ════════════════════════════════════════════════════════════════════════════

-- Payout accounts are saved by the backend after it has verified them
-- (Paystack account lookup for banks; format check for USDT addresses).
CREATE OR REPLACE FUNCTION public.save_payout_account(
  p_user_id uuid, p_method text, p_bank_code text, p_bank_name text, p_account_number text,
  p_account_name text, p_recipient_code text, p_usdt_address text
) RETURNS payout_accounts LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row payout_accounts%ROWTYPE;
BEGIN
  IF EXISTS (SELECT 1 FROM market_withdrawals w JOIN payout_accounts a ON a.id = w.payout_account_id
             WHERE a.user_id = p_user_id AND a.method = p_method AND w.status IN ('pending', 'processing')) THEN
    RAISE EXCEPTION 'You can''t change this payout account while a withdrawal to it is in progress';
  END IF;
  UPDATE payout_accounts SET is_active = false WHERE user_id = p_user_id AND method = p_method AND is_active;
  INSERT INTO payout_accounts (user_id, method, bank_code, bank_name, account_number, account_name, recipient_code, usdt_address)
    VALUES (p_user_id, p_method, p_bank_code, p_bank_name, p_account_number, p_account_name, p_recipient_code, p_usdt_address)
    RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;
REVOKE ALL ON FUNCTION public.save_payout_account(uuid, text, text, text, text, text, text, text) FROM PUBLIC, anon, authenticated;

-- Earnings go to a verified payout account: naira earnings only to a naira
-- bank account; dollar earnings to a USDT address or a naira bank account
-- (converted at payout). Funds always go back to their source.
CREATE OR REPLACE FUNCTION public.request_market_withdrawal(
  p_bucket text, p_currency text, p_amount numeric, p_payout_account_id uuid DEFAULT NULL
) RETURNS market_withdrawals LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s market_settings%ROWTYPE;
  v_uid uuid := auth.uid();
  v_acc payout_accounts%ROWTYPE;
  v_e record;
  v_w market_withdrawals%ROWTYPE;
  v_min numeric;
BEGIN
  SELECT * INTO s FROM market_settings WHERE id;
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF NOT s.payouts_enabled THEN RAISE EXCEPTION 'Withdrawals are paused right now'; END IF;
  IF p_currency NOT IN ('USD', 'NGN') THEN RAISE EXCEPTION 'Unknown currency'; END IF;
  p_amount := ROUND(p_amount, 2);
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'Enter an amount'; END IF;

  -- One request at a time.
  PERFORM 1 FROM profiles WHERE id = v_uid FOR UPDATE;
  IF EXISTS (SELECT 1 FROM market_withdrawals WHERE user_id = v_uid AND status IN ('pending', 'processing')) THEN
    RAISE EXCEPTION 'You already have a withdrawal in progress';
  END IF;

  IF p_bucket = 'earnings' THEN
    v_min := market_convert(s.min_withdrawal_usd, 'USD', p_currency);
    IF p_amount < v_min THEN
      RAISE EXCEPTION 'Minimum withdrawal is %', market_money(v_min, p_currency);
    END IF;
    SELECT * INTO v_acc FROM payout_accounts WHERE id = p_payout_account_id AND user_id = v_uid AND is_active;
    IF NOT FOUND THEN RAISE EXCEPTION 'Add a verified payout account first'; END IF;
    IF p_currency = 'NGN' AND v_acc.method <> 'bank_ngn' THEN
      RAISE EXCEPTION 'Naira earnings are paid to a Nigerian bank account';
    END IF;
    SELECT * INTO v_e FROM market_earnings_summary(v_uid, p_currency);
    IF p_amount > v_e.withdrawable THEN
      RAISE EXCEPTION 'You can withdraw up to % right now (% is still clearing)',
        market_money(v_e.withdrawable, p_currency), market_money(v_e.pending, p_currency);
    END IF;
    INSERT INTO market_withdrawals (user_id, bucket, currency, amount, payout_account_id, payout_details)
      VALUES (v_uid, 'earnings', p_currency, p_amount, v_acc.id,
              jsonb_build_object('method', v_acc.method, 'bank_name', v_acc.bank_name, 'account_number', v_acc.account_number,
                                 'account_name', v_acc.account_name, 'recipient_code', v_acc.recipient_code,
                                 'usdt_address', v_acc.usdt_address))
      RETURNING * INTO v_w;
    INSERT INTO market_ledger (user_id, bucket, kind, currency, amount, reference_id)
      VALUES (v_uid, 'earnings', 'withdrawal_requested', p_currency, -p_amount, v_w.id);
  ELSIF p_bucket = 'funds' THEN
    v_min := market_convert(s.min_payment_usd, 'USD', p_currency);
    IF p_amount < v_min THEN
      RAISE EXCEPTION 'Minimum refund is %', market_money(v_min, p_currency);
    END IF;
    INSERT INTO market_withdrawals (user_id, bucket, currency, amount)
      VALUES (v_uid, 'funds', p_currency, p_amount) RETURNING * INTO v_w;
    PERFORM market_take_funds(v_uid, p_currency, p_amount, 'withdrawal', NULL, v_w.id);
    INSERT INTO market_ledger (user_id, bucket, kind, currency, amount, reference_id)
      VALUES (v_uid, 'funds', 'refund_requested', p_currency, -p_amount, v_w.id);
  ELSE
    RAISE EXCEPTION 'Unknown balance';
  END IF;

  INSERT INTO notifications (user_id, type, title, body, reference_id)
    SELECT a.user_id, 'admin_withdrawal_request', 'Withdrawal request',
           market_money(p_amount, p_currency) || ' (' || p_bucket || ') is waiting for review.', v_w.id
    FROM app_admins a;
  RETURN v_w;
END;
$$;
GRANT EXECUTE ON FUNCTION public.request_market_withdrawal(text, text, numeric, uuid) TO authenticated;

-- For a funds withdrawal: which payments it refunds, and how much of each in
-- the lot's currency (the backend refunds each one to its source).
CREATE OR REPLACE FUNCTION public.market_withdrawal_sources(p_withdrawal_id uuid)
RETURNS TABLE (payment_id uuid, method text, currency text, amount numeric, paystack_reference text, fx_rate numeric,
               usdt_network text, usdt_sender text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.id, p.method, l.currency, SUM(a.amount), p.paystack_reference, p.fx_rate, p.usdt_network, p.usdt_sender
  FROM market_lot_allocations a
  JOIN market_fund_lots l ON l.id = a.lot_id
  JOIN market_payments p ON p.id = l.payment_id
  WHERE a.withdrawal_id = p_withdrawal_id AND a.purpose = 'withdrawal' AND NOT a.released
  GROUP BY p.id, p.method, l.currency, p.paystack_reference, p.fx_rate, p.usdt_network, p.usdt_sender;
$$;
REVOKE ALL ON FUNCTION public.market_withdrawal_sources(uuid) FROM PUBLIC, anon, authenticated;

-- Admin: reject puts the money back. Approve hands it to the backend to pay
-- (status 'processing'); the backend then calls market_complete_withdrawal or
-- market_fail_withdrawal. Manual payouts use market_complete_withdrawal with
-- the bank / chain reference.
CREATE OR REPLACE FUNCTION public.market_decide_withdrawal(p_withdrawal_id uuid, p_approve boolean, p_note text, p_admin_id uuid)
RETURNS market_withdrawals LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_w market_withdrawals%ROWTYPE;
  v_restored numeric;
BEGIN
  IF NOT is_app_admin(p_admin_id) THEN RAISE EXCEPTION 'Admins only'; END IF;
  SELECT * INTO v_w FROM market_withdrawals WHERE id = p_withdrawal_id FOR UPDATE;
  IF NOT FOUND OR v_w.status <> 'pending' THEN RAISE EXCEPTION 'Withdrawal is not pending'; END IF;
  IF v_w.user_id = p_admin_id THEN RAISE EXCEPTION 'You can''t approve your own withdrawal'; END IF;

  IF p_approve THEN
    UPDATE market_withdrawals SET status = 'processing', admin_id = p_admin_id, admin_note = p_note, decided_at = now()
      WHERE id = v_w.id RETURNING * INTO v_w;
  ELSE
    IF v_w.bucket = 'funds' THEN
      v_restored := market_release_allocations(NULL, v_w.id, 'withdrawal');
    END IF;
    UPDATE market_withdrawals SET status = 'rejected', admin_id = p_admin_id, admin_note = p_note, decided_at = now()
      WHERE id = v_w.id RETURNING * INTO v_w;
    INSERT INTO market_ledger (user_id, bucket, kind, currency, amount, reference_id)
      VALUES (v_w.user_id, v_w.bucket, 'withdrawal_rejected', v_w.currency, v_w.amount, v_w.id);
    PERFORM market_notify(v_w.user_id, 'withdrawal_rejected', 'Withdrawal declined',
      COALESCE(p_note, 'Your withdrawal was declined.') || ' The money is back in your balance.', v_w.id);
  END IF;
  RETURN v_w;
END;
$$;
REVOKE ALL ON FUNCTION public.market_decide_withdrawal(uuid, boolean, text, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.market_complete_withdrawal(
  p_withdrawal_id uuid, p_provider_ref text, p_amount_paid numeric, p_currency_paid text, p_fx_rate numeric, p_admin_id uuid DEFAULT NULL
) RETURNS market_withdrawals LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_w market_withdrawals%ROWTYPE;
BEGIN
  SELECT * INTO v_w FROM market_withdrawals WHERE id = p_withdrawal_id FOR UPDATE;
  IF NOT FOUND OR v_w.status <> 'processing' THEN RAISE EXCEPTION 'Withdrawal is not being processed'; END IF;
  IF p_provider_ref IS NULL OR length(trim(p_provider_ref)) < 4 THEN RAISE EXCEPTION 'A payment reference is required'; END IF;
  IF p_admin_id IS NOT NULL AND NOT is_app_admin(p_admin_id) THEN RAISE EXCEPTION 'Admins only'; END IF;

  IF v_w.bucket = 'funds' THEN
    -- Closed out without crediting the lot back: the money left the platform.
    UPDATE market_lot_allocations SET released = true
      WHERE withdrawal_id = v_w.id AND purpose = 'withdrawal' AND NOT released;
  END IF;
  UPDATE market_withdrawals SET status = 'paid', provider_ref = p_provider_ref, amount_paid = p_amount_paid,
    currency_paid = p_currency_paid, fx_rate = p_fx_rate, paid_at = now()
    WHERE id = v_w.id RETURNING * INTO v_w;
  INSERT INTO market_ledger (user_id, bucket, kind, currency, amount, reference_id, meta)
    VALUES (v_w.user_id, v_w.bucket, 'withdrawal_paid', v_w.currency, 0, v_w.id,
            jsonb_build_object('provider_ref', p_provider_ref, 'paid', p_amount_paid, 'paid_currency', p_currency_paid));
  PERFORM market_notify(v_w.user_id, 'withdrawal_paid', 'Withdrawal sent',
    market_money(v_w.amount, v_w.currency) || ' has been sent. Reference: ' || p_provider_ref, v_w.id);
  RETURN v_w;
END;
$$;
REVOKE ALL ON FUNCTION public.market_complete_withdrawal(uuid, text, numeric, text, numeric, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.market_fail_withdrawal(p_withdrawal_id uuid, p_reason text)
RETURNS market_withdrawals LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_w market_withdrawals%ROWTYPE;
BEGIN
  SELECT * INTO v_w FROM market_withdrawals WHERE id = p_withdrawal_id FOR UPDATE;
  IF NOT FOUND OR v_w.status NOT IN ('processing', 'pending') THEN RAISE EXCEPTION 'Withdrawal can''t be failed now'; END IF;
  IF v_w.bucket = 'funds' THEN
    PERFORM market_release_allocations(NULL, v_w.id, 'withdrawal');
  END IF;
  UPDATE market_withdrawals SET status = 'failed', failure_reason = p_reason WHERE id = v_w.id RETURNING * INTO v_w;
  INSERT INTO market_ledger (user_id, bucket, kind, currency, amount, reference_id)
    VALUES (v_w.user_id, v_w.bucket, 'withdrawal_failed', v_w.currency, v_w.amount, v_w.id);
  PERFORM market_notify(v_w.user_id, 'withdrawal_failed', 'Withdrawal failed',
    'Your withdrawal couldn''t be sent (' || COALESCE(p_reason, 'unknown reason') || '). The money is back in your balance.', v_w.id);
  RETURN v_w;
END;
$$;
REVOKE ALL ON FUNCTION public.market_fail_withdrawal(uuid, text) FROM PUBLIC, anon, authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 10. Content that other people's money depends on can't be changed or deleted
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.market_item_locked(p_item_type text, p_item_id uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM marketplace_listings WHERE item_type = p_item_type AND item_id = p_item_id
             AND status IN ('active', 'awaiting_decision')) THEN
    RETURN 'listed';
  END IF;
  IF EXISTS (SELECT 1 FROM marketplace_ownership_history WHERE item_type = p_item_type AND item_id = p_item_id) THEN
    RETURN 'sold';
  END IF;
  RETURN NULL;
END;
$$;
GRANT EXECUTE ON FUNCTION public.market_item_locked(text, uuid) TO authenticated;

-- Content row guard. Counters (views/likes/etc.) and timestamps may still
-- change; everything else is frozen once an item is listed or has been sold.
CREATE OR REPLACE FUNCTION public.guard_market_content()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_lock text;
  v_old jsonb;
  v_new jsonb;
  v_key text;
BEGIN
  IF COALESCE(current_setting('app.content_admin_override', true), '') = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  v_lock := market_item_locked(TG_TABLE_NAME, OLD.id);
  IF v_lock IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'This item is % on the marketplace and can''t be deleted, because other people have paid for it.',
      CASE v_lock WHEN 'listed' THEN 'listed' ELSE 'owned by a buyer' END;
  END IF;

  v_old := to_jsonb(OLD);
  v_new := to_jsonb(NEW);
  FOR v_key IN SELECT jsonb_object_keys(v_new) LOOP
    CONTINUE WHEN v_key LIKE '%count%' OR v_key LIKE '%_at' OR v_key IN ('views', 'likes', 'plays', 'rating', 'score');
    IF v_new -> v_key IS DISTINCT FROM v_old -> v_key THEN
      RAISE EXCEPTION 'This item is % on the marketplace, so its content can''t be changed (field: %).',
        CASE v_lock WHEN 'listed' THEN 'listed' ELSE 'owned by a buyer' END, v_key;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['stories','memes','puzzles','kids_collections','music_box','podcast_box','tv_box'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS trg_guard_market_content ON public.%I', t);
      EXECUTE format('CREATE TRIGGER trg_guard_market_content BEFORE UPDATE OR DELETE ON public.%I
                      FOR EACH ROW EXECUTE FUNCTION public.guard_market_content()', t);
    END IF;
  END LOOP;
END $$;

-- Story chapters belong to the story: same rule.
CREATE OR REPLACE FUNCTION public.guard_market_chapter()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_story uuid := COALESCE(NEW.story_id, OLD.story_id);
BEGIN
  IF COALESCE(current_setting('app.content_admin_override', true), '') = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF market_item_locked('stories', v_story) IS NOT NULL THEN
    RAISE EXCEPTION 'This story is on the marketplace or owned by a buyer, so its chapters can''t be changed.';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['chapters','chapter_content'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS trg_guard_market_chapter ON public.%I', t);
      EXECUTE format('CREATE TRIGGER trg_guard_market_chapter BEFORE INSERT OR UPDATE OR DELETE ON public.%I
                      FOR EACH ROW EXECUTE FUNCTION public.guard_market_chapter()', t);
    END IF;
  END LOOP;
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 11. Account deletion (Google Play requirement)
-- ════════════════════════════════════════════════════════════════════════════
-- Step 1 (user, in the app): request_account_deletion() closes everything
--   that involves other people's money and starts refunds/payouts.
-- Step 2 (backend, every 10 minutes): accounts_ready_for_deletion() +
--   finalize_account_deletion() once no money is in flight; then the backend
--   deletes the auth user.

-- Queue the payouts/refunds a deleted account is owed, per currency.
CREATE OR REPLACE FUNCTION public.market_queue_deletion_payouts(p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cur text;
  v_funds numeric;
  v_wd uuid;
  v_e record;
  v_acc payout_accounts%ROWTYPE;
BEGIN
  FOREACH v_cur IN ARRAY ARRAY['USD', 'NGN'] LOOP
    v_funds := market_funds_balance(p_user_id, v_cur);
    IF v_funds > 0 AND NOT EXISTS (SELECT 1 FROM market_withdrawals WHERE user_id = p_user_id AND bucket = 'funds'
                                   AND currency = v_cur AND status IN ('pending', 'processing')) THEN
      INSERT INTO market_withdrawals (user_id, bucket, currency, amount, auto_created, admin_note)
        VALUES (p_user_id, 'funds', v_cur, v_funds, true, 'Account deletion refund') RETURNING id INTO v_wd;
      PERFORM market_take_funds(p_user_id, v_cur, v_funds, 'withdrawal', NULL, v_wd);
    END IF;

    SELECT * INTO v_e FROM market_earnings_summary(p_user_id, v_cur);
    v_acc := NULL;
    SELECT * INTO v_acc FROM payout_accounts
      WHERE user_id = p_user_id AND is_active AND (v_cur = 'USD' OR method = 'bank_ngn')
      ORDER BY created_at DESC LIMIT 1;
    IF v_e.withdrawable > 0 AND v_acc.id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM market_withdrawals WHERE user_id = p_user_id AND bucket = 'earnings'
                       AND currency = v_cur AND status IN ('pending', 'processing')) THEN
      INSERT INTO market_withdrawals (user_id, bucket, currency, amount, payout_account_id, auto_created, admin_note, payout_details)
        VALUES (p_user_id, 'earnings', v_cur, v_e.withdrawable, v_acc.id, true, 'Account deletion payout',
                jsonb_build_object('method', v_acc.method, 'bank_name', v_acc.bank_name, 'account_number', v_acc.account_number,
                                   'account_name', v_acc.account_name, 'recipient_code', v_acc.recipient_code,
                                   'usdt_address', v_acc.usdt_address));
    END IF;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.market_queue_deletion_payouts(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.request_account_deletion()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_l record;
  v_b record;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  INSERT INTO account_deletion_requests (user_id) VALUES (v_uid)
    ON CONFLICT (user_id) DO UPDATE SET status = 'pending', requested_at = now(), completed_at = NULL;

  -- Close the user's open listings; paid bids on them are refunded.
  PERFORM set_config('app.force_cancel', 'on', true);
  FOR v_l IN SELECT id FROM marketplace_listings WHERE seller_id = v_uid AND status IN ('active', 'awaiting_decision') FOR UPDATE LOOP
    UPDATE marketplace_listings SET status = 'cancelled', updated_at = now() WHERE id = v_l.id;
  END LOOP;
  PERFORM set_config('app.force_cancel', 'off', true);

  -- Withdraw the user's own bids (refunded to their funds).
  FOR v_b IN SELECT id FROM marketplace_bids WHERE bidder_id = v_uid AND status = 'active' FOR UPDATE LOOP
    UPDATE marketplace_bids SET status = 'withdrawn', decided_at = now() WHERE id = v_b.id;
  END LOOP;

  PERFORM market_queue_deletion_payouts(v_uid);

  RETURN jsonb_build_object('status', 'pending',
    'message', 'Your account will be deleted once refunds and payouts finish. Earnings still clearing are paid out when they clear.');
END;
$$;
GRANT EXECUTE ON FUNCTION public.request_account_deletion() TO authenticated;

CREATE OR REPLACE FUNCTION public.cancel_account_deletion()
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE account_deletion_requests SET status = 'cancelled' WHERE user_id = auth.uid() AND status = 'pending';
$$;
GRANT EXECUTE ON FUNCTION public.cancel_account_deletion() TO authenticated;

-- Accounts that can be deleted now. Earnings that cleared since the request
-- are queued for payout first. Earnings with no usable payout account, or
-- still unpaid 120 days after the request, are forfeited as the Terms say.
CREATE OR REPLACE FUNCTION public.accounts_ready_for_deletion()
RETURNS TABLE (user_id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_r record;
  v_waiting boolean;
  v_e record;
  v_cur text;
BEGIN
  FOR v_r IN SELECT d.user_id AS uid, d.requested_at FROM account_deletion_requests d WHERE d.status = 'pending' LOOP
    IF v_r.requested_at > now() - interval '120 days' THEN
      PERFORM market_queue_deletion_payouts(v_r.uid);
    END IF;
    CONTINUE WHEN EXISTS (SELECT 1 FROM market_withdrawals w WHERE w.user_id = v_r.uid AND w.status IN ('pending', 'processing'));
    CONTINUE WHEN market_funds_balance(v_r.uid, 'USD') > 0 OR market_funds_balance(v_r.uid, 'NGN') > 0;
    v_waiting := false;
    IF v_r.requested_at > now() - interval '120 days' THEN
      FOREACH v_cur IN ARRAY ARRAY['USD', 'NGN'] LOOP
        SELECT * INTO v_e FROM market_earnings_summary(v_r.uid, v_cur);
        IF v_e.pending > 0 THEN v_waiting := true; END IF;
      END LOOP;
    END IF;
    CONTINUE WHEN v_waiting;
    -- Anything left is forfeited.
    UPDATE market_earnings e SET forfeited = true WHERE e.user_id = v_r.uid AND NOT e.forfeited;
    user_id := v_r.uid;
    RETURN NEXT;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.accounts_ready_for_deletion() FROM PUBLIC, anon, authenticated;

-- Called by the backend right before it deletes the auth user: removes the
-- user's own unsold content (content owned by buyers stays, now credited to
-- "deleted user") and marks the request complete.
CREATE OR REPLACE FUNCTION public.finalize_account_deletion(p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM account_deletion_requests WHERE user_id = p_user_id AND status = 'pending') THEN
    RAISE EXCEPTION 'No pending deletion request';
  END IF;
  FOREACH t IN ARRAY ARRAY['stories','memes','puzzles','kids_collections','music_box','podcast_box','tv_box'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format(
        'DELETE FROM public.%I c WHERE c.author_id = $1
           AND NOT EXISTS (SELECT 1 FROM marketplace_ownership_history h WHERE h.item_type = %L AND h.item_id = c.id)
           AND NOT EXISTS (SELECT 1 FROM marketplace_listings l WHERE l.item_type = %L AND l.item_id = c.id
                           AND l.status IN (''active'',''awaiting_decision''))', t, t, t)
        USING p_user_id;
    END IF;
  END LOOP;
  UPDATE account_deletion_requests SET status = 'completed', completed_at = now() WHERE user_id = p_user_id;
END;
$$;
REVOKE ALL ON FUNCTION public.finalize_account_deletion(uuid) FROM PUBLIC, anon, authenticated;

-- Service-role access for the backend.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION
      public.market_create_payment(uuid, text, text, numeric, jsonb, text),
      public.market_confirm_payment(uuid, numeric, jsonb, text, text, text),
      public.market_fail_payment(uuid, text),
      public.process_marketplace_deadlines(),
      public.save_payout_account(uuid, text, text, text, text, text, text, text),
      public.market_withdrawal_sources(uuid),
      public.market_decide_withdrawal(uuid, boolean, text, uuid),
      public.market_complete_withdrawal(uuid, text, numeric, text, numeric, uuid),
      public.market_fail_withdrawal(uuid, text),
      public.accounts_ready_for_deletion(),
      public.finalize_account_deletion(uuid),
      public.market_funds_balance(uuid, text),
      public.market_earnings_summary(uuid, text)
    TO service_role;
  END IF;
END $$;

-- Deadlines every 5 minutes, inside the database (doesn't depend on the
-- backend being up). Skipped where pg_cron isn't available.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'marketplace-deadlines';
    PERFORM cron.schedule('marketplace-deadlines', '*/5 * * * *', 'SELECT public.process_marketplace_deadlines()');
  END IF;
END $$;

COMMIT;
