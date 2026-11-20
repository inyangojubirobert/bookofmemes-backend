-- 073: shared Bascardo Studio infrastructure (Phase A of docs/BASCARDO_STUDIO_AUDIT.md).
--
-- 1. Credit reservations. Until now an AI step checked the monthly pool, did
--    the work, then spent the credits, so two expensive requests sent at once
--    could both pass the check. Now a step reserves its credits atomically
--    before the provider is called, commits them when the result is saved,
--    and releases them on failure. Unreleased reservations expire on their own.
-- 2. studio_jobs: long media work (video clips, later songs, renders, long
--    narration) runs as a job the server finishes even if the phone
--    disconnects or the server restarts (the provider task id is stored, so
--    polling resumes). The app checks the job instead of holding a request open.
-- 3. gallery_assets learns which project made each asset and what it cost.
--
-- Additive only: no existing table or column changes meaning.
BEGIN;

-- ── 1. Credit reservations ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ai_credit_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  credits int NOT NULL CHECK (credits > 0),
  request_id text,
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'committed', 'released')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz
);
CREATE INDEX IF NOT EXISTS ai_credit_reservations_open_idx ON public.ai_credit_reservations (user_id, period_start) WHERE status = 'reserved';
-- One OPEN reservation per request id (a retry after a released one may reserve again).
CREATE UNIQUE INDEX IF NOT EXISTS ai_credit_reservations_request_idx ON public.ai_credit_reservations (request_id) WHERE request_id IS NOT NULL AND status = 'reserved';
ALTER TABLE public.ai_credit_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_credit_reservations FROM anon, authenticated;
GRANT ALL ON public.ai_credit_reservations TO service_role;

-- Reserve p_credits from this month's pool of p_limit credits. Returns the
-- reservation id, or NULL when the pool can't cover it. Serialised per user by
-- locking the user's monthly usage row, so concurrent requests can't both pass.
-- The same p_request_id returns the same open reservation (retries are free).
CREATE OR REPLACE FUNCTION public.reserve_ai_credits(p_user_id uuid, p_limit int, p_credits int, p_request_id text DEFAULT NULL, p_ttl_minutes int DEFAULT 15)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_period date := (date_trunc('month', now() AT TIME ZONE 'UTC'))::date;
  v_used int;
  v_held int;
  v_id uuid;
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
  WHERE user_id = p_user_id AND feature = 'ai_credits' AND period_start = v_period
  FOR UPDATE;

  SELECT COALESCE(sum(credits), 0) INTO v_held FROM ai_credit_reservations
  WHERE user_id = p_user_id AND period_start = v_period AND status = 'reserved' AND expires_at > now();

  IF COALESCE(v_used, 0) + v_held + p_credits > p_limit THEN RETURN NULL; END IF;

  INSERT INTO ai_credit_reservations (user_id, period_start, credits, request_id, expires_at)
  VALUES (p_user_id, v_period, p_credits, p_request_id, now() + make_interval(mins => GREATEST(p_ttl_minutes, 1)))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- Spend a reservation (once). p_credits may lower the amount (never raise it).
-- Credits go to the month the reservation was made in. Returns false if it
-- was already committed or released.
CREATE OR REPLACE FUNCTION public.commit_ai_credits(p_reservation_id uuid, p_credits int DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r ai_credit_reservations%ROWTYPE; v_amount int;
BEGIN
  UPDATE ai_credit_reservations SET status = 'committed', settled_at = now()
  WHERE id = p_reservation_id AND status = 'reserved'
  RETURNING * INTO r;
  IF NOT FOUND THEN RETURN false; END IF;
  v_amount := LEAST(r.credits, COALESCE(p_credits, r.credits));
  IF v_amount > 0 THEN
    INSERT INTO ai_usage_monthly (user_id, feature, period_start, amount, unit)
    VALUES (r.user_id, 'ai_credits', r.period_start, v_amount, 'credits')
    ON CONFLICT (user_id, feature, period_start)
    DO UPDATE SET amount = ai_usage_monthly.amount + excluded.amount, updated_at = now();
  END IF;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_ai_credits(p_reservation_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE ai_credit_reservations SET status = 'released', settled_at = now()
  WHERE id = p_reservation_id AND status = 'reserved';
  RETURN FOUND;
END;
$$;

-- Credits currently held by open reservations (shown as "in use" in the app).
CREATE OR REPLACE FUNCTION public.held_ai_credits(p_user_id uuid)
RETURNS int LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(sum(credits), 0)::int FROM ai_credit_reservations
  WHERE user_id = p_user_id AND status = 'reserved' AND expires_at > now()
    AND period_start = (date_trunc('month', now() AT TIME ZONE 'UTC'))::date;
$$;

REVOKE ALL ON FUNCTION public.reserve_ai_credits(uuid, int, int, text, int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commit_ai_credits(uuid, int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_ai_credits(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.held_ai_credits(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_ai_credits(uuid, int, int, text, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.commit_ai_credits(uuid, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_ai_credits(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.held_ai_credits(uuid) TO service_role;

-- ── 2. Background jobs ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.studio_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  request_id text UNIQUE CHECK (request_id IS NULL OR length(request_id) BETWEEN 8 AND 80),
  kind text NOT NULL,                                  -- video_clip (later: song, render, narration)
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
  project_kind text,                                   -- story | content | book | video ...
  project_id uuid,
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider text,
  provider_task_id text,                               -- lets polling resume after a restart
  reservation_id uuid REFERENCES public.ai_credit_reservations(id),
  credits int NOT NULL DEFAULT 0,
  progress int NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  result jsonb,
  error text,
  attempts int NOT NULL DEFAULT 0,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS studio_jobs_due_idx ON public.studio_jobs (next_run_at) WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS studio_jobs_user_idx ON public.studio_jobs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS studio_jobs_project_idx ON public.studio_jobs (project_kind, project_id, created_at DESC);
ALTER TABLE public.studio_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.studio_jobs FROM anon, authenticated;
GRANT ALL ON public.studio_jobs TO service_role;

-- ── 3. Gallery assets know their project and cost ──────────────────────────
ALTER TABLE public.gallery_assets
  ADD COLUMN IF NOT EXISTS project_kind text,
  ADD COLUMN IF NOT EXISTS project_id uuid,
  ADD COLUMN IF NOT EXISTS role text,                  -- cover | page_illustration | shot | narration | song ...
  ADD COLUMN IF NOT EXISTS provider text,
  ADD COLUMN IF NOT EXISTS provider_cost numeric(10,5),
  ADD COLUMN IF NOT EXISTS credits int,
  ADD COLUMN IF NOT EXISTS width int,
  ADD COLUMN IF NOT EXISTS height int,
  ADD COLUMN IF NOT EXISTS job_id uuid REFERENCES public.studio_jobs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS gallery_assets_project_idx ON public.gallery_assets (project_kind, project_id) WHERE project_id IS NOT NULL;

COMMIT;
