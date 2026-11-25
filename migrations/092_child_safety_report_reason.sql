-- 092: a "Child sexual abuse or exploitation" report reason (Google Play's child safety standards:
-- users must be able to report child safety concerns in the app). Reports with this reason are
-- flagged urgent to the admins. See bookofmemes.cc/child-safety. Safe to run more than once.

DO $$
BEGIN
  IF to_regclass('public.content_reports') IS NULL THEN
    RAISE EXCEPTION 'Run 091 first (content_reports is missing), in the Book of Memes project (URL starts with zgyphn). Nothing was changed.';
  END IF;
END $$;

ALTER TABLE public.content_reports DROP CONSTRAINT IF EXISTS content_reports_reason_check;
ALTER TABLE public.content_reports ADD CONSTRAINT content_reports_reason_check
  CHECK (reason IN ('child_safety', 'spam', 'nudity', 'hate', 'violence', 'copyright', 'other'));

NOTIFY pgrst, 'reload schema';
