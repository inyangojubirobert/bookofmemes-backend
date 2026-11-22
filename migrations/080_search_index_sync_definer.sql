-- 080: posting from the app failed with
--   new row violates row-level security policy for table "search_index"
--
-- Every content table has an AFTER INSERT/UPDATE trigger that copies the row
-- into search_index (fn_sync_<table>_to_search). search_index has RLS on and
-- no policies (only the server may write it), but those trigger functions ran
-- with the caller's rights (SECURITY INVOKER). So any insert or update made
-- from the app with the user's own login (Add Content: a new meme title, or
-- marking an existing title as having user questions) was refused. Posts made
-- by the server (Story Studio, Books) worked, which hid the problem.
-- books_library's trigger (067) was already SECURITY DEFINER.
--
-- Fix: run the sync functions with the owner's rights, like 067 does. They
-- only copy the row that fired them, so they give no extra access.
-- Then repair titles whose user questions were saved while the title's
-- activity_type update was refused (their questions never showed).
-- Safe to run more than once.

DO $$
BEGIN
  IF to_regclass('public.profiles') IS NULL OR to_regclass('public.search_index') IS NULL THEN
    RAISE EXCEPTION 'Wrong Supabase project: this is not Book of Memes. Switch to the project whose URL starts with zgyphn and run 080 there. Nothing was changed.';
  END IF;
END $$;

DO $$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'fn_sync_memes_to_search', 'fn_sync_puzzles_to_search', 'fn_sync_kids_collections_to_search',
    'fn_sync_stories_to_search', 'fn_sync_music_box_to_search', 'fn_sync_podcast_box_to_search',
    'fn_sync_tv_box_to_search', 'fn_sync_collections_to_search', 'fn_sync_profiles_to_search',
    'fn_sync_books_library_to_search'
  ] LOOP
    IF to_regprocedure('public.' || fn || '()') IS NOT NULL THEN
      EXECUTE format('ALTER FUNCTION public.%I() SECURITY DEFINER SET search_path = public', fn);
      EXECUTE format('REVOKE ALL ON FUNCTION public.%I() FROM PUBLIC, anon, authenticated', fn);
    ELSE
      RAISE NOTICE 'skipped %: not found', fn;
    END IF;
  END LOOP;
END $$;

-- Titles that have user questions but were never switched to them.
UPDATE public.memes m SET activity_type = 'user_quiz'
 WHERE m.activity_type IS NULL
   AND EXISTS (SELECT 1 FROM public.meme_user_quiz_activity q WHERE q.collection_id = m.id);
UPDATE public.puzzles p SET activity_type = 'user_quiz'
 WHERE p.activity_type IS NULL
   AND EXISTS (SELECT 1 FROM public.puzzle_user_quiz_activity q WHERE q.collection_id = p.id);
UPDATE public.kids_collections k SET activity_type = 'user_quiz'
 WHERE k.activity_type IS NULL
   AND EXISTS (SELECT 1 FROM public.kids_user_quiz_activity q WHERE q.collection_id = k.id);

-- Check: every row should say true.
SELECT p.proname, p.prosecdef AS security_definer
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname LIKE 'fn_sync_%_to_search'
 ORDER BY 1;
