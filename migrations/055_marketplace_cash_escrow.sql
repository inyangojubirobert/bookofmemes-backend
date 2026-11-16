-- 055: Real-money marketplace (Paystack NGN + USDT), escrowed paid bids,
--      refunds, deadlines, earnings, withdrawals, admin, account deletion.
--
-- Two kinds of money, never convertible into each other:
--   * Credits (wallets.wallet_balance): bought only with Google Play. They pay
--     for things the platform sells (listing fee, featured listing, ads,
--     premium, AI). Never withdrawable.
--   * Marketplace money (this migration): paid in through Paystack (naira,
--     converted from the USD price) or USDT. It only buys other users' content
--     on the marketplace. Two balances:
--       - funds: money a user paid in and hasn't spent (refunded bids, top-ups
--         left over after a bid moved). Reusable for bids; cashing it out
--         always goes back to where it came from (the same Paystack payment or
--         the same USDT sender address), so stolen cards can't be laundered.
--       - earnings: sale proceeds and creator royalties. Withdrawable to the
--         user's verified bank account or USDT address once cleared.
--
-- Bid rules:
--   * Every bid is paid in full when placed, plus a non-refundable bid fee.
--   * Bids are binding until the listing closes. Raising your own bid
--     refunds your earlier bid (its fee is kept).
--   * The owner can accept any active bid until the decision deadline
--     (listing end + decision window). If they don't, the highest bid that
--     meets the reserve wins automatically. Every other bid is refunded to
--     the bidder's funds.
--   * A listing can't be cancelled while it has paid bids.
--   * Every listing ends: auctions default 7 days (max 14), fixed price max 30.
--
-- Run 054 first. Safe to re-run.

BEGIN;

-- ════════════════════════════════════════════════════════════════════════════
-- 0. Settings, admins, revenue sources
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.market_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  platform_fee_pct     numeric NOT NULL DEFAULT 5,
  bid_fee_pct          numeric NOT NULL DEFAULT 2.5,
  bid_fee_min_usd      numeric NOT NULL DEFAULT 0.25,
  bid_fee_max_usd      numeric NOT NULL DEFAULT 10,
  clearing_days        integer NOT NULL DEFAULT 30,
  fx_spread_pct        numeric NOT NULL DEFAULT 1.5,
  fx_max_age_hours     integer NOT NULL DEFAULT 12,
  min_withdrawal_usd   numeric NOT NULL DEFAULT 10,
  min_payment_usd      numeric NOT NULL DEFAULT 1,
  auction_default_days integer NOT NULL DEFAULT 7,
  auction_max_days     integer NOT NULL DEFAULT 14,
  fixed_max_days       integer NOT NULL DEFAULT 30,
  decision_hours       integer NOT NULL DEFAULT 48,
  royalty_default_pct  numeric NOT NULL DEFAULT 5,
  royalty_max_pct      numeric NOT NULL DEFAULT 10,
  max_active_bids      integer NOT NULL DEFAULT 20,
  payouts_enabled      boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.market_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
ALTER TABLE public.market_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS market_settings_read ON public.market_settings;
CREATE POLICY market_settings_read ON public.market_settings FOR SELECT USING (true);
REVOKE INSERT, UPDATE, DELETE ON public.market_settings FROM anon, authenticated;

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
  ('marketplace_fx_spread', 'spread', 'exchange', true, 'Spread on naira payments converted to USD (market_settings.fx_spread_pct)')
ON CONFLICT (source) DO NOTHING;

-- Exchange rates, written by the backend (service role) from open.er-api.com.
CREATE TABLE IF NOT EXISTS public.market_fx_rates (
  currency text PRIMARY KEY,
  units_per_usd numeric NOT NULL CHECK (units_per_usd > 0),
  fetched_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.market_fx_rates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS market_fx_rates_read ON public.market_fx_rates;
CREATE POLICY market_fx_rates_read ON public.market_fx_rates FOR SELECT USING (true);
REVOKE INSERT, UPDATE, DELETE ON public.market_fx_rates FROM anon, authenticated;

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
-- 2. Listing lifecycle columns
-- ════════════════════════════════════════════════════════════════════════════

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

-- Paid bids.
ALTER TABLE public.marketplace_bids ADD COLUMN IF NOT EXISTS funding text NOT NULL DEFAULT 'credits';
ALTER TABLE public.marketplace_bids ADD COLUMN IF NOT EXISTS fee_usd numeric NOT NULL DEFAULT 0;
ALTER TABLE public.marketplace_bids DROP CONSTRAINT IF EXISTS marketplace_bids_status_check;
ALTER TABLE public.marketplace_bids ADD CONSTRAINT marketplace_bids_status_check
  CHECK (status IN ('active', 'accepted', 'rejected', 'expired', 'withdrawn', 'superseded')) NOT VALID;

-- Bids can no longer be withdrawn by the bidder (they're binding), so the
-- client UPDATE path from 054 is closed. Every bid change goes through RPCs.
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
-- 3. Marketplace money tables
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.market_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  method text NOT NULL CHECK (method IN ('paystack', 'usdt')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed')),
  amount_usd numeric NOT NULL CHECK (amount_usd > 0),   -- USD credited to funds once paid
  currency text NOT NULL CHECK (currency IN ('NGN', 'USDT')),
  amount_due numeric NOT NULL CHECK (amount_due > 0),   -- NGN or USDT the payer must send
  amount_received numeric,                              -- what the provider / chain confirmed
  fx_rate numeric,                                      -- NGN per USD charged (incl. spread)
  fx_mid_rate numeric,                                  -- NGN per USD market rate
  paystack_reference text UNIQUE,
  usdt_network text CHECK (usdt_network IN ('tron', 'bsc')),
  usdt_tx_hash text,
  usdt_sender text,
  purpose jsonb NOT NULL DEFAULT '{}'::jsonb,           -- what the payer was about to do (bid / buy now)
  provider_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '2 hours'
);
CREATE UNIQUE INDEX IF NOT EXISTS market_payments_usdt_tx_unique
  ON public.market_payments (usdt_network, lower(usdt_tx_hash)) WHERE usdt_tx_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS market_payments_user_idx ON public.market_payments(user_id, created_at DESC);

-- Each paid-in payment becomes a lot. Spending and refunds move money in and
-- out of lots, so every dollar can be traced back to where it came from.
CREATE TABLE IF NOT EXISTS public.market_fund_lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  payment_id uuid NOT NULL UNIQUE REFERENCES public.market_payments(id) ON DELETE RESTRICT,
  original_usd numeric NOT NULL CHECK (original_usd > 0),
  remaining_usd numeric NOT NULL CHECK (remaining_usd >= 0 AND remaining_usd <= original_usd),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS market_fund_lots_user_idx ON public.market_fund_lots(user_id, created_at);

CREATE TABLE IF NOT EXISTS public.market_lot_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id uuid NOT NULL REFERENCES public.market_fund_lots(id) ON DELETE RESTRICT,
  amount_usd numeric NOT NULL CHECK (amount_usd > 0),
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
  amount_usd numeric NOT NULL CHECK (amount_usd > 0),
  available_at timestamptz NOT NULL,
  listing_id uuid REFERENCES public.marketplace_listings(id) ON DELETE RESTRICT,
  ownership_id uuid REFERENCES public.marketplace_ownership_history(id) ON DELETE RESTRICT,
  forfeited boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS market_earnings_user_idx ON public.market_earnings(user_id);

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
  amount_usd numeric NOT NULL CHECK (amount_usd > 0),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'paid', 'rejected', 'failed')),
  payout_account_id uuid REFERENCES public.payout_accounts(id) ON DELETE SET NULL,  -- earnings only (details are snapshotted below)
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
  bucket text NOT NULL CHECK (bucket IN ('funds', 'earnings', 'platform', 'escrow')),
  kind text NOT NULL,
  amount_usd numeric NOT NULL,
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

CREATE OR REPLACE FUNCTION public.market_bid_fee(p_amount numeric)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT ROUND(LEAST(GREATEST(p_amount * s.bid_fee_pct / 100, s.bid_fee_min_usd), s.bid_fee_max_usd), 2)
  FROM market_settings s WHERE s.id;
$$;
GRANT EXECUTE ON FUNCTION public.market_bid_fee(numeric) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.market_funds_balance(p_user_id uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(SUM(remaining_usd), 0) FROM market_fund_lots WHERE user_id = p_user_id;
$$;
REVOKE ALL ON FUNCTION public.market_funds_balance(uuid) FROM PUBLIC, anon, authenticated;

-- Earnings: cleared, pending (still clearing), and already withdrawn or reserved.
CREATE OR REPLACE FUNCTION public.market_earnings_summary(p_user_id uuid)
RETURNS TABLE (cleared numeric, pending numeric, reserved numeric, withdrawable numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH e AS (
    SELECT
      COALESCE(SUM(amount_usd) FILTER (WHERE NOT forfeited AND available_at <= now()), 0) AS cleared,
      COALESCE(SUM(amount_usd) FILTER (WHERE NOT forfeited AND available_at > now()), 0) AS pending
    FROM market_earnings WHERE user_id = p_user_id
  ), w AS (
    SELECT COALESCE(SUM(amount_usd), 0) AS reserved
    FROM market_withdrawals
    WHERE user_id = p_user_id AND bucket = 'earnings' AND status IN ('pending', 'processing', 'paid')
  )
  SELECT e.cleared, e.pending, w.reserved, GREATEST(e.cleared - w.reserved, 0) FROM e, w;
$$;
REVOKE ALL ON FUNCTION public.market_earnings_summary(uuid) FROM PUBLIC, anon, authenticated;

-- What the signed-in user sees in their marketplace wallet.
CREATE OR REPLACE FUNCTION public.get_market_balances()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_e record;
  v_in_bids numeric;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  SELECT * INTO v_e FROM market_earnings_summary(v_uid);
  SELECT COALESCE(SUM(a.amount_usd), 0) INTO v_in_bids
    FROM market_lot_allocations a JOIN marketplace_bids b ON b.id = a.bid_id
    WHERE b.bidder_id = v_uid AND b.status = 'active' AND a.purpose = 'bid' AND NOT a.released;
  RETURN jsonb_build_object(
    'funds', market_funds_balance(v_uid),
    'held_in_bids', v_in_bids,
    'earnings_withdrawable', v_e.withdrawable,
    'earnings_pending', v_e.pending,
    'earnings_reserved', v_e.reserved
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_market_balances() TO authenticated;

-- Take p_amount out of a user's lots, oldest first, recording why.
CREATE OR REPLACE FUNCTION public.market_take_funds(
  p_user_id uuid, p_amount numeric, p_purpose text, p_bid_id uuid DEFAULT NULL, p_withdrawal_id uuid DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_left numeric := ROUND(p_amount, 2);
  v_lot record;
  v_take numeric;
BEGIN
  IF v_left <= 0 THEN RETURN; END IF;
  IF market_funds_balance(p_user_id) < v_left THEN
    RAISE EXCEPTION 'Not enough marketplace funds';
  END IF;
  FOR v_lot IN
    SELECT id, remaining_usd FROM market_fund_lots
    WHERE user_id = p_user_id AND remaining_usd > 0
    ORDER BY created_at, id FOR UPDATE
  LOOP
    EXIT WHEN v_left <= 0;
    v_take := LEAST(v_left, v_lot.remaining_usd);
    UPDATE market_fund_lots SET remaining_usd = remaining_usd - v_take WHERE id = v_lot.id;
    INSERT INTO market_lot_allocations (lot_id, amount_usd, purpose, bid_id, withdrawal_id)
      VALUES (v_lot.id, v_take, p_purpose, p_bid_id, p_withdrawal_id);
    v_left := v_left - v_take;
  END LOOP;
  IF v_left > 0 THEN RAISE EXCEPTION 'Not enough marketplace funds'; END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.market_take_funds(uuid, numeric, text, uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Put allocations back into their original lots (bid refund, withdrawal rejected).
CREATE OR REPLACE FUNCTION public.market_release_allocations(p_bid_id uuid, p_withdrawal_id uuid, p_purpose text)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_total numeric := 0;
  v_a record;
BEGIN
  FOR v_a IN
    SELECT id, lot_id, amount_usd FROM market_lot_allocations
    WHERE NOT released AND purpose = p_purpose
      AND ((p_bid_id IS NOT NULL AND bid_id = p_bid_id) OR (p_withdrawal_id IS NOT NULL AND withdrawal_id = p_withdrawal_id))
    FOR UPDATE
  LOOP
    UPDATE market_fund_lots SET remaining_usd = remaining_usd + v_a.amount_usd WHERE id = v_a.lot_id;
    UPDATE market_lot_allocations SET released = true WHERE id = v_a.id;
    v_total := v_total + v_a.amount_usd;
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

-- Refund a paid bid's principal when it leaves 'active' for any reason other
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
      INSERT INTO market_ledger (user_id, bucket, kind, amount_usd, reference_id)
        VALUES (NEW.bidder_id, 'funds', 'bid_refund', v_refunded, NEW.id);
      PERFORM market_notify(NEW.bidder_id, 'marketplace_bid_refunded', 'Bid refunded',
        'Your bid of $' || to_char(NEW.amount, 'FM999999990.00') || ' didn''t win. $' || to_char(v_refunded, 'FM999999990.00')
        || ' is back in your marketplace funds.', NEW.listing_id);
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

-- Creates a pending payment and returns what the user must pay. The rate is
-- read from market_fx_rates server-side; the client never supplies one.
CREATE OR REPLACE FUNCTION public.market_create_payment(
  p_user_id uuid, p_method text, p_amount_usd numeric, p_purpose jsonb, p_reference text DEFAULT NULL
) RETURNS market_payments LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s market_settings%ROWTYPE;
  v_mid numeric;
  v_fetched timestamptz;
  v_rate numeric;
  v_due numeric;
  v_pay market_payments%ROWTYPE;
BEGIN
  SELECT * INTO s FROM market_settings WHERE id;
  IF p_amount_usd IS NULL OR p_amount_usd < s.min_payment_usd THEN
    RAISE EXCEPTION 'Minimum payment is $%', s.min_payment_usd;
  END IF;
  IF EXISTS (SELECT 1 FROM account_deletion_requests WHERE user_id = p_user_id AND status = 'pending') THEN
    RAISE EXCEPTION 'This account is being deleted';
  END IF;
  p_amount_usd := ROUND(p_amount_usd, 2);

  IF p_method = 'paystack' THEN
    SELECT units_per_usd, fetched_at INTO v_mid, v_fetched FROM market_fx_rates WHERE currency = 'NGN';
    IF v_mid IS NULL OR v_fetched < now() - make_interval(hours => s.fx_max_age_hours) THEN
      RAISE EXCEPTION 'Exchange rate unavailable, try again in a few minutes';
    END IF;
    v_rate := ROUND(v_mid * (1 + s.fx_spread_pct / 100), 4);
    v_due := CEIL(p_amount_usd * v_rate);  -- whole naira, rounded up
    INSERT INTO market_payments (user_id, method, amount_usd, currency, amount_due, fx_rate, fx_mid_rate, paystack_reference, purpose)
      VALUES (p_user_id, 'paystack', p_amount_usd, 'NGN', v_due, v_rate, v_mid, p_reference, COALESCE(p_purpose, '{}'))
      RETURNING * INTO v_pay;
  ELSIF p_method = 'usdt' THEN
    -- USDT is pegged 1:1 for pricing; network fees are paid by the sender.
    -- The receiving addresses are shared with One Dream, so a transfer can
    -- only be claimed if it (a) comes from the sender address the payer
    -- declared up front, (b) is for this payment's exact amount, which carries
    -- a unique sub-cent tag, and (c) happened after this payment was created.
    -- The backend enforces (a)-(c) on-chain before confirming.
    IF p_purpose ->> 'sender' IS NULL OR p_purpose ->> 'network' NOT IN ('tron', 'bsc') THEN
      RAISE EXCEPTION 'USDT payments need the network and the address you will send from';
    END IF;
    v_due := p_amount_usd + (floor(random() * 98) + 1) / 10000.0;
    INSERT INTO market_payments (user_id, method, amount_usd, currency, amount_due, purpose, usdt_network, expires_at)
      VALUES (p_user_id, 'usdt', p_amount_usd, 'USDT', v_due, p_purpose, p_purpose ->> 'network', now() + interval '24 hours')
      RETURNING * INTO v_pay;
  ELSE
    RAISE EXCEPTION 'Unknown payment method';
  END IF;
  RETURN v_pay;
END;
$$;
REVOKE ALL ON FUNCTION public.market_create_payment(uuid, text, numeric, jsonb, text) FROM PUBLIC, anon, authenticated;

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

  INSERT INTO market_fund_lots (user_id, payment_id, original_usd, remaining_usd)
    VALUES (v_pay.user_id, v_pay.id, v_pay.amount_usd, v_pay.amount_usd);
  INSERT INTO market_ledger (user_id, bucket, kind, amount_usd, reference_id, meta)
    VALUES (v_pay.user_id, 'funds', 'payment_in', v_pay.amount_usd, v_pay.id,
            jsonb_build_object('method', v_pay.method, 'currency', v_pay.currency, 'amount', p_amount_received));

  IF v_pay.method = 'paystack' AND v_pay.fx_mid_rate IS NOT NULL THEN
    v_spread := ROUND(v_pay.amount_due / v_pay.fx_mid_rate - v_pay.amount_usd, 2);
    PERFORM record_revenue(
      p_source => 'marketplace_fx_spread', p_user_id => v_pay.user_id, p_reference_id => v_pay.id,
      p_gross_amount => v_pay.amount_usd, p_revenue_amount => v_spread, p_currency => 'USD',
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

CREATE OR REPLACE FUNCTION public.create_marketplace_listing(p_item_type text, p_item_id uuid, p_seller_id uuid, p_asking_price numeric, p_buy_now_price numeric DEFAULT NULL::numeric, p_reserve_price numeric DEFAULT NULL::numeric, p_minimum_increment numeric DEFAULT 10, p_royalty_pct numeric DEFAULT 5.00, p_expires_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_listing_type text DEFAULT NULL::text)
 RETURNS marketplace_listings
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  s market_settings%ROWTYPE;
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
  IF p_asking_price IS NULL OR p_asking_price < 1 THEN
    RAISE EXCEPTION 'Asking price must be at least $1';
  END IF;
  IF p_reserve_price IS NOT NULL AND p_reserve_price < 0 THEN
    RAISE EXCEPTION 'reserve_price cannot be negative';
  END IF;
  v_increment := COALESCE(p_minimum_increment, 1);
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
  IF v_listing_type IN ('auction_buy_now', 'fixed_price') AND (v_buy_now_price IS NULL OR v_buy_now_price < 1) THEN
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
    reserve_price, minimum_increment, royalty_pct, expires_at, listing_fee_paid, listing_type
  ) VALUES (
    p_item_type, p_item_id, p_seller_id, v_author_id, p_asking_price, v_buy_now_price,
    p_reserve_price, v_increment, v_royalty_pct, v_expires, v_listing_fee, v_listing_type
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

-- Credit-funded bidding and buying are retired: items are paid for with
-- marketplace money only (Google Play credits can never reach a withdrawal).
REVOKE EXECUTE ON FUNCTION public.place_marketplace_bid(uuid, uuid, numeric, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.accept_marketplace_bid(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.accept_marketplace_buy_now(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Lowest amount the next bid on a listing must be.
CREATE OR REPLACE FUNCTION public.market_min_bid(p_listing_id uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN MAX(b.amount) IS NULL THEN l.asking_price ELSE MAX(b.amount) + l.minimum_increment END
  FROM marketplace_listings l
  LEFT JOIN marketplace_bids b ON b.listing_id = l.id AND b.status = 'active'
  WHERE l.id = p_listing_id
  GROUP BY l.asking_price, l.minimum_increment;
$$;
GRANT EXECUTE ON FUNCTION public.market_min_bid(uuid) TO anon, authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 7. Bidding and buying with marketplace money
-- ════════════════════════════════════════════════════════════════════════════

-- Places a paid bid from the caller's funds: the bid amount is held in escrow
-- and the bid fee is charged. The app tops funds up first (Paystack / USDT)
-- if they're short.
CREATE OR REPLACE FUNCTION public.place_cash_bid(p_listing_id uuid, p_amount numeric)
RETURNS marketplace_bids LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s market_settings%ROWTYPE;
  v_uid uuid := auth.uid();
  v_listing marketplace_listings%ROWTYPE;
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
    RAISE EXCEPTION 'Bid must be at least $%', v_min;
  END IF;
  IF (SELECT count(*) FROM marketplace_bids WHERE bidder_id = v_uid AND status = 'active') >= s.max_active_bids THEN
    RAISE EXCEPTION 'You have too many open bids. Wait for some to close.';
  END IF;

  v_fee := market_bid_fee(p_amount);

  -- Raising your own bid: the earlier one is refunded (its fee is kept).
  FOR v_prev IN SELECT id FROM marketplace_bids
    WHERE listing_id = p_listing_id AND bidder_id = v_uid AND status = 'active' FOR UPDATE
  LOOP
    UPDATE marketplace_bids SET status = 'superseded', decided_at = now() WHERE id = v_prev.id;
  END LOOP;

  INSERT INTO marketplace_bids (listing_id, bidder_id, amount, status, expires_at, funding, fee_usd)
    VALUES (p_listing_id, v_uid, p_amount, 'active',
            v_listing.expires_at + make_interval(hours => s.decision_hours), 'cash', v_fee)
    RETURNING * INTO v_bid;

  PERFORM market_take_funds(v_uid, p_amount, 'bid', v_bid.id, NULL);
  PERFORM market_take_funds(v_uid, v_fee, 'fee', v_bid.id, NULL);

  INSERT INTO market_ledger (user_id, bucket, kind, amount_usd, reference_id) VALUES
    (v_uid, 'funds', 'bid_escrow', -p_amount, v_bid.id),
    (v_uid, 'funds', 'bid_fee', -v_fee, v_bid.id),
    (NULL, 'platform', 'bid_fee', v_fee, v_bid.id);
  PERFORM record_revenue(
    p_source => 'marketplace_bid_fee', p_user_id => v_uid, p_reference_id => v_bid.id,
    p_gross_amount => p_amount, p_revenue_amount => v_fee, p_currency => 'USD',
    p_payment_method => 'marketplace_funds', p_original_currency => 'USD', p_original_amount => p_amount,
    p_metadata => jsonb_build_object('listing_id', p_listing_id));

  PERFORM market_notify(v_listing.seller_id, 'marketplace_bid_received', 'New paid bid',
    'Someone bid $' || to_char(p_amount, 'FM999999990.00') || ' on your listing.', p_listing_id);
  RETURN v_bid;
END;
$$;
GRANT EXECUTE ON FUNCTION public.place_cash_bid(uuid, numeric) TO authenticated;

-- The sale itself: escrowed money becomes the seller's and creator's
-- earnings (after clearing) and the platform's fee.
CREATE OR REPLACE FUNCTION public.settle_cash_sale(p_listing_id uuid, p_buyer_id uuid, p_amount numeric, p_bid_id uuid)
RETURNS marketplace_ownership_history LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s market_settings%ROWTYPE;
  v_listing marketplace_listings%ROWTYPE;
  v_platform_fee numeric;
  v_royalty numeric;
  v_proceeds numeric;
  v_history marketplace_ownership_history%ROWTYPE;
  v_available_at timestamptz;
BEGIN
  SELECT * INTO s FROM market_settings WHERE id;
  SELECT * INTO v_listing FROM marketplace_listings WHERE id = p_listing_id;
  v_available_at := now() + make_interval(days => s.clearing_days);

  v_platform_fee := ROUND(p_amount * s.platform_fee_pct / 100, 2);
  v_royalty := CASE
    WHEN v_listing.creator_id IS NULL OR v_listing.creator_id = v_listing.seller_id THEN 0
    ELSE ROUND(p_amount * LEAST(GREATEST(v_listing.royalty_pct, 0), s.royalty_max_pct) / 100, 2)
  END;
  v_proceeds := p_amount - v_platform_fee - v_royalty;
  IF v_proceeds < 0 THEN RAISE EXCEPTION 'Invalid fee split'; END IF;

  INSERT INTO marketplace_ownership_history (
    item_type, item_id, listing_id, bid_id, from_user_id, to_user_id,
    sale_price, platform_fee_pct, platform_fee_amount, royalty_amount, royalty_recipient_id, seller_proceeds
  ) VALUES (
    v_listing.item_type, v_listing.item_id, v_listing.id, p_bid_id, v_listing.seller_id, p_buyer_id,
    p_amount, s.platform_fee_pct, v_platform_fee, v_royalty,
    CASE WHEN v_royalty > 0 THEN v_listing.creator_id END, v_proceeds
  ) RETURNING * INTO v_history;

  IF v_proceeds > 0 AND v_listing.seller_id IS NOT NULL THEN
    INSERT INTO market_earnings (user_id, kind, amount_usd, available_at, listing_id, ownership_id)
      VALUES (v_listing.seller_id, 'sale', v_proceeds, v_available_at, v_listing.id, v_history.id);
  END IF;
  IF v_royalty > 0 THEN
    INSERT INTO market_earnings (user_id, kind, amount_usd, available_at, listing_id, ownership_id)
      VALUES (v_listing.creator_id, 'royalty', v_royalty, v_available_at, v_listing.id, v_history.id);
  END IF;

  INSERT INTO market_ledger (user_id, bucket, kind, amount_usd, reference_id) VALUES
    (v_listing.seller_id, 'earnings', 'sale_proceeds', v_proceeds, v_history.id),
    (NULL, 'platform', 'commission', v_platform_fee, v_history.id);
  IF v_royalty > 0 THEN
    INSERT INTO market_ledger (user_id, bucket, kind, amount_usd, reference_id)
      VALUES (v_listing.creator_id, 'earnings', 'royalty', v_royalty, v_history.id);
  END IF;

  PERFORM record_revenue(
    p_source => 'marketplace_commission', p_user_id => v_listing.seller_id, p_reference_id => v_listing.id,
    p_gross_amount => p_amount, p_revenue_amount => v_platform_fee, p_currency => 'USD',
    p_payment_method => 'marketplace_funds', p_original_currency => 'USD', p_original_amount => p_amount,
    p_metadata => jsonb_build_object('listing_id', v_listing.id, 'bid_id', p_bid_id, 'buyer_id', p_buyer_id));

  UPDATE marketplace_listings SET status = 'sold', updated_at = now() WHERE id = v_listing.id;

  PERFORM market_notify(v_listing.seller_id, 'marketplace_sold', 'Sold!',
    'Your item sold for $' || to_char(p_amount, 'FM999999990.00') || '. $' || to_char(v_proceeds, 'FM999999990.00')
    || ' is in your earnings and can be withdrawn after ' || s.clearing_days || ' days.', v_listing.id);
  PERFORM market_notify(p_buyer_id, 'marketplace_won', 'You own it',
    'Your purchase went through. The item is now yours.', v_listing.id);
  IF v_royalty > 0 THEN
    PERFORM market_notify(v_listing.creator_id, 'marketplace_royalty', 'Royalty earned',
      'Your work was resold. You earned a $' || to_char(v_royalty, 'FM999999990.00') || ' royalty.', v_listing.id);
  END IF;
  RETURN v_history;
END;
$$;
REVOKE ALL ON FUNCTION public.settle_cash_sale(uuid, uuid, numeric, uuid) FROM PUBLIC, anon, authenticated;

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

  SELECT COALESCE(SUM(amount_usd), 0) INTO v_escrow FROM market_lot_allocations
    WHERE bid_id = v_bid.id AND purpose = 'bid' AND NOT released;
  IF v_escrow < v_bid.amount THEN
    RAISE EXCEPTION 'This bid is not fully funded';
  END IF;

  UPDATE marketplace_bids SET status = 'accepted', decided_at = now() WHERE id = v_bid.id;
  v_history := settle_cash_sale(v_listing.id, v_bid.bidder_id, v_bid.amount, v_bid.id);
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
  v_fee numeric;
  v_ref uuid := gen_random_uuid();
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

  v_fee := market_bid_fee(v_listing.buy_now_price);
  PERFORM market_take_funds(v_uid, v_listing.buy_now_price, 'purchase', NULL, NULL);
  PERFORM market_take_funds(v_uid, v_fee, 'fee', NULL, NULL);
  INSERT INTO market_ledger (user_id, bucket, kind, amount_usd, reference_id) VALUES
    (v_uid, 'funds', 'purchase', -v_listing.buy_now_price, v_listing.id),
    (v_uid, 'funds', 'purchase_fee', -v_fee, v_listing.id),
    (NULL, 'platform', 'purchase_fee', v_fee, v_listing.id);
  PERFORM record_revenue(
    p_source => 'marketplace_bid_fee', p_user_id => v_uid, p_reference_id => v_listing.id,
    p_gross_amount => v_listing.buy_now_price, p_revenue_amount => v_fee, p_currency => 'USD',
    p_payment_method => 'marketplace_funds', p_original_currency => 'USD', p_original_amount => v_listing.buy_now_price,
    p_metadata => jsonb_build_object('listing_id', p_listing_id, 'buy_now', true));

  RETURN settle_cash_sale(v_listing.id, v_uid, v_listing.buy_now_price, NULL);
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

-- Earnings go to a verified payout account. Funds always go back to their
-- source (Paystack refund / the USDT sender address).
CREATE OR REPLACE FUNCTION public.request_market_withdrawal(p_bucket text, p_amount numeric, p_payout_account_id uuid DEFAULT NULL)
RETURNS market_withdrawals LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s market_settings%ROWTYPE;
  v_uid uuid := auth.uid();
  v_acc payout_accounts%ROWTYPE;
  v_e record;
  v_w market_withdrawals%ROWTYPE;
BEGIN
  SELECT * INTO s FROM market_settings WHERE id;
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF NOT s.payouts_enabled THEN RAISE EXCEPTION 'Withdrawals are paused right now'; END IF;
  p_amount := ROUND(p_amount, 2);
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'Enter an amount'; END IF;

  -- One request at a time.
  PERFORM 1 FROM profiles WHERE id = v_uid FOR UPDATE;
  IF EXISTS (SELECT 1 FROM market_withdrawals WHERE user_id = v_uid AND status IN ('pending', 'processing')) THEN
    RAISE EXCEPTION 'You already have a withdrawal in progress';
  END IF;

  IF p_bucket = 'earnings' THEN
    IF p_amount < s.min_withdrawal_usd THEN
      RAISE EXCEPTION 'Minimum withdrawal is $%', s.min_withdrawal_usd;
    END IF;
    SELECT * INTO v_acc FROM payout_accounts WHERE id = p_payout_account_id AND user_id = v_uid AND is_active;
    IF NOT FOUND THEN RAISE EXCEPTION 'Add a verified payout account first'; END IF;
    SELECT * INTO v_e FROM market_earnings_summary(v_uid);
    IF p_amount > v_e.withdrawable THEN
      RAISE EXCEPTION 'You can withdraw up to $% right now ($% is still clearing)', v_e.withdrawable, v_e.pending;
    END IF;
    INSERT INTO market_withdrawals (user_id, bucket, amount_usd, payout_account_id, payout_details)
      VALUES (v_uid, 'earnings', p_amount, v_acc.id,
              jsonb_build_object('method', v_acc.method, 'bank_name', v_acc.bank_name, 'account_number', v_acc.account_number,
                                 'account_name', v_acc.account_name, 'recipient_code', v_acc.recipient_code,
                                 'usdt_address', v_acc.usdt_address))
      RETURNING * INTO v_w;
    INSERT INTO market_ledger (user_id, bucket, kind, amount_usd, reference_id)
      VALUES (v_uid, 'earnings', 'withdrawal_requested', -p_amount, v_w.id);
  ELSIF p_bucket = 'funds' THEN
    IF p_amount < s.min_payment_usd THEN
      RAISE EXCEPTION 'Minimum refund is $%', s.min_payment_usd;
    END IF;
    INSERT INTO market_withdrawals (user_id, bucket, amount_usd)
      VALUES (v_uid, 'funds', p_amount) RETURNING * INTO v_w;
    PERFORM market_take_funds(v_uid, p_amount, 'withdrawal', NULL, v_w.id);
    INSERT INTO market_ledger (user_id, bucket, kind, amount_usd, reference_id)
      VALUES (v_uid, 'funds', 'refund_requested', -p_amount, v_w.id);
  ELSE
    RAISE EXCEPTION 'Unknown balance';
  END IF;

  INSERT INTO notifications (user_id, type, title, body, reference_id)
    SELECT a.user_id, 'admin_withdrawal_request', 'Withdrawal request',
           '$' || to_char(p_amount, 'FM999999990.00') || ' (' || p_bucket || ') is waiting for review.', v_w.id
    FROM app_admins a;
  RETURN v_w;
END;
$$;
GRANT EXECUTE ON FUNCTION public.request_market_withdrawal(text, numeric, uuid) TO authenticated;

-- For a funds withdrawal: which payments it refunds, and how much of each
-- (the backend refunds each one to its source).
CREATE OR REPLACE FUNCTION public.market_withdrawal_sources(p_withdrawal_id uuid)
RETURNS TABLE (payment_id uuid, method text, amount_usd numeric, paystack_reference text, fx_rate numeric,
               usdt_network text, usdt_sender text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.id, p.method, SUM(a.amount_usd), p.paystack_reference, p.fx_rate, p.usdt_network, p.usdt_sender
  FROM market_lot_allocations a
  JOIN market_fund_lots l ON l.id = a.lot_id
  JOIN market_payments p ON p.id = l.payment_id
  WHERE a.withdrawal_id = p_withdrawal_id AND a.purpose = 'withdrawal' AND NOT a.released
  GROUP BY p.id, p.method, p.paystack_reference, p.fx_rate, p.usdt_network, p.usdt_sender;
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
    INSERT INTO market_ledger (user_id, bucket, kind, amount_usd, reference_id)
      VALUES (v_w.user_id, v_w.bucket, 'withdrawal_rejected', v_w.amount_usd, v_w.id);
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
  INSERT INTO market_ledger (user_id, bucket, kind, amount_usd, reference_id, meta)
    VALUES (v_w.user_id, v_w.bucket, 'withdrawal_paid', 0, v_w.id,
            jsonb_build_object('provider_ref', p_provider_ref, 'amount', p_amount_paid, 'currency', p_currency_paid));
  PERFORM market_notify(v_w.user_id, 'withdrawal_paid', 'Withdrawal sent',
    '$' || to_char(v_w.amount_usd, 'FM999999990.00') || ' has been sent. Reference: ' || p_provider_ref, v_w.id);
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
  INSERT INTO market_ledger (user_id, bucket, kind, amount_usd, reference_id)
    VALUES (v_w.user_id, v_w.bucket, 'withdrawal_failed', v_w.amount_usd, v_w.id);
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
DECLARE
  v_author uuid;
  v_owner uuid;
  v_has_history boolean;
BEGIN
  IF EXISTS (SELECT 1 FROM marketplace_listings WHERE item_type = p_item_type AND item_id = p_item_id
             AND status IN ('active', 'awaiting_decision')) THEN
    RETURN 'listed';
  END IF;
  SELECT EXISTS (SELECT 1 FROM marketplace_ownership_history WHERE item_type = p_item_type AND item_id = p_item_id)
    INTO v_has_history;
  IF v_has_history THEN
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
-- Step 2 (backend, daily): finalize_account_deletion() runs once no money is
--   left in flight, then the backend deletes the auth user.

CREATE OR REPLACE FUNCTION public.request_account_deletion()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_l record;
  v_b record;
  v_funds numeric;
  v_wd uuid;
  v_e record;
  v_acc uuid;
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

  -- Refund any remaining funds to their sources.
  v_funds := market_funds_balance(v_uid);
  IF v_funds > 0 AND NOT EXISTS (SELECT 1 FROM market_withdrawals WHERE user_id = v_uid AND bucket = 'funds' AND status IN ('pending', 'processing')) THEN
    INSERT INTO market_withdrawals (user_id, bucket, amount_usd, auto_created, admin_note)
      VALUES (v_uid, 'funds', v_funds, true, 'Account deletion refund') RETURNING id INTO v_wd;
    PERFORM market_take_funds(v_uid, v_funds, 'withdrawal', NULL, v_wd);
  END IF;

  -- Pay out cleared earnings if a payout account exists.
  SELECT * INTO v_e FROM market_earnings_summary(v_uid);
  SELECT id INTO v_acc FROM payout_accounts WHERE user_id = v_uid AND is_active ORDER BY created_at DESC LIMIT 1;
  IF v_e.withdrawable > 0 AND v_acc IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM market_withdrawals WHERE user_id = v_uid AND bucket = 'earnings' AND status IN ('pending', 'processing')) THEN
    INSERT INTO market_withdrawals (user_id, bucket, amount_usd, payout_account_id, auto_created, admin_note,
                                    payout_details)
      SELECT v_uid, 'earnings', v_e.withdrawable, a.id, true, 'Account deletion payout',
             jsonb_build_object('method', a.method, 'bank_name', a.bank_name, 'account_number', a.account_number,
                                'account_name', a.account_name, 'recipient_code', a.recipient_code, 'usdt_address', a.usdt_address)
      FROM payout_accounts a WHERE a.id = v_acc;
  END IF;

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

-- Backend (service role) asks which accounts are ready to delete now.
-- Earnings with no payout account, or still clearing after 120 days, are
-- forfeited as stated in the Terms.
CREATE OR REPLACE FUNCTION public.accounts_ready_for_deletion()
RETURNS TABLE (user_id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_r record;
  v_e record;
BEGIN
  FOR v_r IN SELECT d.user_id, d.requested_at FROM account_deletion_requests d WHERE d.status = 'pending' LOOP
    CONTINUE WHEN EXISTS (SELECT 1 FROM market_withdrawals w WHERE w.user_id = v_r.user_id AND w.status IN ('pending', 'processing'));
    CONTINUE WHEN market_funds_balance(v_r.user_id) > 0;
    SELECT * INTO v_e FROM market_earnings_summary(v_r.user_id);
    IF v_e.pending > 0 AND v_r.requested_at > now() - interval '120 days' THEN
      CONTINUE;  -- wait for clearing
    END IF;
    IF v_e.withdrawable > 0 AND EXISTS (SELECT 1 FROM payout_accounts a WHERE a.user_id = v_r.user_id AND a.is_active)
       AND v_r.requested_at > now() - interval '120 days' THEN
      -- newly cleared earnings: queue a payout and wait for it
      INSERT INTO market_withdrawals (user_id, bucket, amount_usd, payout_account_id, auto_created, admin_note, payout_details)
        SELECT v_r.user_id, 'earnings', v_e.withdrawable, a.id, true, 'Account deletion payout',
               jsonb_build_object('method', a.method, 'bank_name', a.bank_name, 'account_number', a.account_number,
                                  'account_name', a.account_name, 'recipient_code', a.recipient_code, 'usdt_address', a.usdt_address)
        FROM payout_accounts a WHERE a.user_id = v_r.user_id AND a.is_active ORDER BY a.created_at DESC LIMIT 1;
      CONTINUE;
    END IF;
    -- Anything left is forfeited.
    UPDATE market_earnings SET forfeited = true WHERE market_earnings.user_id = v_r.user_id AND NOT forfeited;
    user_id := v_r.user_id;
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
      public.market_create_payment(uuid, text, numeric, jsonb, text),
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
      public.market_funds_balance(uuid),
      public.market_earnings_summary(uuid)
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
