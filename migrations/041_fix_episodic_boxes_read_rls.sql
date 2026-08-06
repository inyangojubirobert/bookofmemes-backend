-- Recovered from the bookofmemes-backend GitHub repo's independent migration
-- history (originally '018_fix_episodic_boxes_read_rls.sql') -- that repo accumulated its own migrations
-- (numbered 002-020 + add_currencies_table) in parallel with this local
-- checkout's own 001-024, both apparently run against the same live Supabase
-- project without ever being reconciled. Renumbered here (025+) to merge both
-- histories into one record without colliding filenames -- content unchanged.

-- Fix: migration 017 force-enabled RLS on music_box, podcast_box, and
-- tv_box (needed so the new author-scoped INSERT/UPDATE policies actually
-- apply) but never added a SELECT policy for them, unlike memes/puzzles/
-- kids_collections/stories/chapters, which all already had one. Confirmed
-- via a live pg_policies query after running 017: those three tables show
-- INSERT and UPDATE rows but no SELECT row. Same class of bug as migration
-- 011 (missing public-read policy), except this time introduced by 017
-- itself rather than pre-existing -- if these tables previously had RLS
-- disabled (openly readable), this is a real regression, not just a gap.

DROP POLICY IF EXISTS "Public read access" ON music_box;
CREATE POLICY "Public read access" ON music_box FOR SELECT USING (true);

DROP POLICY IF EXISTS "Public read access" ON podcast_box;
CREATE POLICY "Public read access" ON podcast_box FOR SELECT USING (true);

DROP POLICY IF EXISTS "Public read access" ON tv_box;
CREATE POLICY "Public read access" ON tv_box FOR SELECT USING (true);

GRANT SELECT ON music_box, podcast_box, tv_box TO anon, authenticated;

-- Verify
SELECT tablename, policyname, cmd FROM pg_policies
WHERE tablename IN ('music_box', 'podcast_box', 'tv_box')
ORDER BY tablename, cmd;
