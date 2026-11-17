-- 063: Marketplace notifications that were missing.
--
--   * "You've been outbid" to the bidder who was leading when someone bids more.
--   * "Auction ends within 24 hours" to every bidder (with whether they're
--     winning), alongside the owner's existing reminder.
--   * "Your listing ended without a sale" to the owner, when it ends with no
--     bids, or when no bid met the reserve and none was accepted.
--
-- place_cash_bid and process_marketplace_deadlines are 057's, unchanged apart
-- from these notifications. notifications.type has no check constraint.
BEGIN;

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
  v_leader record;
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

  -- Who was winning before this bid; told they've been outbid unless it's this bidder raising.
  SELECT b.bidder_id, b.amount INTO v_leader FROM marketplace_bids b
    WHERE b.listing_id = p_listing_id AND b.status = 'active'
    ORDER BY b.amount DESC, b.created_at ASC LIMIT 1;

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
  IF v_leader.bidder_id IS NOT NULL AND v_leader.bidder_id <> v_uid AND p_amount > v_leader.amount THEN
    PERFORM market_notify(v_leader.bidder_id, 'marketplace_outbid', 'You''ve been outbid',
      'Someone bid ' || market_money(p_amount, v_listing.listing_currency) || ', more than your '
      || market_money(v_leader.amount, v_listing.listing_currency) || '. Raise your bid before '
      || COALESCE(to_char(v_listing.expires_at AT TIME ZONE 'UTC', 'DD Mon HH24:MI') || ' UTC', 'bidding closes')
      || ' to stay in the lead.', p_listing_id);
  END IF;
  RETURN v_bid;
END;
$$;
GRANT EXECUTE ON FUNCTION public.place_cash_bid(uuid, numeric) TO authenticated;

CREATE OR REPLACE FUNCTION public.process_marketplace_deadlines()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s market_settings%ROWTYPE;
  v_l record;
  v_top record;
  v_b record;
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
    -- Everyone with an open bid hears too, and whether they're winning.
    FOR v_b IN
      SELECT DISTINCT ON (b.bidder_id) b.bidder_id, b.amount,
             b.amount = (SELECT max(x.amount) FROM marketplace_bids x WHERE x.listing_id = v_l.id AND x.status = 'active') AS leading
        FROM marketplace_bids b
       WHERE b.listing_id = v_l.id AND b.status = 'active'
       ORDER BY b.bidder_id, b.amount DESC
    LOOP
      PERFORM market_notify(v_b.bidder_id, 'marketplace_bid_ending', 'Auction ends within 24 hours',
        CASE WHEN v_b.leading
          THEN 'An auction you bid on ends soon. Your bid is the highest right now.'
          ELSE 'An auction you bid on ends soon and you''ve been outbid. Raise your bid to stay in.' END, v_l.id);
    END LOOP;
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
      PERFORM market_notify(v_l.seller_id, 'marketplace_unsold', 'Your listing ended without a sale',
        'Nobody bid before it ended. The item is still yours; you can list it again.', v_l.id);
      n_expired := n_expired + 1;
    END IF;
  END LOOP;

  -- Decision window over: highest bid meeting the reserve wins, else refund all.
  -- Bids and the reserve are both in the listing currency.
  FOR v_l IN
    SELECT l.id, l.seller_id, l.reserve_price, l.listing_currency FROM marketplace_listings l
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
      PERFORM market_notify(v_l.seller_id, 'marketplace_unsold', 'Your listing ended without a sale',
        'No bid reached your reserve of ' || market_money(v_l.reserve_price, v_l.listing_currency)
        || ' and none was accepted in time. Every bid has been refunded and the item is still yours.', v_l.id);
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

COMMIT;
