-- Refinements to the revenue ledger from migration 001, applied before any real
-- revenue_transactions rows exist (confirmed empty) so no backfill risk:
--
-- 1. revenue_transactions now joins revenue_sources by source_id (uuid), not by
--    the source text -- renaming a source later no longer requires touching
--    history. `source` is kept as a second, non-FK column: an immutable label
--    snapshot taken at insert time, so old rows stay human-readable without a
--    join even after a source is renamed.
-- 2. revenue_sources gets a `category` column (marketplace / exchange /
--    withdrawal / other) for dashboard grouping -- this is a property of the
--    source itself, not of each individual transaction, so it lives there
--    rather than being duplicated onto every row.
-- 3. revenue_transactions gets payment_method, original_currency, original_amount
--    as first-class columns -- previously only inside metadata jsonb for
--    currency_spread, not queryable/aggregatable.
-- 4. currencies gets min_fee_usd / max_fee_usd, applied in convert_currency_to_usd,
--    so a tiny conversion can't earn a fraction of a cent and a huge one can't
--    pay a disproportionate flat-percentage spread.

-- ── revenue_sources: category ────────────────────────────────────────────────
ALTER TABLE revenue_sources ADD COLUMN category text;
UPDATE revenue_sources SET category = CASE source
  WHEN 'currency_spread'        THEN 'exchange'
  WHEN 'marketplace_listing'    THEN 'marketplace'
  WHEN 'marketplace_featured'   THEN 'marketplace'
  WHEN 'marketplace_commission' THEN 'marketplace'
  WHEN 'cashout_margin'         THEN 'withdrawal'
  ELSE 'other'
END;
ALTER TABLE revenue_sources ALTER COLUMN category SET NOT NULL;

-- ── revenue_transactions: source_id (decoupled from renames) ───────────────
ALTER TABLE revenue_transactions ADD COLUMN source_id uuid REFERENCES revenue_sources(id);
UPDATE revenue_transactions rt SET source_id = rs.id FROM revenue_sources rs WHERE rt.source = rs.source;
ALTER TABLE revenue_transactions ALTER COLUMN source_id SET NOT NULL;
ALTER TABLE revenue_transactions DROP CONSTRAINT revenue_transactions_source_fkey;
-- `source` (text) remains as an immutable point-in-time label, no longer FK-constrained.

-- ── revenue_transactions: payment context ───────────────────────────────────
ALTER TABLE revenue_transactions ADD COLUMN payment_method text;
ALTER TABLE revenue_transactions ADD COLUMN original_currency text;
ALTER TABLE revenue_transactions ADD COLUMN original_amount numeric;
UPDATE revenue_transactions SET
  payment_method = COALESCE(payment_method, 'wallet'),
  original_currency = COALESCE(original_currency, currency),
  original_amount = COALESCE(original_amount, gross_amount);
ALTER TABLE revenue_transactions ALTER COLUMN payment_method SET NOT NULL;
ALTER TABLE revenue_transactions ALTER COLUMN original_currency SET NOT NULL;
ALTER TABLE revenue_transactions ALTER COLUMN original_amount SET NOT NULL;

-- ── currencies: fee floor/ceiling ────────────────────────────────────────────
ALTER TABLE currencies ADD COLUMN min_fee_usd numeric NOT NULL DEFAULT 0.02;
ALTER TABLE currencies ADD COLUMN max_fee_usd numeric NOT NULL DEFAULT 25.00;
UPDATE currencies SET min_fee_usd = 0, max_fee_usd = 0 WHERE code = 'USD';

-- ── record_revenue: new signature ────────────────────────────────────────────
-- CREATE OR REPLACE cannot change a function's parameter list -- the old 7-arg
-- version must be dropped explicitly, or it would remain live as an unused,
-- never-updated stale overload (see the 037_drop_stale_create_listing_overload
-- precedent from the earlier migration history).
DROP FUNCTION IF EXISTS record_revenue(text, uuid, uuid, numeric, numeric, text, jsonb);

CREATE OR REPLACE FUNCTION record_revenue(
  p_source text, p_user_id uuid, p_reference_id uuid,
  p_gross_amount numeric, p_revenue_amount numeric,
  p_currency text DEFAULT 'USD',
  p_payment_method text DEFAULT 'wallet',
  p_original_currency text DEFAULT NULL,
  p_original_amount numeric DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_source_id uuid;
BEGIN
  IF p_revenue_amount <= 0 THEN
    RETURN;
  END IF;

  SELECT id INTO v_source_id FROM revenue_sources WHERE source = p_source AND enabled = true;
  IF v_source_id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO revenue_transactions (
    user_id, reference_id, source_id, source, gross_amount, revenue_amount, currency,
    payment_method, original_currency, original_amount, metadata
  ) VALUES (
    p_user_id, p_reference_id, v_source_id, p_source, p_gross_amount, p_revenue_amount, p_currency,
    p_payment_method, COALESCE(p_original_currency, p_currency), COALESCE(p_original_amount, p_gross_amount), p_metadata
  );
END;
$$;

REVOKE ALL ON FUNCTION record_revenue(text, uuid, uuid, numeric, numeric, text, text, text, numeric, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_revenue(text, uuid, uuid, numeric, numeric, text, text, text, numeric, jsonb) FROM anon, authenticated;

-- ── convert_currency_to_usd: fee cap + richer record_revenue call ──────────
CREATE OR REPLACE FUNCTION public.convert_currency_to_usd(p_wallet_id uuid, p_user_id uuid, p_currency_code text, p_amount numeric DEFAULT NULL::numeric)
 RETURNS TABLE(converted_usd numeric, original_amount numeric, rate_used numeric, remaining_balance numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_wallet wallets%ROWTYPE;
  v_wc wallet_currencies%ROWTYPE;
  v_rate numeric;
  v_rate_updated_at timestamptz;
  v_amount numeric;
  v_gross_usd_amount numeric;
  v_spread_pct numeric;
  v_min_fee numeric;
  v_max_fee numeric;
  v_usd_amount numeric;
  v_revenue numeric;
BEGIN
  IF p_user_id <> auth.uid() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF p_currency_code = 'USD' THEN
    RAISE EXCEPTION 'USD does not need conversion';
  END IF;

  SELECT rate, updated_at INTO v_rate, v_rate_updated_at
    FROM exchange_rates WHERE base_currency = 'USD' AND quote_currency = p_currency_code;
  IF v_rate IS NULL THEN
    RAISE EXCEPTION 'No exchange rate available for % yet -- try again shortly', p_currency_code;
  END IF;
  IF v_rate_updated_at < now() - interval '48 hours' THEN
    RAISE EXCEPTION 'Exchange rate for % is more than 48 hours old (last updated %) -- refresh has likely stalled', p_currency_code, v_rate_updated_at;
  END IF;

  SELECT * INTO v_wallet FROM wallets WHERE id = p_wallet_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Wallet not found';
  END IF;

  SELECT * INTO v_wc FROM wallet_currencies WHERE wallet_id = p_wallet_id AND currency_code = p_currency_code FOR UPDATE;
  IF NOT FOUND OR v_wc.balance <= 0 THEN
    RAISE EXCEPTION 'No % balance to convert', p_currency_code;
  END IF;

  -- Partial conversion: default to the full balance if no amount given.
  v_amount := COALESCE(p_amount, v_wc.balance);
  IF v_amount <= 0 OR v_amount > v_wc.balance THEN
    RAISE EXCEPTION 'Invalid amount: must be between 0 and your current balance (%)', v_wc.balance;
  END IF;

  SELECT COALESCE(spread_percent, 0), COALESCE(min_fee_usd, 0), COALESCE(max_fee_usd, 999999)
    INTO v_spread_pct, v_min_fee, v_max_fee
    FROM currencies WHERE code = p_currency_code;

  -- open.er-api.com's rates are "1 USD = rate units of currency", so converting
  -- FROM that currency TO USD divides by the rate. The spread-based fee is
  -- clamped to [min_fee_usd, max_fee_usd] so a tiny conversion doesn't earn a
  -- fraction of a cent and a large one doesn't pay a disproportionate flat
  -- percentage -- then capped again at the gross amount itself as a final
  -- sanity bound. wallet_balance is numeric(12,2) so the credited amount is
  -- necessarily 2dp, but the rate and original amount are kept at full
  -- precision in the transaction metadata.
  v_gross_usd_amount := v_amount / v_rate;
  v_revenue := ROUND(v_gross_usd_amount * v_spread_pct, 2);
  v_revenue := GREATEST(v_min_fee, LEAST(v_revenue, v_max_fee));
  v_revenue := LEAST(v_revenue, ROUND(v_gross_usd_amount, 2));
  v_usd_amount := ROUND(v_gross_usd_amount, 2) - v_revenue;

  UPDATE wallet_currencies SET balance = balance - v_amount, updated_at = now() WHERE id = v_wc.id;
  UPDATE wallets SET wallet_balance = wallet_balance + v_usd_amount, updated_at = now() WHERE id = v_wallet.id;

  INSERT INTO wallet_ledger (wallet_id, transaction_type, debit, credit, balance_before, balance_after, reference_id)
    VALUES (v_wallet.id, 'currency_conversion', 0, v_usd_amount,
            v_wallet.wallet_balance, v_wallet.wallet_balance + v_usd_amount, v_wc.id);

  INSERT INTO wallet_transactions (wallet_id, type, amount, description, status, currency_code, metadata)
    VALUES (v_wallet.id, 'currency_conversion', v_usd_amount,
            'Converted ' || v_amount || ' ' || p_currency_code || ' to USD (rate: ' || v_rate || ', spread: ' || (v_spread_pct * 100) || '%)',
            'completed', 'USD',
            jsonb_build_object(
              'from_currency', p_currency_code, 'from_amount', v_amount,
              'rate', v_rate, 'rate_provider', 'open.er-api.com', 'rate_updated_at', v_rate_updated_at,
              'spread_percent', v_spread_pct, 'revenue_amount', v_revenue
            ));

  PERFORM record_revenue(
    p_source => 'currency_spread', p_user_id => p_user_id, p_reference_id => v_wc.id,
    p_gross_amount => ROUND(v_gross_usd_amount, 2), p_revenue_amount => v_revenue, p_currency => 'USD',
    p_payment_method => 'wallet', p_original_currency => p_currency_code, p_original_amount => v_amount,
    p_metadata => jsonb_build_object('rate', v_rate, 'spread_percent', v_spread_pct)
  );

  RETURN QUERY SELECT v_usd_amount, v_amount, v_rate, (v_wc.balance - v_amount);
END;
$function$;

-- ── create_marketplace_listing: richer record_revenue call ─────────────────
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
BEGIN
  IF p_seller_id <> auth.uid() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF p_item_type NOT IN ('stories', 'memes', 'puzzles', 'kids_collections', 'music_box', 'podcast_box', 'tv_box') THEN
    RAISE EXCEPTION 'Invalid item_type: %', p_item_type;
  END IF;
  IF p_asking_price <= 0 THEN
    RAISE EXCEPTION 'asking_price must be greater than 0';
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
  IF v_listing_type IN ('auction_buy_now', 'fixed_price') AND v_buy_now_price IS NULL THEN
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

  SELECT * INTO v_wallet FROM wallets WHERE user_id = p_seller_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Wallet not found';
  END IF;
  IF v_wallet.wallet_balance < v_listing_fee THEN
    RAISE EXCEPTION 'Insufficient balance for listing fee ($% required)', v_listing_fee;
  END IF;

  INSERT INTO marketplace_listings (
    item_type, item_id, seller_id, creator_id, asking_price, buy_now_price,
    reserve_price, minimum_increment, royalty_pct, expires_at, listing_fee_paid, listing_type
  ) VALUES (
    p_item_type, p_item_id, p_seller_id, v_author_id, p_asking_price, v_buy_now_price,
    p_reserve_price, COALESCE(p_minimum_increment, 10), COALESCE(p_royalty_pct, 5.00), p_expires_at, v_listing_fee, v_listing_type
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

-- ── feature_marketplace_listing: richer record_revenue call ────────────────
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

  SELECT * INTO v_wallet FROM wallets WHERE user_id = p_seller_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Wallet not found';
  END IF;
  IF v_wallet.wallet_balance < v_fee THEN
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

-- ── accept_marketplace_bid: richer record_revenue call ──────────────────────
CREATE OR REPLACE FUNCTION public.accept_marketplace_bid(p_bid_id uuid, p_seller_id uuid)
 RETURNS marketplace_ownership_history
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_bid marketplace_bids%ROWTYPE;
  v_listing marketplace_listings%ROWTYPE;
  v_buyer_wallet wallets%ROWTYPE;
  v_seller_wallet wallets%ROWTYPE;
  v_creator_wallet wallets%ROWTYPE;
  v_platform_fee_pct numeric := 5.00;
  v_platform_fee numeric;
  v_royalty numeric;
  v_seller_proceeds numeric;
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

  SELECT * INTO v_listing FROM marketplace_listings WHERE id = v_bid.listing_id FOR UPDATE;
  IF v_listing.seller_id <> p_seller_id THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF v_listing.status <> 'active' THEN
    RAISE EXCEPTION 'Listing is not active';
  END IF;

  SELECT * INTO v_buyer_wallet FROM wallets WHERE user_id = v_bid.bidder_id FOR UPDATE;
  SELECT * INTO v_seller_wallet FROM wallets WHERE user_id = p_seller_id FOR UPDATE;

  v_platform_fee := ROUND(v_bid.amount * v_platform_fee_pct / 100, 2);
  v_royalty := CASE
    WHEN v_listing.creator_id = p_seller_id THEN 0
    ELSE ROUND(v_bid.amount * v_listing.royalty_pct / 100, 2)
  END;
  v_seller_proceeds := v_bid.amount - v_platform_fee - v_royalty;

  -- Capture the winning hold and debit the buyer.
  UPDATE wallet_holds SET status = 'captured' WHERE id = v_bid.wallet_hold_id AND status = 'held';
  UPDATE wallets SET wallet_balance = wallet_balance - v_bid.amount, updated_at = now()
    WHERE id = v_buyer_wallet.id;
  INSERT INTO wallet_ledger (wallet_id, transaction_type, debit, credit, balance_before, balance_after, reference_id)
    VALUES (v_buyer_wallet.id, 'marketplace_purchase', v_bid.amount, 0,
            v_buyer_wallet.wallet_balance, v_buyer_wallet.wallet_balance - v_bid.amount, v_bid.id);
  INSERT INTO wallet_transactions (wallet_id, type, amount, description, status, currency_code, metadata)
    VALUES (v_buyer_wallet.id, 'marketplace_purchase', -v_bid.amount, 'Marketplace purchase (bid accepted)', 'completed', 'USD',
            jsonb_build_object('listing_id', v_listing.id, 'bid_id', v_bid.id, 'item_type', v_listing.item_type, 'item_id', v_listing.item_id));

  -- Credit the seller.
  UPDATE wallets SET wallet_balance = wallet_balance + v_seller_proceeds, updated_at = now()
    WHERE id = v_seller_wallet.id;
  INSERT INTO wallet_ledger (wallet_id, transaction_type, debit, credit, balance_before, balance_after, reference_id)
    VALUES (v_seller_wallet.id, 'marketplace_sale', 0, v_seller_proceeds,
            v_seller_wallet.wallet_balance, v_seller_wallet.wallet_balance + v_seller_proceeds, v_listing.id);
  INSERT INTO wallet_transactions (wallet_id, type, amount, description, status, currency_code, metadata)
    VALUES (v_seller_wallet.id, 'marketplace_sale', v_seller_proceeds, 'Marketplace sale proceeds', 'completed', 'USD',
            jsonb_build_object('listing_id', v_listing.id, 'bid_id', v_bid.id));

  -- Credit the original creator's royalty, if this isn't the creator's own primary sale.
  IF v_royalty > 0 THEN
    SELECT * INTO v_creator_wallet FROM wallets WHERE user_id = v_listing.creator_id FOR UPDATE;
    UPDATE wallets SET wallet_balance = wallet_balance + v_royalty, updated_at = now()
      WHERE id = v_creator_wallet.id;
    INSERT INTO wallet_ledger (wallet_id, transaction_type, debit, credit, balance_before, balance_after, reference_id)
      VALUES (v_creator_wallet.id, 'marketplace_royalty', 0, v_royalty,
              v_creator_wallet.wallet_balance, v_creator_wallet.wallet_balance + v_royalty, v_listing.id);
    INSERT INTO wallet_transactions (wallet_id, type, amount, description, status, currency_code, metadata)
      VALUES (v_creator_wallet.id, 'marketplace_royalty', v_royalty, 'Creator royalty from resale', 'completed', 'USD',
              jsonb_build_object('listing_id', v_listing.id, 'bid_id', v_bid.id));
  END IF;

  INSERT INTO marketplace_ownership_history (
    item_type, item_id, listing_id, bid_id, from_user_id, to_user_id,
    sale_price, platform_fee_pct, platform_fee_amount, royalty_amount, royalty_recipient_id, seller_proceeds
  ) VALUES (
    v_listing.item_type, v_listing.item_id, v_listing.id, v_bid.id, v_listing.seller_id, v_bid.bidder_id,
    v_bid.amount, v_platform_fee_pct, v_platform_fee, v_royalty,
    CASE WHEN v_royalty > 0 THEN v_listing.creator_id ELSE NULL END, v_seller_proceeds
  ) RETURNING * INTO v_history;

  PERFORM record_revenue(
    p_source => 'marketplace_commission', p_user_id => p_seller_id, p_reference_id => v_listing.id,
    p_gross_amount => v_bid.amount, p_revenue_amount => v_platform_fee, p_currency => 'USD',
    p_payment_method => 'wallet', p_original_currency => 'USD', p_original_amount => v_bid.amount,
    p_metadata => jsonb_build_object('listing_id', v_listing.id, 'bid_id', v_bid.id, 'buyer_id', v_bid.bidder_id)
  );

  UPDATE marketplace_bids SET status = 'accepted', decided_at = now() WHERE id = v_bid.id;
  UPDATE marketplace_listings SET status = 'sold', updated_at = now() WHERE id = v_listing.id;

  UPDATE marketplace_bids SET status = 'rejected', decided_at = now()
    WHERE listing_id = v_listing.id AND id <> v_bid.id AND status = 'active';

  RETURN v_history;
END;
$function$;

-- ── accept_marketplace_buy_now: richer record_revenue call ──────────────────
CREATE OR REPLACE FUNCTION public.accept_marketplace_buy_now(p_listing_id uuid, p_buyer_id uuid)
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
  v_held numeric;
  v_available numeric;
  v_platform_fee_pct numeric := 5.00;
  v_platform_fee numeric;
  v_royalty numeric;
  v_seller_proceeds numeric;
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
  IF v_listing.buy_now_price IS NULL THEN
    RAISE EXCEPTION 'This listing has no buy-now price';
  END IF;
  IF v_listing.seller_id = p_buyer_id THEN
    RAISE EXCEPTION 'Cannot buy your own listing';
  END IF;

  SELECT * INTO v_buyer_wallet FROM wallets WHERE user_id = p_buyer_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Wallet not found';
  END IF;
  SELECT COALESCE(SUM(amount), 0) INTO v_held FROM wallet_holds
    WHERE wallet_id = v_buyer_wallet.id AND status = 'held';
  v_available := v_buyer_wallet.wallet_balance - v_held;
  IF v_available < v_listing.buy_now_price THEN
    RAISE EXCEPTION 'Insufficient available balance';
  END IF;

  SELECT * INTO v_seller_wallet FROM wallets WHERE user_id = v_listing.seller_id FOR UPDATE;

  v_platform_fee := ROUND(v_listing.buy_now_price * v_platform_fee_pct / 100, 2);
  v_royalty := CASE
    WHEN v_listing.creator_id = v_listing.seller_id THEN 0
    ELSE ROUND(v_listing.buy_now_price * v_listing.royalty_pct / 100, 2)
  END;
  v_seller_proceeds := v_listing.buy_now_price - v_platform_fee - v_royalty;

  UPDATE wallets SET wallet_balance = wallet_balance - v_listing.buy_now_price, updated_at = now()
    WHERE id = v_buyer_wallet.id;
  INSERT INTO wallet_ledger (wallet_id, transaction_type, debit, credit, balance_before, balance_after, reference_id)
    VALUES (v_buyer_wallet.id, 'marketplace_purchase', v_listing.buy_now_price, 0,
            v_buyer_wallet.wallet_balance, v_buyer_wallet.wallet_balance - v_listing.buy_now_price, v_listing.id);
  INSERT INTO wallet_transactions (wallet_id, type, amount, description, status, currency_code, metadata)
    VALUES (v_buyer_wallet.id, 'marketplace_purchase', -v_listing.buy_now_price, 'Marketplace purchase (buy now)', 'completed', 'USD',
            jsonb_build_object('listing_id', v_listing.id, 'item_type', v_listing.item_type, 'item_id', v_listing.item_id));

  UPDATE wallets SET wallet_balance = wallet_balance + v_seller_proceeds, updated_at = now()
    WHERE id = v_seller_wallet.id;
  INSERT INTO wallet_ledger (wallet_id, transaction_type, debit, credit, balance_before, balance_after, reference_id)
    VALUES (v_seller_wallet.id, 'marketplace_sale', 0, v_seller_proceeds,
            v_seller_wallet.wallet_balance, v_seller_wallet.wallet_balance + v_seller_proceeds, v_listing.id);
  INSERT INTO wallet_transactions (wallet_id, type, amount, description, status, currency_code, metadata)
    VALUES (v_seller_wallet.id, 'marketplace_sale', v_seller_proceeds, 'Marketplace sale proceeds (buy now)', 'completed', 'USD',
            jsonb_build_object('listing_id', v_listing.id));

  IF v_royalty > 0 THEN
    SELECT * INTO v_creator_wallet FROM wallets WHERE user_id = v_listing.creator_id FOR UPDATE;
    UPDATE wallets SET wallet_balance = wallet_balance + v_royalty, updated_at = now()
      WHERE id = v_creator_wallet.id;
    INSERT INTO wallet_ledger (wallet_id, transaction_type, debit, credit, balance_before, balance_after, reference_id)
      VALUES (v_creator_wallet.id, 'marketplace_royalty', 0, v_royalty,
              v_creator_wallet.wallet_balance, v_creator_wallet.wallet_balance + v_royalty, v_listing.id);
    INSERT INTO wallet_transactions (wallet_id, type, amount, description, status, currency_code, metadata)
      VALUES (v_creator_wallet.id, 'marketplace_royalty', v_royalty, 'Creator royalty from resale (buy now)', 'completed', 'USD',
              jsonb_build_object('listing_id', v_listing.id));
  END IF;

  INSERT INTO marketplace_ownership_history (
    item_type, item_id, listing_id, bid_id, from_user_id, to_user_id,
    sale_price, platform_fee_pct, platform_fee_amount, royalty_amount, royalty_recipient_id, seller_proceeds
  ) VALUES (
    v_listing.item_type, v_listing.item_id, v_listing.id, NULL, v_listing.seller_id, p_buyer_id,
    v_listing.buy_now_price, v_platform_fee_pct, v_platform_fee, v_royalty,
    CASE WHEN v_royalty > 0 THEN v_listing.creator_id ELSE NULL END, v_seller_proceeds
  ) RETURNING * INTO v_history;

  PERFORM record_revenue(
    p_source => 'marketplace_commission', p_user_id => v_listing.seller_id, p_reference_id => v_listing.id,
    p_gross_amount => v_listing.buy_now_price, p_revenue_amount => v_platform_fee, p_currency => 'USD',
    p_payment_method => 'wallet', p_original_currency => 'USD', p_original_amount => v_listing.buy_now_price,
    p_metadata => jsonb_build_object('listing_id', v_listing.id, 'buyer_id', p_buyer_id)
  );

  UPDATE marketplace_listings SET status = 'sold', updated_at = now() WHERE id = v_listing.id;

  UPDATE marketplace_bids SET status = 'rejected', decided_at = now()
    WHERE listing_id = v_listing.id AND status = 'active';

  RETURN v_history;
END;
$function$;

-- ── agent_confirm_cashout_paid: richer record_revenue call ──────────────────
CREATE OR REPLACE FUNCTION public.agent_confirm_cashout_paid(p_order_id uuid, p_agent_user_id uuid, p_proof_reference text DEFAULT NULL::text)
 RETURNS agent_orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_order agent_orders%ROWTYPE;
  v_agent agents%ROWTYPE;
  v_wallet wallets%ROWTYPE;
  v_hold_id uuid;
BEGIN
  IF p_agent_user_id <> auth.uid() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT * INTO v_order FROM agent_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;
  SELECT * INTO v_agent FROM agents WHERE id = v_order.agent_id;
  IF v_agent.user_id <> p_agent_user_id THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF v_order.status <> 'pending' THEN
    RAISE EXCEPTION 'Order is not pending (status: %)', v_order.status;
  END IF;

  SELECT * INTO v_wallet FROM wallets WHERE user_id = v_order.customer_id FOR UPDATE;
  SELECT wh.id INTO v_hold_id FROM wallet_holds wh
    JOIN trade_escrow te ON te.wallet_hold_id = wh.id
    WHERE te.order_id = p_order_id AND wh.status = 'held';
  IF v_hold_id IS NULL THEN
    RAISE EXCEPTION 'No active hold found for this order';
  END IF;

  -- Settle: capture the hold and actually debit the user now.
  UPDATE wallet_holds SET status = 'captured' WHERE id = v_hold_id;
  UPDATE wallets SET wallet_balance = wallet_balance - v_order.amount, updated_at = now() WHERE id = v_wallet.id;
  UPDATE trade_escrow SET status = 'settled' WHERE order_id = p_order_id;

  INSERT INTO wallet_ledger (wallet_id, transaction_type, debit, credit, balance_before, balance_after, reference_id)
    VALUES (v_wallet.id, 'cashout', v_order.amount, 0, v_wallet.wallet_balance, v_wallet.wallet_balance - v_order.amount, v_order.id);
  INSERT INTO wallet_transactions (wallet_id, type, amount, description, status, currency_code, metadata)
    VALUES (v_wallet.id, 'cashout', -v_order.amount,
            'Cashout fulfilled by ' || v_agent.business_name, 'completed', 'USD',
            jsonb_build_object('agent_order_id', v_order.id, 'agent_id', v_agent.id, 'proof_reference', p_proof_reference));

  -- Record the margin actually captured on this settlement, in the payout's
  -- own local currency -- see platform_cashout_revenue's comment above.
  IF v_order.agent_rate IS NOT NULL THEN
    INSERT INTO platform_cashout_revenue (order_id, agent_id, currency, margin_pct, amount_captured)
      VALUES (v_order.id, v_agent.id, v_order.to_currency, v_order.platform_margin_pct,
              ROUND(v_order.amount * (v_order.agent_rate - v_order.rate), 2));

    PERFORM record_revenue(
      p_source => 'cashout_margin', p_user_id => v_order.customer_id, p_reference_id => v_order.id,
      p_gross_amount => ROUND(v_order.amount * v_order.agent_rate, 2),
      p_revenue_amount => ROUND(v_order.amount * (v_order.agent_rate - v_order.rate), 2),
      p_currency => v_order.to_currency,
      p_payment_method => 'agent_cashout', p_original_currency => v_order.to_currency,
      p_original_amount => ROUND(v_order.amount * v_order.agent_rate, 2),
      p_metadata => jsonb_build_object('agent_id', v_agent.id, 'margin_pct', v_order.platform_margin_pct)
    );
  END IF;

  -- Free the agent's reserved capacity -- the trust bond isn't spent, only their
  -- in-flight exposure is (see this migration's header comment).
  UPDATE agents SET
    pending_trade_amount = pending_trade_amount - v_order.amount,
    total_volume = total_volume + v_order.total_amount,
    total_trades = total_trades + 1,
    updated_at = now()
  WHERE id = v_agent.id;

  INSERT INTO agent_stats (agent_id, completed_trades, total_volume, total_trades, updated_at)
    VALUES (v_agent.id, 1, v_order.total_amount, 1, now())
    ON CONFLICT (agent_id) DO UPDATE SET
      completed_trades = agent_stats.completed_trades + 1,
      total_volume = agent_stats.total_volume + v_order.total_amount,
      total_trades = agent_stats.total_trades + 1,
      updated_at = now();

  UPDATE agent_orders SET status = 'completed' WHERE id = p_order_id;
  UPDATE cashout_requests SET status = 'completed', processed_at = now(),
    notes = COALESCE(p_proof_reference, notes)
    WHERE agent_order_id = p_order_id;

  INSERT INTO notifications (user_id, type, title, body, reference_id)
    VALUES (v_order.customer_id, 'cashout_completed', 'Cashout Completed',
            'Your cashout of $' || v_order.amount || ' has been fulfilled by ' || v_agent.business_name || '.',
            v_order.id);

  SELECT * INTO v_order FROM agent_orders WHERE id = p_order_id;
  RETURN v_order;
END;
$function$;
