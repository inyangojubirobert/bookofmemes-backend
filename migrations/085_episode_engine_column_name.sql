-- 085: the episode column is called "engine", not "mode".
-- An early copy of 084 named it "mode", which is also a Postgres aggregate
-- function, so selecting it through the API fails ("WITHIN GROUP is required
-- for ordered-set aggregate mode"). This renames it if that copy was run, and
-- does nothing harmful if the corrected 084 was run. Safe to run more than once.

DO $$
BEGIN
  IF to_regclass('public.video_projects') IS NULL THEN
    RAISE EXCEPTION 'Wrong Supabase project: run this in the Book of Memes project (URL starts with zgyphn). Nothing was changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'video_projects' AND column_name = 'mode')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'video_projects' AND column_name = 'engine') THEN
    ALTER TABLE public.video_projects RENAME COLUMN mode TO engine;
  END IF;
END $$;

ALTER TABLE public.video_projects ADD COLUMN IF NOT EXISTS engine text NOT NULL DEFAULT 'creator';
ALTER TABLE public.video_projects DROP CONSTRAINT IF EXISTS video_projects_mode_check;
ALTER TABLE public.video_projects DROP CONSTRAINT IF EXISTS video_projects_engine_check;
ALTER TABLE public.video_projects ADD CONSTRAINT video_projects_engine_check CHECK (engine IN ('creator', 'auto'));
DROP INDEX IF EXISTS public.video_projects_auto_running_idx;
CREATE INDEX IF NOT EXISTS video_projects_auto_running_idx ON public.video_projects ((pipeline->>'status')) WHERE engine = 'auto';

NOTIFY pgrst, 'reload schema';
