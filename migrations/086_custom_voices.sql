-- 086: custom voices as templates (config/soundStudio.js, utils/customVoices.js).
--
-- A user records (or uploads) 5-60 seconds of a voice, names it ("My voice", "Grandpa
-- Joe"), and confirms it is their own voice or they have the speaker's permission.
-- Fish Audio S2.1 Pro on Runware speaks any new line in that voice from the sample +
-- its transcript (tested 2026-11-23: $0.0015 a line, same as a built-in voice).
-- A custom voice is used everywhere a built-in one is, by the id "custom:<uuid>":
-- the narrator, a shot's voice, an episode's characters. A Cast character can keep a
-- voice (video_assets.voice_id), so it speaks with it in every video and episode.
-- Safe to run more than once.

DO $$
BEGIN
  IF to_regclass('public.profiles') IS NULL OR to_regclass('public.video_assets') IS NULL THEN
    RAISE EXCEPTION 'Wrong Supabase project, or 079 is missing: run this in the Book of Memes project (URL starts with zgyphn). Nothing was changed.';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.custom_voices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 200),
  gender text CHECK (gender IS NULL OR gender IN ('male', 'female', 'child')),
  sample_url text NOT NULL,
  transcript text NOT NULL CHECK (length(transcript) BETWEEN 5 AND 1000),
  seconds numeric,
  preview_url text,                                  -- the voice saying a standard line (made once, free to replay)
  consent boolean NOT NULL DEFAULT false CHECK (consent),  -- "this is my voice, or I have the speaker's permission"
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);
CREATE INDEX IF NOT EXISTS custom_voices_user_idx ON public.custom_voices (user_id, updated_at DESC);
ALTER TABLE public.custom_voices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.custom_voices FROM anon, authenticated;
GRANT ALL ON public.custom_voices TO service_role;

-- A character template keeps its voice: a built-in id ("adaeze") or "custom:<uuid>".
ALTER TABLE public.video_assets ADD COLUMN IF NOT EXISTS voice_id text;

NOTIFY pgrst, 'reload schema';
