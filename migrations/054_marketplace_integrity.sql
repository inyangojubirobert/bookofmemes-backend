-- 054: Marketplace and wallet integrity
--
-- Keeps the bids marketplace working the way it was designed: content is
-- transferred between users, the original creator earns a royalty on every
-- resale, and the platform takes its fee on every sale. Payment comes from
-- the buyer's own funded balance.
--
-- Holes this closes (the policies came from the live schema dump):
--   1. wallets had an UPDATE policy "users_can_update_own_wallet", so any
--      signed-in user could set their own wallet_balance through the REST API.
--      Every wallet write already goes through SECURITY DEFINER functions or
--      the service-role backend, so the policy is removed. Users may only insert
--      their own empty wallet row and read their own wallet. Previously anyone
--      could read every user's balance ("authenticated_read_any_wallet").
--   2. marketplace_listings and marketplace_bids accepted direct INSERTs. A user
--      could list content they don't own (no ownership check, no listing fee),
--      or insert a bid with no escrow hold that accept_marketplace_bid would
--      then settle, putting the buyer's balance into the negative and creating
--      credits for the seller from nothing. Inserts now go only through the
--      RPCs (create_marketplace_listing, place_marketplace_bid).
--   3. The UPDATE policies let a seller change any column of an active listing
--      (royalty_pct, creator_id, buy_now_price, featured, ...) and a bidder
--      change the amount of an active bid after it was escrowed. Column grants
--      now limit those updates to cancelling or withdrawing.
--   4. A reseller chose royalty_pct when listing, so they could set it to 0
--      (cutting out the creator) or a negative number (taking money from the
--      creator's wallet). The creator now sets the royalty (0-20%) on their own
--      listing. Every resale inherits the rate locked in at the first sale.
--   5. consume_app_balance (AI, premium, etc.) and the listing/featured fees
--      ignored escrowed bid holds, so a bidder could spend money that was
--      backing a bid. They now spend only the available balance (balance minus
--      active holds), and settlement re-checks that the bid is still funded.
--   6. Settlement failed outright if the seller or creator had no wallet row.
--      It now creates the missing wallet.
--
-- Safe to re-run.

BEGIN;

-- ── 1. wallets: no direct balance writes, read your own only ────────────────
DROP POLICY IF EXISTS users_can_update_own_wallet ON public.wallets;
DROP POLICY IF EXISTS authenticated_read_any_wallet ON public.wallets;
DROP POLICY IF EXISTS wallets_select_own ON public.wallets;
CREATE POLICY wallets_select_own ON public.wallets
  FOR SELECT USING (auth.uid() = user_id);

REVOKE INSERT, UPDATE, DELETE ON public.wallets FROM anon, authenticated;
-- WalletService.getWallet() creates a missing wallet with { user_id } only;
-- the balance columns fall back to their defaults.
GRANT INSERT (user_id) ON public.wallets TO authenticated;

-- ── 2 & 3. marketplace tables: writes only through the RPCs ─────────────────
DROP POLICY IF EXISTS marketplace_listings_insert ON public.marketplace_listings;
DROP POLICY IF EXISTS marketplace_bids_insert ON public.marketplace_bids;

REVOKE INSERT, UPDATE, DELETE ON public.marketplace_listings FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.marketplace_bids FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.marketplace_ownership_history FROM anon, authenticated;

-- Cancelling a listing / withdrawing a bid stay as plain client UPDATEs
-- (MarketplaceService.cancelListing / withdrawBid). The existing RLS policies
-- restrict the new status value; these grants restrict the columns.
GRANT UPDATE (status, updated_at) ON public.marketplace_listings TO authenticated;
GRANT UPDATE (status, decided_at) ON public.marketplace_bids TO authenticated;

-- ── 4. royalty bounds ───────────────────────────────────────────────────────
-- NOT VALID: enforced on every new or changed row without failing on old ones.
ALTER TABLE public.marketplace_listings DROP CONSTRAINT IF EXISTS marketplace_listings_royalty_range;
ALTER TABLE public.marketplace_listings
  ADD CONSTRAINT marketplace_listings_royalty_range CHECK (royalty_pct >= 0 AND royalty_pct <= 20) NOT VALID;
ALTER TABLE public.marketplace_listings DROP CONSTRAINT IF EXISTS marketplace_listings_increment_positive;
ALTER TABLE public.marketplace_listings
  ADD CONSTRAINT marketplace_listings_increment_positive CHECK (minimum_increment > 0) NOT VALID;

-- Available balance = wallet_balance minus active escrow holds.
CREATE OR REPLACE FUNCTION public.wallet_available_balance(p_wallet_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT w.wallet_balance - COALESCE((
    SELECT SUM(h.amount) FROM wallet_holds h WHERE h.wallet_id = w.id AND h.status = 'held'
  ), 0)
  FROM wallets w WHERE w.id = p_wallet_id;
$$;
REVOKE ALL ON FUNCTION public.wallet_available_balance(uuid) FROM PUBLIC, anon, authenticated;

-- Wallet row for a user, created if missing. Internal helper.
CREATE OR REPLACE FUNCTION public.ensure_wallet(p_user_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO wallets (user_id, wallet_balance, token_balance)
    VALUES (p_user_id, 0, 0)
    ON CONFLICT (user_id) DO NOTHING;
  SELECT id INTO v_id FROM wallets WHERE user_id = p_user_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.ensure_wallet(uuid) FROM PUBLIC, anon, authenticated;

-- ── create_marketplace_listing ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_marketplace_listing(p_item_type text, p_item_id uuid, p_seller_id uuid, p_asking_price numeric, p_buy_now_price numeric DEFAULT NULL::numeric, p_reserve_price numeric DEFAULT NULL::numeric, p_minimum_increment numeric DEFAULT 10, p_royalty_pct numeric DEFAULT 5.00, p_expires_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_listing_type text DEFAULT NULL::text)
 RETURNS marketplace_listings
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_listing_fee numeric := 0.50;
  v_author_id uuid;
  v_current_owner uuid;
  v_wallet wallets%ROWTYPE;
  v_listing marketplace_listings%ROWTYPE;
  v_listing_type text;
  v_buy_now_price numeric;
  v_royalty_pct numeric;
  v_increment numeric;
BEGIN
  IF p_seller_id <> auth.uid() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF p_item_type NOT IN ('stories', 'memes', 'puzzles', 'kids_collections', 'music_box', 'podcast_box', 'tv_box') THEN
    RAISE EXCEPTION 'Invalid item_type: %', p_item_type;
  END IF;
  IF p_asking_price IS NULL OR p_asking_price <= 0 THEN
    RAISE EXCEPTION 'asking_price must be greater than 0';
  END IF;
  IF p_reserve_price IS NOT NULL AND p_reserve_price < 0 THEN
    RAISE EXCEPTION 'reserve_price cannot be negative';
  END IF;
  v_increment := COALESCE(p_minimum_increment, 10);
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
  IF v_listing_type IN ('auction_buy_now', 'fixed_price') AND (v_buy_now_price IS NULL OR v_buy_now_price <= 0) THEN
    RAISE EXCEPTION 'buy_now_price is required for listing_type %', v_listing_type;
  END IF;

  EXECUTE format('SELECT author_id FROM %I WHERE id = $1', p_item_type) INTO v_author_id USING p_item_id;
  IF v_author_id IS NULL THEN
    RAISE EXCEPTION 'Item not found';
  END IF;

  SELECT to_user_id INTO v_current_owner FROM marketplace_ownership_history
    WHERE item_type = p_item_type AND item_id = p_item_id
    ORDER BY transferred_at DESC LIMIT 1;
  v_current_owner := COALESCE(v_current_owner, v_author_id);

  IF v_current_owner <> p_seller_id THEN
    RAISE EXCEPTION 'You do not own this item';
  END IF;

  -- Royalty: the creator chooses it (0-20%) while they still own the item.
  -- Once the item has sold, the rate locked in at that first sale applies
  -- to every resale, whatever the reseller passes.
  IF p_seller_id = v_author_id AND NOT EXISTS (
    SELECT 1 FROM marketplace_ownership_history WHERE item_type = p_item_type AND item_id = p_item_id
  ) THEN
    v_royalty_pct := COALESCE(p_royalty_pct, 5.00);
    IF v_royalty_pct < 0 OR v_royalty_pct > 20 THEN
      RAISE EXCEPTION 'Royalty must be between 0%% and 20%%';
    END IF;
  ELSE
    SELECT l.royalty_pct INTO v_royalty_pct
      FROM marketplace_ownership_history h
      JOIN marketplace_listings l ON l.id = h.listing_id
      WHERE h.item_type = p_item_type AND h.item_id = p_item_id
      ORDER BY h.transferred_at ASC LIMIT 1;
    v_royalty_pct := LEAST(GREATEST(COALESCE(v_royalty_pct, 5.00), 0), 20);
  END IF;

  PERFORM ensure_wallet(p_seller_id);
  SELECT * INTO v_wallet FROM wallets WHERE user_id = p_seller_id FOR UPDATE;
  IF wallet_available_balance(v_wallet.id) < v_listing_fee THEN
    RAISE EXCEPTION 'Insufficient balance for listing fee ($% required)', v_listing_fee;
  END IF;

  INSERT INTO marketplace_listings (
    item_type, item_id, seller_id, creator_id, asking_price, buy_now_price,
    reserve_price, minimum_increment, royalty_pct, expires_at, listing_fee_paid, listing_type
  ) VALUES (
    p_item_type, p_item_id, p_seller_id, v_author_id, p_asking_price, v_buy_now_price,
    p_reserve_price, v_increment, v_royalty_pct, p_expires_at, v_listing_fee, v_listing_type
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

-- ── feature_marketplace_listing: fee from available balance ─────────────────
CREATE OR REPLACE FUNCTION public.feature_marketplace_listing(p_listing_id uuid, p_seller_id uuid, p_duration_days integer)
 RETURNS marketplace_listings
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_fee numeric;
  v_listing marketplace_listings%ROWTYPE;
  v_wallet wallets%ROWTYPE;
  v_base timestamptz;
BEGIN
  IF p_seller_id <> auth.uid() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  v_fee := CASE p_duration_days
    WHEN 7 THEN 1.00
    WHEN 30 THEN 3.00
    ELSE NULL
  END;
  IF v_fee IS NULL THEN
    RAISE EXCEPTION 'Invalid featured duration -- must be 7 or 30 days';
  END IF;

  SELECT * INTO v_listing FROM marketplace_listings WHERE id = p_listing_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Listing not found';
  END IF;
  IF v_listing.seller_id <> p_seller_id THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF v_listing.status <> 'active' THEN
    RAISE EXCEPTION 'Listing is not active';
  END IF;

  PERFORM ensure_wallet(p_seller_id);
  SELECT * INTO v_wallet FROM wallets WHERE user_id = p_seller_id FOR UPDATE;
  IF wallet_available_balance(v_wallet.id) < v_fee THEN
    RAISE EXCEPTION 'Insufficient balance for featured upgrade ($% required)', v_fee;
  END IF;

  v_base := GREATEST(now(), COALESCE(v_listing.featured_until, now()));

  UPDATE wallets SET wallet_balance = wallet_balance - v_fee, updated_at = now()
    WHERE id = v_wallet.id;
  INSERT INTO wallet_ledger (wallet_id, transaction_type, debit, credit, balance_before, balance_after, reference_id)
    VALUES (v_wallet.id, 'marketplace_featured_fee', v_fee, 0,
            v_wallet.wallet_balance, v_wallet.wallet_balance - v_fee, v_listing.id);
  INSERT INTO wallet_transactions (wallet_id, type, amount, description, status, currency_code, metadata)
    VALUES (v_wallet.id, 'marketplace_featured_fee', -v_fee,
            'Featured listing upgrade (' || p_duration_days || ' days)', 'completed', 'USD',
            jsonb_build_object('listing_id', v_listing.id));

  UPDATE marketplace_listings SET
    featured = true,
    featured_until = v_base + (p_duration_days || ' days')::interval,
    featured_fee = featured_fee + v_fee,
    updated_at = now()
  WHERE id = p_listing_id
  RETURNING * INTO v_listing;

  PERFORM record_revenue(
    p_source => 'marketplace_featured', p_user_id => p_seller_id, p_reference_id => v_listing.id,
    p_gross_amount => v_fee, p_revenue_amount => v_fee, p_currency => 'USD',
    p_payment_method => 'wallet', p_original_currency => 'USD', p_original_amount => v_fee,
    p_metadata => jsonb_build_object('duration_days', p_duration_days)
  );

  INSERT INTO notifications (user_id, type, title, body, reference_id)
    VALUES (p_seller_id, 'marketplace_featured', 'Your listing is now Featured ⭐',
            'It will get priority placement until ' || to_char(v_listing.featured_until, 'DD Mon YYYY') || '.',
            v_listing.id);

  RETURN v_listing;
END;
$function$;

-- ── Shared settlement: buyer pays, seller + creator + platform get paid ────
-- One implementation for both accept-bid and buy-now, so the split can't
-- drift between them. Caller has already locked the listing and checked the
-- buyer can pay. Internal only.
CREATE OR REPLACE FUNCTION public.settle_marketplace_sale(
  p_listing_id uuid,
  p_buyer_id uuid,
  p_amount numeric,
  p_bid_id uuid
)
 RETURNS marketplace_ownership_history
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_listing marketplace_listings%ROWTYPE;
  v_buyer_wallet wallets%ROWTYPE;
  v_seller_wallet wallets%ROWTYPE;
  v_creator_wallet wallets%ROWTYPE;
  v_platform_fee_pct numeric := 5.00;
  v_platform_fee numeric;
  v_royalty numeric;
  v_seller_proceeds numeric;
  v_history marketplace_ownership_history%ROWTYPE;
  v_label text := CASE WHEN p_bid_id IS NULL THEN ' (buy now)' ELSE ' (bid accepted)' END;
BEGIN
  SELECT * INTO v_listing FROM marketplace_listings WHERE id = p_listing_id;

  PERFORM ensure_wallet(p_buyer_id);
  PERFORM ensure_wallet(v_listing.seller_id);
  PERFORM ensure_wallet(v_listing.creator_id);

  -- Lock wallets in a fixed order (by user id) to avoid deadlocks between
  -- two sales that share participants.
  PERFORM 1 FROM wallets
    WHERE user_id IN (p_buyer_id, v_listing.seller_id, v_listing.creator_id)
    ORDER BY user_id FOR UPDATE;

  -- For an accepted bid its own hold is already 'captured', so the available
  -- balance excludes it but still subtracts the buyer's other active bids.
  SELECT * INTO v_buyer_wallet FROM wallets WHERE user_id = p_buyer_id;
  IF wallet_available_balance(v_buyer_wallet.id) < p_amount THEN
    RAISE EXCEPTION 'Buyer no longer has enough balance to complete this purchase';
  END IF;

  v_platform_fee := ROUND(p_amount * v_platform_fee_pct / 100, 2);
  v_royalty := CASE
    WHEN v_listing.creator_id = v_listing.seller_id THEN 0
    ELSE ROUND(p_amount * LEAST(GREATEST(v_listing.royalty_pct, 0), 20) / 100, 2)
  END;
  v_seller_proceeds := p_amount - v_platform_fee - v_royalty;
  IF v_seller_proceeds < 0 THEN
    RAISE EXCEPTION 'Invalid fee split';
  END IF;

  -- Buyer pays.
  UPDATE wallets SET wallet_balance = wallet_balance - p_amount, updated_at = now()
    WHERE id = v_buyer_wallet.id;
  INSERT INTO wallet_ledger (wallet_id, transaction_type, debit, credit, balance_before, balance_after, reference_id)
    VALUES (v_buyer_wallet.id, 'marketplace_purchase', p_amount, 0,
            v_buyer_wallet.wallet_balance, v_buyer_wallet.wallet_balance - p_amount, COALESCE(p_bid_id, v_listing.id));
  INSERT INTO wallet_transactions (wallet_id, type, amount, description, status, currency_code, metadata)
    VALUES (v_buyer_wallet.id, 'marketplace_purchase', -p_amount, 'Marketplace purchase' || v_label, 'completed', 'USD',
            jsonb_build_object('listing_id', v_listing.id, 'bid_id', p_bid_id, 'item_type', v_listing.item_type, 'item_id', v_listing.item_id));

  -- Seller is paid. Re-read: the seller may also be the creator.
  SELECT * INTO v_seller_wallet FROM wallets WHERE user_id = v_listing.seller_id;
  UPDATE wallets SET wallet_balance = wallet_balance + v_seller_proceeds, updated_at = now()
    WHERE id = v_seller_wallet.id;
  INSERT INTO wallet_ledger (wallet_id, transaction_type, debit, credit, balance_before, balance_after, reference_id)
    VALUES (v_seller_wallet.id, 'marketplace_sale', 0, v_seller_proceeds,
            v_seller_wallet.wallet_balance, v_seller_wallet.wallet_balance + v_seller_proceeds, v_listing.id);
  INSERT INTO wallet_transactions (wallet_id, type, amount, description, status, currency_code, metadata)
    VALUES (v_seller_wallet.id, 'marketplace_sale', v_seller_proceeds, 'Marketplace sale proceeds' || v_label, 'completed', 'USD',
            jsonb_build_object('listing_id', v_listing.id, 'bid_id', p_bid_id));

  -- Original creator's royalty on every resale.
  IF v_royalty > 0 THEN
    SELECT * INTO v_creator_wallet FROM wallets WHERE user_id = v_listing.creator_id;
    UPDATE wallets SET wallet_balance = wallet_balance + v_royalty, updated_at = now()
      WHERE id = v_creator_wallet.id;
    INSERT INTO wallet_ledger (wallet_id, transaction_type, debit, credit, balance_before, balance_after, reference_id)
      VALUES (v_creator_wallet.id, 'marketplace_royalty', 0, v_royalty,
              v_creator_wallet.wallet_balance, v_creator_wallet.wallet_balance + v_royalty, v_listing.id);
    INSERT INTO wallet_transactions (wallet_id, type, amount, description, status, currency_code, metadata)
      VALUES (v_creator_wallet.id, 'marketplace_royalty', v_royalty, 'Creator royalty from resale' || v_label, 'completed', 'USD',
              jsonb_build_object('listing_id', v_listing.id, 'bid_id', p_bid_id));
  END IF;

  INSERT INTO marketplace_ownership_history (
    item_type, item_id, listing_id, bid_id, from_user_id, to_user_id,
    sale_price, platform_fee_pct, platform_fee_amount, royalty_amount, royalty_recipient_id, seller_proceeds
  ) VALUES (
    v_listing.item_type, v_listing.item_id, v_listing.id, p_bid_id, v_listing.seller_id, p_buyer_id,
    p_amount, v_platform_fee_pct, v_platform_fee, v_royalty,
    CASE WHEN v_royalty > 0 THEN v_listing.creator_id ELSE NULL END, v_seller_proceeds
  ) RETURNING * INTO v_history;

  PERFORM record_revenue(
    p_source => 'marketplace_commission', p_user_id => v_listing.seller_id, p_reference_id => v_listing.id,
    p_gross_amount => p_amount, p_revenue_amount => v_platform_fee, p_currency => 'USD',
    p_payment_method => 'wallet', p_original_currency => 'USD', p_original_amount => p_amount,
    p_metadata => jsonb_build_object('listing_id', v_listing.id, 'bid_id', p_bid_id, 'buyer_id', p_buyer_id)
  );

  UPDATE marketplace_listings SET status = 'sold', updated_at = now() WHERE id = v_listing.id;

  RETURN v_history;
END;
$function$;
REVOKE ALL ON FUNCTION public.settle_marketplace_sale(uuid, uuid, numeric, uuid) FROM PUBLIC, anon, authenticated;

-- ── accept_marketplace_bid ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.accept_marketplace_bid(p_bid_id uuid, p_seller_id uuid)
 RETURNS marketplace_ownership_history
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_bid marketplace_bids%ROWTYPE;
  v_listing marketplace_listings%ROWTYPE;
  v_hold wallet_holds%ROWTYPE;
  v_history marketplace_ownership_history%ROWTYPE;
BEGIN
  IF p_seller_id <> auth.uid() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT * INTO v_bid FROM marketplace_bids WHERE id = p_bid_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bid not found';
  END IF;
  IF v_bid.status <> 'active' THEN
    RAISE EXCEPTION 'Bid is not active';
  END IF;
  IF v_bid.expires_at IS NOT NULL AND v_bid.expires_at <= now() THEN
    RAISE EXCEPTION 'This bid has expired';
  END IF;

  SELECT * INTO v_listing FROM marketplace_listings WHERE id = v_bid.listing_id FOR UPDATE;
  IF v_listing.seller_id <> p_seller_id THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF v_listing.status <> 'active' THEN
    RAISE EXCEPTION 'Listing is not active';
  END IF;
  IF v_listing.expires_at IS NOT NULL AND v_listing.expires_at <= now() THEN
    RAISE EXCEPTION 'This listing has expired';
  END IF;

  -- The bid must still be backed by its escrow hold.
  SELECT * INTO v_hold FROM wallet_holds WHERE id = v_bid.wallet_hold_id FOR UPDATE;
  IF NOT FOUND OR v_hold.status <> 'held' OR v_hold.amount < v_bid.amount THEN
    RAISE EXCEPTION 'This bid is no longer funded';
  END IF;

  -- Mark the bid accepted and capture its hold first, so the release trigger
  -- never touches it and the buyer's own hold doesn't count against them.
  UPDATE wallet_holds SET status = 'captured' WHERE id = v_hold.id;
  UPDATE marketplace_bids SET status = 'accepted', decided_at = now() WHERE id = v_bid.id;

  v_history := settle_marketplace_sale(v_listing.id, v_bid.bidder_id, v_bid.amount, v_bid.id);

  UPDATE marketplace_bids SET status = 'rejected', decided_at = now()
    WHERE listing_id = v_listing.id AND id <> v_bid.id AND status = 'active';

  RETURN v_history;
END;
$function$;

-- ── accept_marketplace_buy_now ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.accept_marketplace_buy_now(p_listing_id uuid, p_buyer_id uuid)
 RETURNS marketplace_ownership_history
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_listing marketplace_listings%ROWTYPE;
  v_buyer_wallet_id uuid;
  v_history marketplace_ownership_history%ROWTYPE;
BEGIN
  IF p_buyer_id <> auth.uid() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT * INTO v_listing FROM marketplace_listings WHERE id = p_listing_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Listing not found';
  END IF;
  IF v_listing.status <> 'active' THEN
    RAISE EXCEPTION 'Listing is not active';
  END IF;
  IF v_listing.expires_at IS NOT NULL AND v_listing.expires_at <= now() THEN
    RAISE EXCEPTION 'This listing has expired';
  END IF;
  IF v_listing.buy_now_price IS NULL OR v_listing.buy_now_price <= 0 THEN
    RAISE EXCEPTION 'This listing has no buy-now price';
  END IF;
  IF v_listing.seller_id = p_buyer_id THEN
    RAISE EXCEPTION 'Cannot buy your own listing';
  END IF;

  v_buyer_wallet_id := ensure_wallet(p_buyer_id);
  PERFORM 1 FROM wallets WHERE id = v_buyer_wallet_id FOR UPDATE;
  IF wallet_available_balance(v_buyer_wallet_id) < v_listing.buy_now_price THEN
    RAISE EXCEPTION 'Insufficient available balance';
  END IF;

  v_history := settle_marketplace_sale(v_listing.id, p_buyer_id, v_listing.buy_now_price, NULL);

  UPDATE marketplace_bids SET status = 'rejected', decided_at = now()
    WHERE listing_id = v_listing.id AND status = 'active';

  RETURN v_history;
END;
$function$;

-- ── 5. consume_app_balance: never spend escrowed money ───────────────────────
-- Same as 047, except the wallet part is checked against the available
-- balance (wallet_balance minus active holds).
CREATE OR REPLACE FUNCTION public.consume_app_balance(
  p_amount numeric,
  p_description text DEFAULT 'In-app purchase'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wallet wallets%ROWTYPE;
  v_voucher_total numeric;
  v_voucher_to_use numeric;
  v_voucher_used numeric;
  v_wallet_to_use numeric;
  v_voucher record;
  v_take numeric;
BEGIN
  IF auth.uid() IS NULL OR p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid purchase request');
  END IF;
  PERFORM expire_spend_vouchers();
  SELECT * INTO v_wallet FROM wallets WHERE user_id = auth.uid() FOR UPDATE;
  IF v_wallet.id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Wallet not found'); END IF;

  SELECT COALESCE(SUM(remaining_amount), 0) INTO v_voucher_total
  FROM spend_vouchers WHERE recipient_wallet_id = v_wallet.id AND status = 'active' AND remaining_amount > 0;
  v_voucher_to_use := LEAST(p_amount, v_voucher_total);
  v_voucher_used := v_voucher_to_use;
  v_wallet_to_use := p_amount - v_voucher_to_use;
  IF wallet_available_balance(v_wallet.id) < v_wallet_to_use THEN
    RETURN jsonb_build_object('success', false, 'error', 'Insufficient wallet and spend voucher balance (money held for your active bids is not spendable)');
  END IF;

  FOR v_voucher IN
    SELECT id, remaining_amount FROM spend_vouchers
    WHERE recipient_wallet_id = v_wallet.id AND status = 'active' AND remaining_amount > 0
    ORDER BY expires_at, created_at, id FOR UPDATE
  LOOP
    EXIT WHEN v_voucher_to_use <= 0;
    v_take := LEAST(v_voucher_to_use, v_voucher.remaining_amount);
    UPDATE spend_vouchers SET remaining_amount = remaining_amount - v_take WHERE id = v_voucher.id;
    v_voucher_to_use := v_voucher_to_use - v_take;
  END LOOP;

  IF v_wallet_to_use > 0 THEN
    UPDATE wallets SET wallet_balance = wallet_balance - v_wallet_to_use, updated_at = now() WHERE id = v_wallet.id;
  END IF;
  INSERT INTO wallet_transactions (wallet_id, type, amount, description, status, currency_code, metadata)
  VALUES (v_wallet.id, 'app_purchase', -p_amount, p_description, 'completed', 'USD',
    jsonb_build_object('voucher_amount', v_voucher_used, 'wallet_amount', v_wallet_to_use));
  RETURN jsonb_build_object('success', true, 'voucher_amount', v_voucher_used,
    'wallet_amount', v_wallet_to_use, 'wallet_balance', v_wallet.wallet_balance - v_wallet_to_use);
END;
$$;
GRANT EXECUTE ON FUNCTION public.consume_app_balance(numeric, text) TO authenticated;

COMMIT;
