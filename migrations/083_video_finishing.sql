-- 083: Video Studio finishing — edit each clip after it's made, and build the
-- soundtrack from parts the creator chooses (config/soundStudio.js).
--
--   shots    trim (columns from 075) + edit { zoom, anchor, look, strength, grade, clip_audio }
--            lighting preset before generation (light)
--            a voice line per shot (voice_id, voice_tone, the recorded line)
--            sound effects placed at a second of the shot (sfx)
--            edit_cache: the edited clip Cloudinary built, reused while the edit is unchanged
--   project  finish { look, strength, grade, vignette, music_level }, voice defaults,
--            lighting for every shot (light), music versions (music_history)
-- Safe to run more than once.

DO $$
BEGIN
  IF to_regclass('public.profiles') IS NULL OR to_regclass('public.video_shots') IS NULL THEN
    RAISE EXCEPTION 'Wrong Supabase project: this is not Book of Memes. Switch to the project whose URL starts with zgyphn (Project Settings → API) and run 083 there. Nothing was changed.';
  END IF;
END $$;

ALTER TABLE public.video_projects
  ADD COLUMN IF NOT EXISTS finish jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS voice jsonb NOT NULL DEFAULT '{}'::jsonb,         -- { voice_id, tone, speed }
  ADD COLUMN IF NOT EXISTS light jsonb,                                       -- { preset, colour } for every shot
  ADD COLUMN IF NOT EXISTS music_title text,
  ADD COLUMN IF NOT EXISTS music_history jsonb NOT NULL DEFAULT '[]'::jsonb;  -- [{ url, title, at }]

ALTER TABLE public.video_shots
  ADD COLUMN IF NOT EXISTS edit jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS light jsonb,
  ADD COLUMN IF NOT EXISTS voice_id text,
  ADD COLUMN IF NOT EXISTS voice_tone text,
  ADD COLUMN IF NOT EXISTS voice_url text,
  ADD COLUMN IF NOT EXISTS voice_public_id text,
  ADD COLUMN IF NOT EXISTS voice_seconds numeric,
  ADD COLUMN IF NOT EXISTS voice_lead_in numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS voice_key text,                                   -- what the line was made from; differs = re-record
  ADD COLUMN IF NOT EXISTS sfx jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS edit_cache jsonb;

-- 'sound' = the clip with sound made to match it (Mirelo).
ALTER TABLE public.video_shots DROP CONSTRAINT IF EXISTS video_shots_source_check;
ALTER TABLE public.video_shots ADD CONSTRAINT video_shots_source_check CHECK (source IN ('ai', 'upload', 'still', 'sound'));

NOTIFY pgrst, 'reload schema';
