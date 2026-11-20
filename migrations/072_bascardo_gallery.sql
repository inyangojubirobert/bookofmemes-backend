-- 072: Bascardo Gallery. Every picture, video and audio a user makes with
-- Bascardo AI (or uploads into the studio) is kept here, so it can be reused:
-- as a reference picture, a video's start frame, a post's image or cover.
-- Media from the user's published posts is listed alongside it by the API
-- (read from the item tables, not copied here).
--
-- Only the backend (service role) reads or writes this table; the app goes
-- through /api/gallery, which checks ownership.
BEGIN;

CREATE TABLE IF NOT EXISTS public.gallery_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('image', 'video', 'audio')),
  url text NOT NULL CHECK (url ~ '^https://'),
  source text NOT NULL CHECK (source IN ('ai', 'upload')),
  feature text,                        -- image | video | narration | podcast_narration | upload
  prompt text,                         -- what was asked for (AI items)
  model text,
  duration_seconds int,                -- video / audio length
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, url)                -- saving the same file twice is a no-op
);
CREATE INDEX IF NOT EXISTS gallery_assets_user_idx ON public.gallery_assets (user_id, kind, created_at DESC);
ALTER TABLE public.gallery_assets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gallery_assets FROM anon, authenticated;
GRANT ALL ON public.gallery_assets TO service_role;

-- Bring in what users already made before the gallery existed.
INSERT INTO public.gallery_assets (user_id, kind, url, source, feature, prompt, model, duration_seconds, created_at)
SELECT h.user_id,
       CASE h.feature WHEN 'image' THEN 'image' WHEN 'video' THEN 'video' ELSE 'audio' END,
       h.output_url, 'ai', CASE h.feature WHEN 'voice' THEN 'narration' ELSE h.feature END,
       left(h.input_prompt, 1000), h.model, NULLIF(h.duration_seconds, 0), h.created_at
FROM public.ai_generation_history h
JOIN public.profiles p ON p.id = h.user_id
WHERE h.success AND h.output_url ~ '^https://' AND h.feature IN ('image', 'video', 'voice')
ON CONFLICT (user_id, url) DO NOTHING;

COMMIT;
