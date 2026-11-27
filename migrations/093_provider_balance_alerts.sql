-- 093: Runware balance alerts for the admins (utils/providerBalance.js).
-- The server checks the Runware account balance every 30 minutes and alerts the admins
-- (Telegram / WhatsApp, Profile -> Admin inbox -> Alerts) once at each step down:
-- $100, $50, $20, $10, $5, then empty. This row remembers which step was last announced,
-- so a restart or deploy never repeats an alert, plus recent readings for the spend rate.
-- Server-only (service role); no policies. Safe to run more than once.

DO $$
BEGIN
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'Wrong project: run this in the Book of Memes project (URL starts with zgyphn). Nothing was changed.';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.provider_balance_state (
  provider      text PRIMARY KEY,               -- 'runware'
  balance       numeric,                        -- last reading, USD
  alerted_step  numeric,                        -- last announced step (100/50/20/10/5/0); NULL = above all
  low_since     timestamptz,                    -- first time it fell to $20 or below since the last top-up
  readings      jsonb NOT NULL DEFAULT '[]',    -- [{at, b}] last 7 days, for spend per day
  checked_at    timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.provider_balance_state ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
