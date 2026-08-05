-- Follow-up to migration 013 (public_marketplace_bids):
--
-- 1. Replaces the per-row correlated subquery for is_highest_bid with a
--    window function -- one pass per listing instead of re-scanning that
--    listing's bids for every single row.
-- 2. Adds bid_count (window COUNT) and previous_amount (the highest bid
--    immediately before this one landed, via a windowed MAX over preceding
--    rows) so a client can show "$85 -> $91 (+$6)" per bid without a second
--    query.
-- 3. Adds listing context (item_type, item_id, starting_price, ends_at,
--    listed_at) directly on the view, so a future consumer that only cares
--    about bid activity doesn't need a second join to marketplace_listings
--    just to show "Starting $50 * 2h remaining".
--
-- CREATE OR REPLACE VIEW only appends these as new trailing columns -- the
-- original id/listing_id/amount/created_at/bidder_alias/is_highest_bid/
-- is_mine stay in the same order with the same types, so anything already
-- selecting specific columns from this view (engagementFeedService.js)
-- keeps working unchanged.
CREATE OR REPLACE VIEW public.public_marketplace_bids AS
SELECT
  mb.id,
  mb.listing_id,
  mb.amount,
  mb.created_at,
  public.bid_alias(mb.bidder_id, mb.listing_id) AS bidder_alias,
  mb.amount = MAX(mb.amount) OVER (PARTITION BY mb.listing_id) AS is_highest_bid,
  mb.bidder_id = auth.uid() AS is_mine,
  COUNT(*) OVER (PARTITION BY mb.listing_id) AS bid_count,
  MAX(mb.amount) OVER (
    PARTITION BY mb.listing_id ORDER BY mb.created_at
    ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
  ) AS previous_amount,
  ml.item_type,
  ml.item_id,
  ml.asking_price AS starting_price,
  ml.expires_at   AS ends_at,
  ml.created_at   AS listed_at
FROM marketplace_bids mb
JOIN marketplace_listings ml ON ml.id = mb.listing_id
WHERE mb.status = 'active' AND ml.status = 'active';

GRANT SELECT ON public.public_marketplace_bids TO authenticated, anon;
