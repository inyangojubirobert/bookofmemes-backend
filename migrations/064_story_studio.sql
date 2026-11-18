-- 064: Bascardo Story Studio (AI story development) + the 30-day chapter edit window.
--
-- A story project is the author's private workspace: their original idea or
-- script (kept as written), the AI's plan for it, the direction they chose,
-- and a structured memory of the story so far (chapter summaries, characters,
-- open threads) so each new chapter follows on from the last without sending
-- every chapter back to the AI. Drafts live here; publishing copies a chapter
-- into the normal stories/chapters tables.
--
-- Only the backend (service role) reads or writes these tables; the app goes
-- through /api/story, which checks ownership.
--
-- Published chapters can be edited for 30 days from publication, enforced
-- here (not just hidden in the app). The clock is chapters.published_at, set
-- by the database on insert and never changeable. Admins can still correct a
-- chapter by setting app.admin_chapter_edit = 'on' in their transaction.
BEGIN;

-- ── Projects ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.story_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  title text,
  source_text text NOT NULL CHECK (length(source_text) BETWEEN 1 AND 60000), -- the author's own idea/script, never overwritten
  genre text,
  notes text,                                     -- extra wishes: tone, audience, ending, style
  target_chapters int CHECK (target_chapters BETWEEN 1 AND 60),
  stage text NOT NULL DEFAULT 'idea' CHECK (stage IN ('idea', 'choose', 'writing')),
  plan jsonb,                                     -- AI plan: title, logline, synopsis, characters, setting, themes
  directions jsonb,                               -- the plot directions offered to the author
  chosen_direction jsonb,                         -- the one they picked (+ their tweak)
  roadmap jsonb,                                  -- [{ number, title, purpose }]
  memory jsonb NOT NULL DEFAULT '{}'::jsonb,      -- { summaries:[{number,title,summary}], characters:[], threads:[] }
  next_options jsonb,                             -- ideas for the next chapter, waiting for the author
  story_id uuid REFERENCES public.stories(id) ON DELETE SET NULL, -- the published story, once chapter 1 is out
  continued_from_story boolean NOT NULL DEFAULT false,            -- imported an existing story to continue it
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS story_projects_user_idx ON public.story_projects (user_id, updated_at DESC);
ALTER TABLE public.story_projects ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.story_projects FROM anon, authenticated;
GRANT ALL ON public.story_projects TO service_role;

-- ── Draft and published chapters of a project ───────────────────────────────
CREATE TABLE IF NOT EXISTS public.story_project_chapters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.story_projects(id) ON DELETE CASCADE,
  number int NOT NULL CHECK (number >= 1),
  title text NOT NULL,
  content text NOT NULL,
  summary text,
  direction_used text,                            -- the "what happens next" the author picked
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  chapter_id uuid REFERENCES public.chapters(id) ON DELETE SET NULL, -- the public chapter row once published
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, number)
);
ALTER TABLE public.story_project_chapters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.story_project_chapters FROM anon, authenticated;
GRANT ALL ON public.story_project_chapters TO service_role;

-- ── One row per AI request: no double charges on retries or double taps ─────
CREATE TABLE IF NOT EXISTS public.story_ai_requests (
  request_id text PRIMARY KEY CHECK (length(request_id) BETWEEN 8 AND 80),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  project_id uuid REFERENCES public.story_projects(id) ON DELETE CASCADE,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  credits int NOT NULL DEFAULT 0,
  response jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS story_ai_requests_user_idx ON public.story_ai_requests (user_id, created_at DESC);
ALTER TABLE public.story_ai_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.story_ai_requests FROM anon, authenticated;
GRANT ALL ON public.story_ai_requests TO service_role;

-- ── 30-day edit window on published chapters ────────────────────────────────
ALTER TABLE public.chapters ADD COLUMN IF NOT EXISTS published_at timestamptz;
UPDATE public.chapters SET published_at = COALESCE(created_at, now()) WHERE published_at IS NULL;
ALTER TABLE public.chapters ALTER COLUMN published_at SET DEFAULT now();
ALTER TABLE public.chapters ALTER COLUMN published_at SET NOT NULL;

CREATE OR REPLACE FUNCTION public.chapters_edit_window()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.published_at := now();            -- the server's clock, whatever the client sent
    RETURN NEW;
  END IF;
  NEW.published_at := OLD.published_at;   -- republishing or editing never resets the clock
  IF (NEW.chapter_title IS DISTINCT FROM OLD.chapter_title OR NEW.chapter_content IS DISTINCT FROM OLD.chapter_content)
     AND OLD.published_at < now() - interval '30 days'
     AND COALESCE(current_setting('app.admin_chapter_edit', true), '') <> 'on' THEN
    RAISE EXCEPTION 'This chapter was published more than 30 days ago, so it can no longer be edited.';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS chapters_edit_window ON public.chapters;
CREATE TRIGGER chapters_edit_window BEFORE INSERT OR UPDATE ON public.chapters
  FOR EACH ROW EXECUTE FUNCTION public.chapters_edit_window();

COMMIT;
