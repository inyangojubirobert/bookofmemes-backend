-- Reconstruction of marketplace objects that exist live on Supabase but were
-- never committed as a migration file in this repo -- discovered while
-- explaining the $62 minimum-bid figure in the Bids tab (2026-07-26 session).
--
-- 001_revenue_ledger_system.sql / 003_revenue_ledger_refinements.sql already
-- capture create_marketplace_listing / feature_marketplace_listing /
-- accept_marketplace_bid / accept_marketplace_buy_now (pulled via
-- pg_get_functiondef when those were spliced with revenue-recording calls).
-- Everything below was NOT captured anywhere locally: the three marketplace
-- tables themselves (with RLS), place_marketplace_bid, and the two trigger
-- functions that keep wallet holds and bid status in sync with a listing's
-- lifecycle. Reconstructed from a live schema introspection dump
-- (database-schema.json, generated 2026-07-24) -- NOT re-run against
-- Supabase, since every object here already exists live. This file exists so
-- the repo has a record of it and so the marketplace could be rebuilt from
-- scratch if ever needed.
--
-- CAVEAT: the introspection query this was reconstructed from does not
-- expose trigger WHEN-clauses or partial-index WHERE-clauses. The one
-- unique index and the reject_bids_on_listing_close trigger below include a
-- best-effort WHERE/WHEN clause inferred from the object's name and the
-- surrounding function bodies (which are exact, pulled verbatim) -- verify
-- both against the live definitions (`SELECT indexdef FROM pg_indexes WHERE
-- indexname = 'marketplace_listings_one_active_per_item'` /
-- `SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgname =
-- 'trg_reject_bids_on_listing_close'`) before trusting this file to rebuild
-- an empty database. No CHECK constraints were found in the introspection
-- dump for status/listing_type columns either -- if any exist live, they're
-- not reproduced here; validation currently lives in the RAISE EXCEPTION
-- checks inside the functions in 001/003 instead.

-- ── 1. marketplace_listings ─────────────────────────────────────────────────
CREATE TABLE marketplace_listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_type text NOT NULL,
  item_id uuid NOT NULL,
  seller_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  creator_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  asking_price numeric NOT NULL,
  buy_now_price numeric,
  reserve_price numeric,
  minimum_increment numeric NOT NULL DEFAULT 10,
  royalty_pct numeric NOT NULL DEFAULT 5.00,
  status text NOT NULL DEFAULT 'active',
  listed_at timestamptz DEFAULT now(),
  expires_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  listing_fee_paid numeric NOT NULL DEFAULT 0,
  listing_type text NOT NULL DEFAULT 'auction',
  featured boolean NOT NULL DEFAULT false,
  featured_until timestamptz,
  featured_fee numeric NOT NULL DEFAULT 0
);

CREATE INDEX marketplace_listings_seller_idx ON marketplace_listings(seller_id);
CREATE INDEX marketplace_listings_item_idx ON marketplace_listings(item_type, item_id);
CREATE INDEX marketplace_listings_featured_idx ON marketplace_listings(featured, featured_until);
-- Best-effort: name implies a partial unique index enforcing "one active
-- listing per item at a time" -- see CAVEAT above.
CREATE UNIQUE INDEX marketplace_listings_one_active_per_item
  ON marketplace_listings(item_type, item_id) WHERE status = 'active';

ALTER TABLE marketplace_listings ENABLE ROW LEVEL SECURITY;

CREATE POLICY marketplace_listings_select ON marketplace_listings
  FOR SELECT USING (true);

CREATE POLICY marketplace_listings_insert ON marketplace_listings
  FOR INSERT WITH CHECK (auth.uid() = seller_id);

CREATE POLICY marketplace_listings_cancel ON marketplace_listings
  FOR UPDATE USING (auth.uid() = seller_id AND status = 'active')
  WITH CHECK (status = ANY (ARRAY['active', 'cancelled']));

-- ── 2. marketplace_bids ──────────────────────────────────────────────────────
CREATE TABLE marketplace_bids (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
  bidder_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  amount numeric NOT NULL,
  wallet_hold_id uuid REFERENCES wallet_holds(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active',
  expires_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT now(),
  decided_at timestamptz
);

CREATE INDEX marketplace_bids_listing_idx ON marketplace_bids(listing_id);
CREATE INDEX marketplace_bids_bidder_idx ON marketplace_bids(bidder_id);

ALTER TABLE marketplace_bids ENABLE ROW LEVEL SECURITY;

-- Identity-restricted by design (see components/MarketplaceDetailPanel.js /
-- src/services/engagementFeedService.js comments): only the bidder themselves
-- or the listing's seller can see a raw marketplace_bids row (which includes
-- bidder_id). Anyone else browsing sees aggregated, anonymized data instead
-- via the public_marketplace_bids view (013_public_marketplace_bids.sql).
CREATE POLICY marketplace_bids_select ON marketplace_bids
  FOR SELECT USING (
    auth.uid() = bidder_id
    OR auth.uid() = (SELECT seller_id FROM marketplace_listings WHERE id = marketplace_bids.listing_id)
  );

CREATE POLICY marketplace_bids_insert ON marketplace_bids
  FOR INSERT WITH CHECK (auth.uid() = bidder_id);

CREATE POLICY marketplace_bids_withdraw ON marketplace_bids
  FOR UPDATE USING (auth.uid() = bidder_id AND status = 'active')
  WITH CHECK (status = ANY (ARRAY['active', 'withdrawn']));

-- ── 3. marketplace_ownership_history ────────────────────────────────────────
CREATE TABLE marketplace_ownership_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_type text NOT NULL,
  item_id uuid NOT NULL,
  listing_id uuid REFERENCES marketplace_listings(id) ON DELETE SET NULL,
  bid_id uuid REFERENCES marketplace_bids(id) ON DELETE SET NULL,
  from_user_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  to_user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  sale_price numeric NOT NULL,
  platform_fee_pct numeric NOT NULL DEFAULT 5.00,
  platform_fee_amount numeric NOT NULL DEFAULT 0,
  royalty_amount numeric NOT NULL DEFAULT 0,
  royalty_recipient_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  seller_proceeds numeric NOT NULL,
  transferred_at timestamptz DEFAULT now()
);

CREATE INDEX marketplace_ownership_history_item_idx
  ON marketplace_ownership_history(item_type, item_id, transferred_at);
CREATE INDEX marketplace_ownership_history_to_user_idx
  ON marketplace_ownership_history(to_user_id);

ALTER TABLE marketplace_ownership_history ENABLE ROW LEVEL SECURITY;

-- Fully public -- ownership provenance/sales history is meant to be visible
-- to anyone viewing a listing (see MarketplaceService.getSalesHistory).
CREATE POLICY marketplace_ownership_history_select ON marketplace_ownership_history
  FOR SELECT USING (true);

-- ── 4. place_marketplace_bid ─────────────────────────────────────────────────
-- Locks the listing and the bidder's wallet, enforces the minimum-bid rule
-- (highest active bid + minimum_increment, or asking_price if no bids yet),
-- checks available balance (wallet_balance minus every other currently-held
-- wallet_holds row, not just wallet_balance alone -- see the 2026-07-26
-- explanation of the $62 minimum / wallet-balance check in this session),
-- then escrows the bid amount as a wallet_holds row rather than debiting the
-- wallet immediately. Called via supabase.rpc('place_marketplace_bid', ...)
-- from src/services/MarketplaceService.js's placeBid().
CREATE OR REPLACE FUNCTION public.place_marketplace_bid(
  p_listing_id uuid,
  p_bidder_id uuid,
  p_amount numeric,
  p_expires_at timestamp with time zone
)
 RETURNS marketplace_bids
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_listing marketplace_listings%ROWTYPE;
  v_wallet wallets%ROWTYPE;
  v_highest numeric;
  v_min_required numeric;
  v_held numeric;
  v_available numeric;
  v_hold_id uuid;
  v_bid marketplace_bids%ROWTYPE;
BEGIN
  IF p_bidder_id <> auth.uid() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF p_expires_at <= now() OR p_expires_at > now() + interval '14 days' THEN
    RAISE EXCEPTION 'expires_at must be between now and 14 days from now';
  END IF;

  SELECT * INTO v_listing FROM marketplace_listings WHERE id = p_listing_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Listing not found';
  END IF;
  IF v_listing.status <> 'active' THEN
    RAISE EXCEPTION 'Listing is not active';
  END IF;
  IF v_listing.listing_type = 'fixed_price' THEN
    RAISE EXCEPTION 'This is a fixed-price listing -- bidding is not allowed. Use Buy Now instead.';
  END IF;
  IF v_listing.seller_id = p_bidder_id THEN
    RAISE EXCEPTION 'Cannot bid on your own listing';
  END IF;

  SELECT MAX(amount) INTO v_highest FROM marketplace_bids
    WHERE listing_id = p_listing_id AND status = 'active';
  v_min_required := CASE
    WHEN v_highest IS NULL THEN v_listing.asking_price
    ELSE v_highest + v_listing.minimum_increment
  END;
  IF p_amount < v_min_required THEN
    RAISE EXCEPTION 'Bid must be at least %', v_min_required;
  END IF;

  SELECT * INTO v_wallet FROM wallets WHERE user_id = p_bidder_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Wallet not found';
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_held FROM wallet_holds
    WHERE wallet_id = v_wallet.id AND status = 'held';
  v_available := v_wallet.wallet_balance - v_held;
  IF v_available < p_amount THEN
    RAISE EXCEPTION 'Insufficient available balance';
  END IF;

  INSERT INTO wallet_holds (wallet_id, amount, reason, status, expires_at)
    VALUES (v_wallet.id, p_amount, 'marketplace_bid', 'held', p_expires_at)
    RETURNING id INTO v_hold_id;

  INSERT INTO marketplace_bids (listing_id, bidder_id, amount, wallet_hold_id, status, expires_at)
    VALUES (p_listing_id, p_bidder_id, p_amount, v_hold_id, 'active', p_expires_at)
    RETURNING * INTO v_bid;

  UPDATE wallet_holds SET reference_id = v_bid.id WHERE id = v_hold_id;

  RETURN v_bid;
END;
$function$;

-- ── 5. release_marketplace_bid_hold (trigger) ───────────────────────────────
-- Fires on every marketplace_bids UPDATE; only acts when a bid leaves
-- 'active' for a terminal state (withdrawn/expired/rejected), releasing its
-- escrowed wallet_holds row so the money becomes available again -- one
-- central place for hold release instead of every call site (withdraw,
-- accept-bid's implicit rejection of the losers, listing expiry) needing to
-- remember to do it. A bid that transitions to 'accepted'/'captured' is
-- deliberately NOT released here -- accept_marketplace_bid (001/003) marks
-- that hold 'captured' itself as part of the same settlement transaction.
CREATE OR REPLACE FUNCTION public.release_marketplace_bid_hold()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status IN ('withdrawn', 'expired', 'rejected') AND OLD.status = 'active' THEN
    UPDATE wallet_holds SET status = 'released'
    WHERE id = NEW.wallet_hold_id AND status = 'held';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER trg_release_marketplace_bid_hold
  AFTER UPDATE ON marketplace_bids
  FOR EACH ROW
  EXECUTE FUNCTION release_marketplace_bid_hold();

-- ── 6. reject_bids_on_listing_close (trigger) ───────────────────────────────
-- When a listing leaves 'active' (sold/cancelled/expired), every bid still
-- marked 'active' on it is closed out too -- 'expired' if the listing itself
-- expired, 'rejected' otherwise (cancelled, or the losing bids once one bid
-- is accepted) -- which in turn fires trg_release_marketplace_bid_hold above
-- to release each of those bidders' escrowed funds.
--
-- CAVEAT: the function body itself has no status-changed guard, so without a
-- trigger-level WHEN clause this would also fire (harmlessly, since the
-- WHERE status='active' UPDATE just no-ops) on updates that don't change
-- status at all, e.g. featuring/boosting a still-active listing. The WHEN
-- clause below is inferred to make that explicit and cheap rather than
-- confirmed from the live trigger definition -- see the file header CAVEAT.
CREATE OR REPLACE FUNCTION public.reject_bids_on_listing_close()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE marketplace_bids
    SET status = CASE WHEN NEW.status = 'expired' THEN 'expired' ELSE 'rejected' END,
        decided_at = now()
    WHERE listing_id = NEW.id AND status = 'active';
  RETURN NEW;
END;
$function$;

CREATE TRIGGER trg_reject_bids_on_listing_close
  AFTER UPDATE ON marketplace_listings
  FOR EACH ROW
  WHEN (NEW.status IS DISTINCT FROM OLD.status AND NEW.status <> 'active')
  EXECUTE FUNCTION reject_bids_on_listing_close();
