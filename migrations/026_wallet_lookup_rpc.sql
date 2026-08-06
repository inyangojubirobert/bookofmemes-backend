-- Recovered from the bookofmemes-backend GitHub repo's independent migration
-- history (originally '003_wallet_lookup_rpc.sql') -- that repo accumulated its own migrations
-- (numbered 002-020 + add_currencies_table) in parallel with this local
-- checkout's own 001-024, both apparently run against the same live Supabase
-- project without ever being reconciled. Renumbered here (025+) to merge both
-- histories into one record without colliding filenames -- content unchanged.

-- Run this once in the Supabase SQL Editor.
-- Creates a SECURITY DEFINER function so any authenticated user can look up
-- a wallet's owner profile by wallet ID — bypassing RLS on wallets/profiles.

CREATE OR REPLACE FUNCTION lookup_wallet_profile(p_wallet_id UUID)
RETURNS TABLE (
  wallet_id   UUID,
  user_id     UUID,
  full_name   TEXT,
  avatar_url  TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    w.id        AS wallet_id,
    w.user_id   AS user_id,
    p.full_name AS full_name,
    p.avatar_url AS avatar_url
  FROM wallets w
  JOIN profiles p ON p.id = w.user_id
  WHERE w.id = p_wallet_id
  LIMIT 1;
END;
$$;

-- Grant execution to authenticated users only
REVOKE ALL ON FUNCTION lookup_wallet_profile(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lookup_wallet_profile(UUID) TO authenticated;
