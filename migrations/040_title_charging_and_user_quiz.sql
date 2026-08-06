-- Recovered from the bookofmemes-backend GitHub repo's independent migration
-- history (originally '017_title_charging_and_user_quiz.sql') -- that repo accumulated its own migrations
-- (numbered 002-020 + add_currencies_table) in parallel with this local
-- checkout's own 001-024, both apparently run against the same live Supabase
-- project without ever being reconciled. Renumbered here (025+) to merge both
-- histories into one record without colliding filenames -- content unchanged.

-- Powers the paid-title / free-add-to-existing upload flow in AddContent.js:
--   1. spend_tokens() — atomic charge against wallets.token_balance, used
--      once per NEW title (100 tokens = $1, the existing pack_100 rate from
--      Backend/routes/tokenRoutes.js). Adding more content to a title you
--      already created never calls this.
--   2. Three reusable "user quiz" activity tables (one per MediaViewer item
--      type) so any meme/puzzle/kids-collection title can carry its own
--      quiz questions, using the same get_random_activity()/
--      content_activity_types mechanism built in migration 009 — no new
--      per-title tables, ever; these three are created once and every
--      user's quiz questions are just rows in them, keyed by collection_id.

-- ── 1. Atomic token spend ────────────────────────────────────────────────
-- Every existing spend-style endpoint (tokenRoutes.js, transferRoutes.js,
-- walletApiRouter.js) does a read-then-UPDATE from Node, which race-conditions
-- under concurrent requests. A single UPDATE ... WHERE ... RETURNING is
-- atomic in Postgres, so this closes that gap for the one new spend flow
-- introduced here rather than repeating the existing pattern.
--
-- SECURITY DEFINER + a pinned search_path so this can update `wallets`
-- regardless of that table's RLS policy (financial mutations are otherwise
-- backend/service-role-only, same as every existing spend endpoint) --
-- but it deliberately does NOT take a user id parameter. It only ever
-- operates on auth.uid(), the caller's own authenticated identity, so a
-- client can never pass someone else's id and drain their wallet.
CREATE OR REPLACE FUNCTION spend_tokens(
  p_amount      integer,
  p_description text
)
RETURNS TABLE (success boolean, new_balance integer, message text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wallet_id   uuid;
  v_new_balance integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN QUERY SELECT false, NULL::integer, 'Not signed in';
    RETURN;
  END IF;

  UPDATE wallets
  SET token_balance = token_balance - p_amount
  WHERE user_id = auth.uid() AND token_balance >= p_amount
  RETURNING id, token_balance INTO v_wallet_id, v_new_balance;

  IF v_wallet_id IS NULL THEN
    RETURN QUERY SELECT false, NULL::integer, 'Insufficient token balance';
    RETURN;
  END IF;

  INSERT INTO wallet_transactions (wallet_id, type, amount, description, status)
  VALUES (v_wallet_id, 'token_spend', -p_amount, p_description, 'completed');

  RETURN QUERY SELECT true, v_new_balance, 'ok';
END;
$$;

GRANT EXECUTE ON FUNCTION spend_tokens(integer, text) TO authenticated;

-- ── 2. User-quiz activity tables (one per MediaViewer item type) ────────
CREATE TABLE IF NOT EXISTS meme_user_quiz_activity (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id     uuid        NOT NULL REFERENCES memes(id) ON DELETE CASCADE,
  question_text     text,
  image_url         text,
  correct_answer    text        NOT NULL,
  incorrect_answers jsonb       NOT NULL,
  author_id         uuid        REFERENCES profiles(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meme_user_quiz_question_present CHECK (question_text IS NOT NULL OR image_url IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS puzzle_user_quiz_activity (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id     uuid        NOT NULL REFERENCES puzzles(id) ON DELETE CASCADE,
  question_text     text,
  image_url         text,
  correct_answer    text        NOT NULL,
  incorrect_answers jsonb       NOT NULL,
  author_id         uuid        REFERENCES profiles(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT puzzle_user_quiz_question_present CHECK (question_text IS NOT NULL OR image_url IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS kids_user_quiz_activity (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id     uuid        NOT NULL REFERENCES kids_collections(id) ON DELETE CASCADE,
  question_text     text,
  image_url         text,
  correct_answer    text        NOT NULL,
  incorrect_answers jsonb       NOT NULL,
  author_id         uuid        REFERENCES profiles(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kids_user_quiz_question_present CHECK (question_text IS NOT NULL OR image_url IS NOT NULL)
);

ALTER TABLE meme_user_quiz_activity  ENABLE ROW LEVEL SECURITY;
ALTER TABLE puzzle_user_quiz_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE kids_user_quiz_activity  ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read access" ON meme_user_quiz_activity  FOR SELECT USING (true);
CREATE POLICY "Public read access" ON puzzle_user_quiz_activity FOR SELECT USING (true);
CREATE POLICY "Public read access" ON kids_user_quiz_activity  FOR SELECT USING (true);

-- Authors can add questions to their own titles directly from the client.
CREATE POLICY "Authors can insert their own questions" ON meme_user_quiz_activity
  FOR INSERT WITH CHECK (auth.uid() = author_id);
CREATE POLICY "Authors can insert their own questions" ON puzzle_user_quiz_activity
  FOR INSERT WITH CHECK (auth.uid() = author_id);
CREATE POLICY "Authors can insert their own questions" ON kids_user_quiz_activity
  FOR INSERT WITH CHECK (auth.uid() = author_id);

GRANT SELECT ON meme_user_quiz_activity, puzzle_user_quiz_activity, kids_user_quiz_activity TO anon, authenticated;
GRANT INSERT ON meme_user_quiz_activity, puzzle_user_quiz_activity, kids_user_quiz_activity TO authenticated;

-- ── 3. Register the new activity type ────────────────────────────────────
INSERT INTO content_activity_types (item_type, activity_type, table_name) VALUES
  ('memes',            'user_quiz', 'meme_user_quiz_activity'::regclass),
  ('puzzles',          'user_quiz', 'puzzle_user_quiz_activity'::regclass),
  ('kids_collections', 'user_quiz', 'kids_user_quiz_activity'::regclass)
ON CONFLICT (item_type, activity_type) DO NOTHING;

-- ── 4. Author-scoped write access on the content tables themselves ──────
-- AddContent.js is the first thing in this codebase that INSERTs into these
-- tables as an authenticated client (every prior row came from a migration
-- run with the service-role key, which bypasses RLS). Migration 011 already
-- proved these tables have RLS enabled with no policies beyond public SELECT
-- -- there's never been an INSERT/UPDATE policy for any of them. Without
-- this, every "New Title" and "Add to Existing" submission fails RLS with
-- no content posted. Idempotent (DROP IF EXISTS) so it's safe to re-run and
-- safe if a table already has an equivalent policy from elsewhere.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'memes', 'puzzles', 'kids_collections', 'stories',
    'music_box', 'podcast_box', 'tv_box', 'chapters'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);

    EXECUTE format('DROP POLICY IF EXISTS "Authors can insert their own content" ON %I', t);
    EXECUTE format(
      'CREATE POLICY "Authors can insert their own content" ON %I FOR INSERT WITH CHECK (auth.uid() = author_id)', t
    );

    -- Needed for the "Add to Existing" quiz flow, which retroactively sets
    -- activity_type on an older row when its first quiz question is added.
    EXECUTE format('DROP POLICY IF EXISTS "Authors can update their own content" ON %I', t);
    EXECUTE format(
      'CREATE POLICY "Authors can update their own content" ON %I FOR UPDATE USING (auth.uid() = author_id) WITH CHECK (auth.uid() = author_id)', t
    );

    EXECUTE format('GRANT INSERT, UPDATE ON %I TO authenticated', t);
  END LOOP;
END $$;

-- chapters has no public-read policy proven yet either (stories itself does,
-- per migration 011's comment, but chapters is a separate table) -- add it
-- defensively so newly-added chapters are actually visible to readers.
DROP POLICY IF EXISTS "Public read access" ON chapters;
CREATE POLICY "Public read access" ON chapters FOR SELECT USING (true);
GRANT SELECT ON chapters TO anon, authenticated;

-- Verify
SELECT proname FROM pg_proc WHERE proname = 'spend_tokens';
SELECT item_type, activity_type, table_name FROM content_activity_types WHERE activity_type = 'user_quiz';
SELECT tablename, policyname, cmd FROM pg_policies
WHERE tablename IN ('memes','puzzles','kids_collections','stories','music_box','podcast_box','tv_box','chapters')
ORDER BY tablename, cmd;
