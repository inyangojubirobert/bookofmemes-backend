-- 071: Bascardo Content Studio, the Story Studio's method (064) for the other
-- item types: memes, puzzles, kids_collections, music_box, podcast_box, tv_box.
--
-- A content project is the author's private workspace for one post: their
-- idea (kept as written), the three concepts Bascardo offered, the one they
-- picked, and the finished draft. Posting still goes through Add Content (so
-- the $1 new-title charge, quiz rows and ownership checks stay in one place);
-- the app then reports which item the draft became, so we can see how many
-- AI drafts turn into real posts.
--
-- Only the backend (service role) reads or writes these tables; the app goes
-- through /api/content-studio, which checks ownership.
BEGIN;

CREATE TABLE IF NOT EXISTS public.content_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  item_type text NOT NULL CHECK (item_type IN ('memes', 'puzzles', 'kids_collections', 'music_box', 'podcast_box', 'tv_box')),
  idea text NOT NULL CHECK (length(idea) BETWEEN 1 AND 4000),   -- the author's own words, never overwritten
  notes text,                                                    -- tone, audience, style
  stage text NOT NULL DEFAULT 'choose' CHECK (stage IN ('choose', 'draft', 'posted')),
  concepts jsonb,                                                -- [{ title, pitch, why }] currently offered
  concepts_seen jsonb NOT NULL DEFAULT '[]'::jsonb,              -- titles already offered, so fresh ones differ
  chosen_concept jsonb,                                          -- the one picked (+ author_tweak)
  draft jsonb,                                                   -- the finished post as Bascardo wrote it, then as the author edited it
  drafts_made int NOT NULL DEFAULT 0,                            -- how many times a draft was (re)written
  media jsonb NOT NULL DEFAULT '{}'::jsonb,                      -- { image_url, video_url } made for this post
  published_item_id uuid,                                        -- the post it became (table = item_type)
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS content_projects_user_idx ON public.content_projects (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS content_projects_type_idx ON public.content_projects (item_type, created_at DESC);
ALTER TABLE public.content_projects ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.content_projects FROM anon, authenticated;
GRANT ALL ON public.content_projects TO service_role;

-- One row per AI request (same as story_ai_requests): retries and double taps
-- never charge twice, and every step's credits and outcome are on record.
CREATE TABLE IF NOT EXISTS public.content_ai_requests (
  request_id text PRIMARY KEY CHECK (length(request_id) BETWEEN 8 AND 80),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  project_id uuid REFERENCES public.content_projects(id) ON DELETE CASCADE,
  item_type text NOT NULL,
  kind text NOT NULL,                                            -- concepts | ideas | draft
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  credits int NOT NULL DEFAULT 0,
  input_tokens int,
  output_tokens int,
  response jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS content_ai_requests_user_idx ON public.content_ai_requests (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS content_ai_requests_type_idx ON public.content_ai_requests (item_type, kind, created_at DESC);
ALTER TABLE public.content_ai_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.content_ai_requests FROM anon, authenticated;
GRANT ALL ON public.content_ai_requests TO service_role;

COMMIT;
