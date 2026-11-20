-- 075: Bascardo AI Studio for all eight item types.
--
-- 1. AI credit top-ups. Anyone can buy extra AI credits with wallet balance
--    (Wallet → bought through Google Play). They never expire and are used
--    only after the month's plan credits run out. reserve/commit (073) now
--    count them: monthly room first, then top-up credits.
-- 2. Books: a book is a story project with kind = 'book' (pages are its
--    chapters), so it reuses story memory, editing and publish-as-book.
-- 3. Video: a video project holds the look card and target length; each shot
--    is its own row so clip jobs finishing at the same time never overwrite
--    each other. Rendering joins the clips (and any voice-over/music) into
--    one MP4.
-- Additive only.
BEGIN;

-- ── 1. Top-up credits ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ai_credit_balance (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  credits int NOT NULL DEFAULT 0 CHECK (credits >= 0),
  purchased_total int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.ai_credit_topups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  pack text NOT NULL,
  credits int NOT NULL CHECK (credits > 0),
  price_usd numeric(10,2) NOT NULL,
  request_id text UNIQUE,
  status text NOT NULL DEFAULT 'granted' CHECK (status IN ('granted', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ai_credit_balance ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_credit_topups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_credit_balance, public.ai_credit_topups FROM anon, authenticated;
GRANT ALL ON public.ai_credit_balance, public.ai_credit_topups TO service_role;

-- Monthly limit the reservation was made against, so commit knows how much
-- of it can come from the month and how much from top-up credits.
ALTER TABLE public.ai_credit_reservations ADD COLUMN IF NOT EXISTS monthly_limit int;

CREATE OR REPLACE FUNCTION public.grant_ai_topup(p_user_id uuid, p_pack text, p_credits int, p_price numeric, p_request_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO ai_credit_topups (user_id, pack, credits, price_usd, request_id) VALUES (p_user_id, p_pack, p_credits, p_price, p_request_id);
  INSERT INTO ai_credit_balance (user_id, credits, purchased_total) VALUES (p_user_id, p_credits, p_credits)
  ON CONFLICT (user_id) DO UPDATE SET credits = ai_credit_balance.credits + excluded.credits,
    purchased_total = ai_credit_balance.purchased_total + excluded.credits, updated_at = now();
  RETURN true;
EXCEPTION WHEN unique_violation THEN
  RETURN false; -- the same purchase twice
END;
$$;

CREATE OR REPLACE FUNCTION public.reserve_ai_credits(p_user_id uuid, p_limit int, p_credits int, p_request_id text DEFAULT NULL, p_ttl_minutes int DEFAULT 15)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_period date := (date_trunc('month', now() AT TIME ZONE 'UTC'))::date;
  v_used int; v_held int; v_bonus int; v_id uuid;
BEGIN
  IF p_credits IS NULL OR p_credits <= 0 THEN RETURN NULL; END IF;
  IF p_request_id IS NOT NULL THEN
    SELECT id INTO v_id FROM ai_credit_reservations WHERE request_id = p_request_id AND user_id = p_user_id AND status = 'reserved';
    IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  END IF;

  INSERT INTO ai_usage_monthly (user_id, feature, period_start, amount, unit)
  VALUES (p_user_id, 'ai_credits', v_period, 0, 'credits')
  ON CONFLICT (user_id, feature, period_start) DO NOTHING;
  SELECT amount INTO v_used FROM ai_usage_monthly
  WHERE user_id = p_user_id AND feature = 'ai_credits' AND period_start = v_period FOR UPDATE;
  SELECT COALESCE((SELECT credits FROM ai_credit_balance WHERE user_id = p_user_id), 0) INTO v_bonus;
  SELECT COALESCE(sum(credits), 0) INTO v_held FROM ai_credit_reservations
  WHERE user_id = p_user_id AND period_start = v_period AND status = 'reserved' AND expires_at > now();

  IF GREATEST(p_limit - COALESCE(v_used, 0), 0) + v_bonus - v_held < p_credits THEN RETURN NULL; END IF;

  INSERT INTO ai_credit_reservations (user_id, period_start, credits, request_id, expires_at, monthly_limit)
  VALUES (p_user_id, v_period, p_credits, p_request_id, now() + make_interval(mins => GREATEST(p_ttl_minutes, 1)), p_limit)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- Spend once: from this month's plan credits first, the rest from top-ups.
CREATE OR REPLACE FUNCTION public.commit_ai_credits(p_reservation_id uuid, p_credits int DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r ai_credit_reservations%ROWTYPE; v_amount int; v_used int; v_room int; v_from_month int; v_from_bonus int;
BEGIN
  UPDATE ai_credit_reservations SET status = 'committed', settled_at = now()
  WHERE id = p_reservation_id AND status = 'reserved' RETURNING * INTO r;
  IF NOT FOUND THEN RETURN false; END IF;
  v_amount := LEAST(r.credits, COALESCE(p_credits, r.credits));
  IF v_amount <= 0 THEN RETURN true; END IF;

  INSERT INTO ai_usage_monthly (user_id, feature, period_start, amount, unit)
  VALUES (r.user_id, 'ai_credits', r.period_start, 0, 'credits')
  ON CONFLICT (user_id, feature, period_start) DO NOTHING;
  SELECT amount INTO v_used FROM ai_usage_monthly
  WHERE user_id = r.user_id AND feature = 'ai_credits' AND period_start = r.period_start FOR UPDATE;

  IF r.monthly_limit IS NULL THEN
    v_from_month := v_amount;                       -- reservations made before 075
  ELSE
    v_room := GREATEST(r.monthly_limit - COALESCE(v_used, 0), 0);
    v_from_month := LEAST(v_amount, v_room);
  END IF;
  v_from_bonus := v_amount - v_from_month;

  IF v_from_month > 0 THEN
    UPDATE ai_usage_monthly SET amount = amount + v_from_month, updated_at = now()
    WHERE user_id = r.user_id AND feature = 'ai_credits' AND period_start = r.period_start;
  END IF;
  IF v_from_bonus > 0 THEN
    UPDATE ai_credit_balance SET credits = GREATEST(credits - v_from_bonus, 0), updated_at = now() WHERE user_id = r.user_id;
  END IF;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.ai_topup_balance(p_user_id uuid)
RETURNS int LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((SELECT credits FROM ai_credit_balance WHERE user_id = p_user_id), 0);
$$;

REVOKE ALL ON FUNCTION public.grant_ai_topup(uuid, text, int, numeric, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ai_topup_balance(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reserve_ai_credits(uuid, int, int, text, int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commit_ai_credits(uuid, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.grant_ai_topup(uuid, text, int, numeric, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.ai_topup_balance(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_ai_credits(uuid, int, int, text, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.commit_ai_credits(uuid, int) TO service_role;

-- ── 2. Books ────────────────────────────────────────────────────────────────
ALTER TABLE public.story_projects
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'story',
  ADD COLUMN IF NOT EXISTS book_format text,          -- picture_book | early_reader | chapter_book | poetry | guide
  ADD COLUMN IF NOT EXISTS reading_level text,        -- 3-5 | 6-8 | 9-12 | teen | adult
  ADD COLUMN IF NOT EXISTS visual_identity jsonb,     -- characters' look, art style, palette: same on every page
  ADD COLUMN IF NOT EXISTS cover_url text;
DO $$ BEGIN
  ALTER TABLE public.story_projects ADD CONSTRAINT story_projects_kind_check CHECK (kind IN ('story', 'book'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE public.story_project_chapters ADD COLUMN IF NOT EXISTS illustration_prompt text;

-- ── 3. Video ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.video_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  title text,
  idea text NOT NULL CHECK (length(idea) BETWEEN 1 AND 8000),
  source_kind text,                                   -- idea | story | reference
  source_id uuid,                                     -- story project it was adapted from
  target_seconds int NOT NULL CHECK (target_seconds BETWEEN 5 AND 120),
  clip_seconds int NOT NULL,
  model text NOT NULL,
  aspect text NOT NULL DEFAULT 'landscape' CHECK (aspect IN ('landscape', 'portrait', 'square')),
  logline text,
  look_card jsonb,                                    -- characters, setting, style, palette, camera: sent with every shot
  fit_note text,                                      -- what had to be cut to fit the length
  reference jsonb,                                    -- { video_url, frames[], description } (analysed, not passed to the model)
  voiceover_url text,
  voiceover_seconds int,
  music_url text,
  render_url text,
  render_seconds numeric,
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'shooting', 'rendered')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS video_projects_user_idx ON public.video_projects (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.video_shots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.video_projects(id) ON DELETE CASCADE,
  number int NOT NULL CHECK (number >= 1),
  scene text, visual text NOT NULL, action text, camera text, lighting text,
  narration text, sound text,
  duration_seconds int NOT NULL,
  start_image_url text,                                -- keeps a character the same across shots
  source text NOT NULL DEFAULT 'ai' CHECK (source IN ('ai', 'upload', 'still')),
  clip_url text,
  clip_public_id text,                                 -- on our Cloudinary, ready to join
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'generating', 'ready', 'failed')),
  job_id uuid REFERENCES public.studio_jobs(id) ON DELETE SET NULL,
  included boolean NOT NULL DEFAULT true,
  trim_start numeric NOT NULL DEFAULT 0,
  trim_end numeric,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, number)
);

-- One row per charged AI step on a video project (same contract as story_ai_requests).
CREATE TABLE IF NOT EXISTS public.video_ai_requests (
  request_id text PRIMARY KEY CHECK (length(request_id) BETWEEN 8 AND 80),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  project_id uuid REFERENCES public.video_projects(id) ON DELETE CASCADE,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  credits int NOT NULL DEFAULT 0,
  response jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS video_ai_requests_user_idx ON public.video_ai_requests (user_id, created_at DESC);

ALTER TABLE public.video_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.video_shots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.video_ai_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.video_projects, public.video_shots, public.video_ai_requests FROM anon, authenticated;
GRANT ALL ON public.video_projects, public.video_shots, public.video_ai_requests TO service_role;

-- ── 4. Content Studio settings ──────────────────────────────────────────────
-- e.g. { minutes: 5 } for a podcast, { age_band: '6-8' } for kids,
-- { source_image_url } when the post starts from the user's photo.
ALTER TABLE public.content_projects ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMIT;
