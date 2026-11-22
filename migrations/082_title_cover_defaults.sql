-- 082: title covers.
--
-- Two different kinds of cover picture:
--   • item-type covers: the animated pictures on the Home / Explore category
--     boxes ("Kids Box", "Memes" ...). They live in the app
--     (src/config/homeCovers.js) and are NOT used for single titles any more.
--   • title covers: each title's own picture (kids_collections.cover_image_url,
--     memes.image_url, stories.cover_image_url ...). Every list, carousel and
--     "best match" card shows this.
--
-- When a title has no cover of its own, the app shows the substitute set here
-- for its item type; when there is no substitute either, an icon. Change a
-- substitute here and every app picks it up (no app update):
--   UPDATE public.title_cover_defaults SET cover_url = 'https://res.cloudinary.com/...' WHERE item_type = 'kids_collections';
-- Give a title its own cover (replaces the substitute for that title only):
--   UPDATE public.kids_collections SET cover_image_url = 'https://...' WHERE title = 'Phonics';
-- Puzzle titles had no cover column; they get one here.
-- Safe to run more than once.

DO $$
BEGIN
  IF to_regclass('public.profiles') IS NULL OR to_regclass('public.kids_collections') IS NULL THEN
    RAISE EXCEPTION 'Wrong Supabase project: switch to the project whose URL starts with zgyphn and run 082 there. Nothing was changed.';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.title_cover_defaults (
  item_type text PRIMARY KEY CHECK (item_type IN ('memes','puzzles','kids_collections','stories','music_box','podcast_box','tv_box','books_library')),
  cover_url text CHECK (cover_url IS NULL OR cover_url ~ '^https://'),
  note text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.title_cover_defaults ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Anyone can read title cover defaults" ON public.title_cover_defaults;
CREATE POLICY "Anyone can read title cover defaults" ON public.title_cover_defaults FOR SELECT USING (true);
GRANT SELECT ON public.title_cover_defaults TO anon, authenticated;
GRANT ALL ON public.title_cover_defaults TO service_role;

-- One row per item type; empty = the icon is shown.
INSERT INTO public.title_cover_defaults (item_type, note) VALUES
  ('memes', 'Shown for meme titles without image_url'),
  ('puzzles', 'Shown for puzzle titles without cover_image_url'),
  ('kids_collections', 'Shown for kids titles without cover_image_url'),
  ('stories', 'Shown for stories without cover_image_url'),
  ('music_box', 'Shown for music without cover_image_url'),
  ('podcast_box', 'Shown for podcasts without cover_image_url'),
  ('tv_box', 'Shown for TV without thumbnail_url'),
  ('books_library', 'Shown for books without cover_image_url')
ON CONFLICT (item_type) DO NOTHING;

-- Puzzle titles get their own cover.
ALTER TABLE public.puzzles ADD COLUMN IF NOT EXISTS cover_image_url text;

-- Check: kids titles with their own cover / without.
SELECT count(*) FILTER (WHERE cover_image_url IS NOT NULL) AS kids_titles_with_cover,
       count(*) FILTER (WHERE cover_image_url IS NULL) AS kids_titles_using_substitute
  FROM public.kids_collections;
