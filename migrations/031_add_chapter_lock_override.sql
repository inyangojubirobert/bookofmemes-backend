-- Recovered from the bookofmemes-backend GitHub repo's independent migration
-- history (originally '008_add_chapter_lock_override.sql') -- that repo accumulated its own migrations
-- (numbered 002-020 + add_currencies_table) in parallel with this local
-- checkout's own 001-024, both apparently run against the same live Supabase
-- project without ever being reconciled. Renumbered here (025+) to merge both
-- histories into one record without colliding filenames -- content unchanged.

-- Optional per-chapter override for the reader's paywall.
-- NULL (default) = fall back to the app's "first N chapters free" rule.
-- true  = force this chapter locked regardless of position.
-- false = force this chapter free regardless of position.
ALTER TABLE chapters ADD COLUMN IF NOT EXISTS is_locked boolean DEFAULT NULL;
