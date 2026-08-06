-- Recovered from the bookofmemes-backend GitHub repo's independent migration
-- history (originally '011_fix_puzzles_memes_read_rls.sql') -- that repo accumulated its own migrations
-- (numbered 002-020 + add_currencies_table) in parallel with this local
-- checkout's own 001-024, both apparently run against the same live Supabase
-- project without ever being reconciled. Renumbered here (025+) to merge both
-- histories into one record without colliding filenames -- content unchanged.

-- Fix: puzzles and memes block anon/authenticated SELECT entirely (confirmed
-- via anon-key REST calls returning [] while service-role sees all rows) --
-- unlike stories/kids_collections, which are publicly readable. Without this,
-- MemesBox.js and PuzzlesBox.js will always render empty regardless of how
-- much content exists, since the app queries with the anon key.
--
-- Matches the public-read convention already used elsewhere (see the
-- `interactions` table policy noted in project memory: "for select using (true)").

DROP POLICY IF EXISTS "Public read access" ON puzzles;
CREATE POLICY "Public read access" ON puzzles FOR SELECT USING (true);
GRANT SELECT ON puzzles TO anon, authenticated;

DROP POLICY IF EXISTS "Public read access" ON memes;
CREATE POLICY "Public read access" ON memes FOR SELECT USING (true);
GRANT SELECT ON memes TO anon, authenticated;

-- Verify (run as anon/authenticated in the app -- this SQL editor check still
-- uses your elevated role, so it isn't proof by itself, but confirms the
-- policies now exist)
SELECT schemaname, tablename, policyname, cmd, qual
FROM pg_policies
WHERE tablename IN ('puzzles', 'memes')
ORDER BY tablename, policyname;
