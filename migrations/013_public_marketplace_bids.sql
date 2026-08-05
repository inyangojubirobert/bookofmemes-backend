-- Public, identity-safe window into marketplace_bids for the Bids-tab feed
-- (Screens/Profile/Feeds.js) and any future "Recent Bids"/trending surface.
-- marketplace_bids_select stays exactly as restrictive as it is today
-- (bidder or seller only) -- nothing here loosens that policy. Instead this
-- is a view that exposes only non-identifying columns (amount, created_at,
-- a per-listing alias) to everyone, while bidder_id itself never leaves the
-- database.
--
-- Alias design (per product discussion): deterministic per (bidder, listing)
-- pair, so "Falcon27" bidding twice on one auction reads as the same person
-- and the bid war is legible -- but a DIFFERENT alias on every other listing,
-- so bidding habits can't be tracked across the marketplace. Computed purely
-- from a hash of bidder_id+listing_id, so it's stable without being stored
-- anywhere.
CREATE OR REPLACE FUNCTION public.bid_alias(p_bidder_id uuid, p_listing_id uuid)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $$
  SELECT (ARRAY[
    'Falcon','Nova','Pixel','Crimson','Nebula','Comet','Ember','Frost',
    'Shadow','Blaze','Orbit','Quartz','Raven','Solar','Vertex','Wraith',
    'Aurora','Cipher','Drift','Echo'
  ])[1 + (('x' || substr(md5(p_bidder_id::text || p_listing_id::text), 1, 8))::bit(32)::bigint % 20)]
  || (10 + (('x' || substr(md5(p_bidder_id::text || p_listing_id::text), 9, 8))::bit(32)::bigint % 90))::text;
$$;

-- SECURITY: this view intentionally works by NOT restricting via RLS -- a
-- view runs as its owning role for the purposes of the underlying table's
-- row security, so a view owned by the migration-running (table-owning)
-- role bypasses marketplace_bids' own RLS for anyone selecting the VIEW,
-- while the view's column list simply never includes bidder_id. That's the
-- privacy boundary: not "who can query this," but "what columns exist to
-- query." Only active bids on active listings are exposed -- withdrawn/
-- rejected bids and closed listings stay fully private.
CREATE OR REPLACE VIEW public.public_marketplace_bids AS
SELECT
  mb.id,
  mb.listing_id,
  mb.amount,
  mb.created_at,
  public.bid_alias(mb.bidder_id, mb.listing_id) AS bidder_alias,
  mb.amount = (
    SELECT MAX(b2.amount) FROM marketplace_bids b2
    WHERE b2.listing_id = mb.listing_id AND b2.status = 'active'
  ) AS is_highest_bid,
  -- Lets the querying user's own bids read as "You bid $X" client-side
  -- without exposing bidder_id for anyone else's row.
  mb.bidder_id = auth.uid() AS is_mine
FROM marketplace_bids mb
JOIN marketplace_listings ml ON ml.id = mb.listing_id
WHERE mb.status = 'active' AND ml.status = 'active';

GRANT SELECT ON public.public_marketplace_bids TO authenticated, anon;
