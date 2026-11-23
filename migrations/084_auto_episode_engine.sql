-- 084: Auto Episode Engine (Mode 2) — a script + a few choices → a finished episode,
-- built in the background (config/episodeEngine.js, utils/episodePipeline.js).
--
--   video_series      a series: its Story Bible choices (genre, look, narrator, voices per
--                     character, pronunciations) and the continuity LEDGER (who wears what,
--                     who holds which prop, story time, open threads), updated after every episode
--   video_projects    + series_id, episode_number, engine ('creator' = Mode 1, 'auto' = Mode 2),
--                     script, settings, pipeline (stage, progress, log, credits used)
--   video_shots       + lines (dialogue/narration per shot, each with its voice and recording),
--                     motion ('clip' | 'still'), scene_no, kind, qc (still check), compiled
--                     (the exact prompt + references + asset versions it was built from)
-- Mode 1 (Creator Studio) is unchanged: its rows keep engine 'creator' and the new columns' defaults.
-- Safe to run more than once.

DO $$
BEGIN
  IF to_regclass('public.profiles') IS NULL OR to_regclass('public.video_shots') IS NULL OR to_regclass('public.video_assets') IS NULL THEN
    RAISE EXCEPTION 'Wrong Supabase project, or 079 is missing: run this in the Book of Memes project (URL starts with zgyphn). Nothing was changed.';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.video_series (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  genre text NOT NULL DEFAULT 'drama',
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,   -- look, strength, aspect, narrator voice, music theme, drama/visual mode, captions
  bible jsonb NOT NULL DEFAULT '{}'::jsonb,      -- { voices: { asset_id: voice_id }, pronunciations: [{ name, say }], cast: [asset_id] }
  ledger jsonb NOT NULL DEFAULT '{}'::jsonb,     -- { characters, props, locations, story_time, open_threads, episodes: [{ number, title, summary }] }
  episode_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS video_series_user_idx ON public.video_series (user_id, updated_at DESC);
ALTER TABLE public.video_series ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.video_series FROM anon, authenticated;
GRANT ALL ON public.video_series TO service_role;

ALTER TABLE public.video_projects
  ADD COLUMN IF NOT EXISTS series_id uuid REFERENCES public.video_series(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS episode_number int,
  ADD COLUMN IF NOT EXISTS engine text NOT NULL DEFAULT 'creator',  -- not "mode": that is a Postgres aggregate name
  ADD COLUMN IF NOT EXISTS script text,
  ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS pipeline jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.video_projects DROP CONSTRAINT IF EXISTS video_projects_engine_check;
ALTER TABLE public.video_projects ADD CONSTRAINT video_projects_engine_check CHECK (engine IN ('creator', 'auto'));
ALTER TABLE public.video_projects DROP CONSTRAINT IF EXISTS video_projects_script_check;
ALTER TABLE public.video_projects ADD CONSTRAINT video_projects_script_check CHECK (script IS NULL OR length(script) <= 40000);
-- Episodes run to 5 minutes (075 allowed 120 s).
ALTER TABLE public.video_projects DROP CONSTRAINT IF EXISTS video_projects_target_seconds_check;
ALTER TABLE public.video_projects ADD CONSTRAINT video_projects_target_seconds_check CHECK (target_seconds BETWEEN 5 AND 600);
CREATE INDEX IF NOT EXISTS video_projects_series_idx ON public.video_projects (series_id, episode_number);
-- The background runner looks for unfinished auto episodes.
CREATE INDEX IF NOT EXISTS video_projects_auto_running_idx ON public.video_projects ((pipeline->>'status')) WHERE engine = 'auto';

ALTER TABLE public.video_shots
  ADD COLUMN IF NOT EXISTS lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS motion text,
  ADD COLUMN IF NOT EXISTS scene_no int,
  ADD COLUMN IF NOT EXISTS kind text,
  ADD COLUMN IF NOT EXISTS qc jsonb,
  ADD COLUMN IF NOT EXISTS compiled jsonb;
ALTER TABLE public.video_shots DROP CONSTRAINT IF EXISTS video_shots_motion_check;
ALTER TABLE public.video_shots ADD CONSTRAINT video_shots_motion_check CHECK (motion IS NULL OR motion IN ('clip', 'still'));

NOTIFY pgrst, 'reload schema';
