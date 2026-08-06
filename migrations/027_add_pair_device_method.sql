-- Recovered from the bookofmemes-backend GitHub repo's independent migration
-- history (originally '004_add_pair_device_method.sql') -- that repo accumulated its own migrations
-- (numbered 002-020 + add_currencies_table) in parallel with this local
-- checkout's own 001-024, both apparently run against the same live Supabase
-- project without ever being reconciled. Renumbered here (025+) to merge both
-- histories into one record without colliding filenames -- content unchanged.

-- Add 'pair_device' to the deposits method check constraint.
-- Run Step 1 first to confirm the existing allowed values, then run Step 2.

-- Step 1: inspect current constraint
-- SELECT pg_get_constraintdef(oid)
-- FROM pg_constraint
-- WHERE conname = 'deposits_method_check';

-- Step 2: recreate constraint with pair_device included.
-- Replace the IN list below with the full set from Step 1 plus 'pair_device'.
ALTER TABLE deposits DROP CONSTRAINT IF EXISTS deposits_method_check;

ALTER TABLE deposits ADD CONSTRAINT deposits_method_check
  CHECK (method IN ('card', 'bank_transfer', 'p2p', 'market', 'pair_device'));
