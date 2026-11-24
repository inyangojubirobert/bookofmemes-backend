-- 088: a sound for each quiz question (memes, puzzles, kids), played when the question shows.
-- Background music from the free library, a voice reading the question (built-in or the
-- creator's custom voice), or the creator's own audio (recorded, uploaded or from the gallery).
-- get_random_activity returns whole rows (to_jsonb), so the app receives these columns as-is.
-- Safe to run more than once.

DO $$
BEGIN
  IF to_regclass('public.meme_user_quiz_activity') IS NULL OR to_regclass('public.kids_user_quiz_activity') IS NULL OR to_regclass('public.puzzle_user_quiz_activity') IS NULL THEN
    RAISE EXCEPTION 'Wrong Supabase project, or 040 is missing: run this in the Book of Memes project (URL starts with zgyphn). Nothing was changed.';
  END IF;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['meme_user_quiz_activity', 'puzzle_user_quiz_activity', 'kids_user_quiz_activity'] LOOP
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS audio_url text', t);
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS audio_kind text', t);   -- music | voice | audio
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', t, t || '_audio_kind_check');
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (audio_kind IS NULL OR audio_kind IN (''music'', ''voice'', ''audio''))', t, t || '_audio_kind_check');
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', t, t || '_audio_url_check');
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (audio_url IS NULL OR audio_url ~ ''^https://'')', t, t || '_audio_url_check');
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
