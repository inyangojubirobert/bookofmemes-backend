-- 065: AI credits were never being counted.
--
-- The live ai_usage_monthly table has a check constraint
-- (ai_usage_monthly_feature_unit_check) that pairs each feature with its unit
-- and doesn't know feature 'ai_credits' / unit 'credits'. Every credit spend
-- since 059 (chat, writing, translation, images, video, voice, stories) failed
-- that check; the backend logs and swallows the failure so the user still gets
-- their result, so nobody's monthly pool ever went down. Found 2026-11-18:
-- increment_ai_usage('ai_credits', ..., 'credits') -> 23514 feature_unit_check.
--
-- Replace every unit/feature check on the table with one that allows the
-- credit pool. NOT VALID keeps any odd historical rows; new rows are checked.
BEGIN;

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.ai_usage_monthly'::regclass AND contype = 'c'
              AND (pg_get_constraintdef(oid) ILIKE '%unit%' OR pg_get_constraintdef(oid) ILIKE '%feature%') LOOP
    EXECUTE format('ALTER TABLE public.ai_usage_monthly DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE public.ai_usage_monthly ADD CONSTRAINT ai_usage_monthly_unit_check
  CHECK (unit IN ('generations', 'seconds', 'credits')) NOT VALID;
ALTER TABLE public.ai_usage_monthly ADD CONSTRAINT ai_usage_monthly_credits_unit_check
  CHECK (feature <> 'ai_credits' OR unit = 'credits') NOT VALID;

COMMIT;

-- Check (should return a row with amount 0, then nothing left behind):
--   select increment_ai_usage('<your profile id>', 'ai_credits', date_trunc('month', now())::date, 0, 'credits');
