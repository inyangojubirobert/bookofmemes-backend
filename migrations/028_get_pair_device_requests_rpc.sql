-- Recovered from the bookofmemes-backend GitHub repo's independent migration
-- history (originally '005_get_pair_device_requests_rpc.sql') -- that repo accumulated its own migrations
-- (numbered 002-020 + add_currencies_table) in parallel with this local
-- checkout's own 001-024, both apparently run against the same live Supabase
-- project without ever being reconciled. Renumbered here (025+) to merge both
-- histories into one record without colliding filenames -- content unchanged.

-- RPC: get_pair_device_requests
-- Returns pending pair device deposit requests for a given wallet,
-- including full deposit amount/currency and requester profile.
-- SECURITY DEFINER bypasses RLS so User B can read User A's deposit row.

CREATE OR REPLACE FUNCTION get_pair_device_requests(p_wallet_id UUID)
RETURNS TABLE (
  id          UUID,
  status      TEXT,
  created_at  TIMESTAMPTZ,
  deposit     JSONB,
  from_wallet JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    dr.id,
    dr.status,
    dr.created_at,
    jsonb_build_object(
      'id',        d.id,
      'amount',    d.amount,
      'currency',  d.currency,
      'reference', d.reference
    ) AS deposit,
    jsonb_build_object(
      'id',      w.id,
      'user_id', w.user_id,
      'profiles', jsonb_build_object(
        'full_name',  prof.full_name,
        'avatar_url', prof.avatar_url
      )
    ) AS from_wallet
  FROM  deposit_requests dr
  JOIN  deposits d  ON d.id  = dr.deposit_id
  JOIN  wallets  w  ON w.id  = dr.from_wallet_id
  LEFT JOIN profiles prof ON prof.id = w.user_id
  WHERE dr.to_wallet_id = p_wallet_id
    AND dr.status = 'pending'
  ORDER BY dr.created_at DESC;
END;
$$;
