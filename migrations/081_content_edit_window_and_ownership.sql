-- 081: who may change content, and for how long.
--
-- 1. A title belongs to its author alone. Questions (memes / puzzles / kids),
--    chapters and book pages can only be added to YOUR OWN title: ads shown
--    between them are credited to the title's owner (068). Before this, the
--    question tables only checked the row's author_id, so anyone could add a
--    question to anyone's title.
-- 2. Edit window: content can be edited for 30 days after it was posted
--    (each title, question, chapter, page or episode counts from its own
--    created_at). An edit replaces the original; nothing old is kept.
--    Counters, timestamps and system fields (activity_type, links between
--    chapters, page_count ...) are not edits and always update.
-- 3. Delete: the author can delete their content at any time (Google Play's
--    user-generated-content and user-data rules: people must be able to remove
--    what they posted) through delete_my_content(). Deleting a title deletes
--    everything in it.
-- 4. The marketplace rule stands: a title that is listed (active / awaiting a
--    decision) or has been sold can't be edited or deleted, and nothing can be
--    added to it or removed from it (055's guard_market_content, extended here
--    to questions and pages' siblings).
-- 5. Deleted content leaves the search index too.
-- The server (service role) is not limited by the 30-day window.
-- Safe to run more than once.

DO $$
BEGIN
  IF to_regclass('public.profiles') IS NULL OR to_regclass('public.meme_user_quiz_activity') IS NULL
     OR to_regprocedure('public.market_item_locked(text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Wrong Supabase project (or 055 not run): switch to the project whose URL starts with zgyphn and run 081 there. Nothing was changed.';
  END IF;
END $$;

-- ── 1. Questions only in your own title; you may edit your own questions ────
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('meme_user_quiz_activity', 'memes'),
    ('puzzle_user_quiz_activity', 'puzzles'),
    ('kids_user_quiz_activity', 'kids_collections')) v(q, t)
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS "Authors can insert their own questions" ON public.%I', r.q);
    EXECUTE format('CREATE POLICY "Authors can insert their own questions" ON public.%1$I FOR INSERT
      WITH CHECK (auth.uid() = author_id AND EXISTS (SELECT 1 FROM public.%2$I c WHERE c.id = %1$I.collection_id AND c.author_id = auth.uid()))', r.q, r.t);
    EXECUTE format('DROP POLICY IF EXISTS "Title owners can edit their questions" ON public.%I', r.q);
    EXECUTE format('CREATE POLICY "Title owners can edit their questions" ON public.%1$I FOR UPDATE
      USING (EXISTS (SELECT 1 FROM public.%2$I c WHERE c.id = %1$I.collection_id AND c.author_id = auth.uid()))
      WITH CHECK (EXISTS (SELECT 1 FROM public.%2$I c WHERE c.id = %1$I.collection_id AND c.author_id = auth.uid()))', r.q, r.t);
    EXECUTE format('GRANT UPDATE ON public.%I TO authenticated', r.q);
  END LOOP;
END $$;

-- Chapters only in your own story.
DROP POLICY IF EXISTS "Authors can insert their own content" ON public.chapters;
CREATE POLICY "Authors can insert their own content" ON public.chapters FOR INSERT
  WITH CHECK (auth.uid() = author_id AND EXISTS (SELECT 1 FROM public.stories s WHERE s.id = chapters.story_id AND s.author_id = auth.uid()));

-- ── 4. Marketplace lock for the parts of a title ────────────────────────────
-- TG_ARGV[0] = the title's item type, TG_ARGV[1] = the column holding its id.
CREATE OR REPLACE FUNCTION public.guard_market_part()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_title uuid := ((to_jsonb(COALESCE(NEW, OLD))) ->> TG_ARGV[1])::uuid;
BEGIN
  IF COALESCE(current_setting('app.content_admin_override', true), '') = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF market_item_locked(TG_ARGV[0], v_title) IS NOT NULL THEN
    RAISE EXCEPTION 'This title is on the marketplace or owned by a buyer, so nothing in it can be added, changed or deleted.';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('meme_user_quiz_activity', 'memes'),
    ('puzzle_user_quiz_activity', 'puzzles'),
    ('kids_user_quiz_activity', 'kids_collections')) v(q, t)
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_guard_market_part ON public.%I', r.q);
    EXECUTE format('CREATE TRIGGER trg_guard_market_part BEFORE INSERT OR UPDATE OR DELETE ON public.%I
                    FOR EACH ROW EXECUTE FUNCTION public.guard_market_part(%L, %L)', r.q, r.t, 'collection_id');
  END LOOP;
END $$;

-- ── 2. The 30-day edit window ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.enforce_edit_window()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_old jsonb := to_jsonb(OLD);
  v_new jsonb := to_jsonb(NEW);
  v_key text;
BEGIN
  -- The server, admins' overrides, and rows without a date are not limited.
  IF auth.uid() IS NULL OR COALESCE(current_setting('app.content_admin_override', true), '') = 'on'
     OR (v_old ->> 'created_at') IS NULL OR (v_old ->> 'created_at')::timestamptz >= now() - interval '30 days' THEN
    RETURN NEW;
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(v_new) LOOP
    CONTINUE WHEN v_key LIKE '%count%' OR v_key LIKE '%\_at' OR v_key IN (
      'views', 'likes', 'plays', 'rating', 'score', 'bids', 'liquidity_stakes',
      'activity_type', 'universal_item_type', 'prev_chapter_id', 'next_chapter_id', 'metadata');
    IF v_new -> v_key IS DISTINCT FROM v_old -> v_key THEN
      RAISE EXCEPTION 'Posts can only be edited in the first 30 days. This one was posted on % — you can still delete it.',
        to_char((v_old ->> 'created_at')::timestamptz, 'DD Mon YYYY');
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['memes','puzzles','kids_collections','stories','music_box','podcast_box','tv_box','books_library',
                           'chapters','chapter_content','book_pages',
                           'meme_user_quiz_activity','puzzle_user_quiz_activity','kids_user_quiz_activity'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS trg_edit_window ON public.%I', t);
      EXECUTE format('CREATE TRIGGER trg_edit_window BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.enforce_edit_window()', t);
    END IF;
  END LOOP;
END $$;

-- ── 5. Deleted titles leave the search index ────────────────────────────────
CREATE OR REPLACE FUNCTION public.remove_from_search_index()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM search_index WHERE item_id = OLD.id;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION public.remove_from_search_index() FROM PUBLIC, anon, authenticated;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['memes','puzzles','kids_collections','stories','music_box','podcast_box','tv_box','books_library'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_search_remove ON public.%I', t);
    EXECUTE format('CREATE TRIGGER trg_search_remove AFTER DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.remove_from_search_index()', t);
  END LOOP;
END $$;

-- ── 3. Delete your own content (any time, unless listed or sold) ────────────
-- p_table: a title table, or a part: one of the question tables, chapters,
-- book_pages. Returns { deleted: true, table, id }.
CREATE OR REPLACE FUNCTION public.delete_my_content(p_table text, p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_title_type text;
  v_title_id uuid;
  v_owner uuid;
  v_lock text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Please sign in first.'; END IF;

  IF p_table IN ('memes','puzzles','kids_collections','stories','music_box','podcast_box','tv_box','books_library') THEN
    v_title_type := p_table; v_title_id := p_id;
  ELSIF p_table = 'meme_user_quiz_activity' THEN
    v_title_type := 'memes'; SELECT collection_id INTO v_title_id FROM meme_user_quiz_activity WHERE id = p_id;
  ELSIF p_table = 'puzzle_user_quiz_activity' THEN
    v_title_type := 'puzzles'; SELECT collection_id INTO v_title_id FROM puzzle_user_quiz_activity WHERE id = p_id;
  ELSIF p_table = 'kids_user_quiz_activity' THEN
    v_title_type := 'kids_collections'; SELECT collection_id INTO v_title_id FROM kids_user_quiz_activity WHERE id = p_id;
  ELSIF p_table = 'chapters' THEN
    v_title_type := 'stories'; SELECT story_id INTO v_title_id FROM chapters WHERE id = p_id;
  ELSIF p_table = 'book_pages' THEN
    v_title_type := 'books_library'; SELECT book_id INTO v_title_id FROM book_pages WHERE id = p_id;
  ELSE
    RAISE EXCEPTION 'That can''t be deleted here.';
  END IF;
  IF v_title_id IS NULL THEN RAISE EXCEPTION 'Not found (it may already be deleted).'; END IF;

  EXECUTE format('SELECT author_id FROM %I WHERE id = $1', v_title_type) INTO v_owner USING v_title_id;
  IF v_owner IS DISTINCT FROM v_uid THEN RAISE EXCEPTION 'Only the author can delete this.'; END IF;

  v_lock := market_item_locked(v_title_type, v_title_id);
  IF v_lock IS NOT NULL THEN
    RAISE EXCEPTION 'This title is % on the marketplace, so it can''t be deleted: other people have paid or bid for it.',
      CASE v_lock WHEN 'listed' THEN 'listed' ELSE 'owned by a buyer' END;
  END IF;

  IF p_table = 'chapters' THEN
    UPDATE chapters SET prev_chapter_id = NULL WHERE prev_chapter_id = p_id;
    UPDATE chapters SET next_chapter_id = NULL WHERE next_chapter_id = p_id;
    IF to_regclass('public.chapter_content') IS NOT NULL THEN DELETE FROM chapter_content WHERE chapter_id = p_id; END IF;
  ELSIF p_table = 'stories' THEN
    IF to_regclass('public.chapter_content') IS NOT NULL THEN DELETE FROM chapter_content WHERE story_id = p_id; END IF;
    UPDATE chapters SET prev_chapter_id = NULL, next_chapter_id = NULL WHERE story_id = p_id;
  END IF;

  EXECUTE format('DELETE FROM %I WHERE id = $1', p_table) USING p_id;
  RETURN jsonb_build_object('deleted', true, 'table', p_table, 'id', p_id);
END;
$$;
REVOKE ALL ON FUNCTION public.delete_my_content(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_my_content(text, uuid) TO authenticated;

-- Check
SELECT 'delete_my_content' AS what, to_regprocedure('public.delete_my_content(text,uuid)') IS NOT NULL AS ok
UNION ALL SELECT 'edit window triggers', count(*) = 14 FROM pg_trigger WHERE tgname = 'trg_edit_window'
UNION ALL SELECT 'question guards', count(*) = 3 FROM pg_trigger WHERE tgname = 'trg_guard_market_part';
