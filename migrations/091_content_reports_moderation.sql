-- 091: Reporting and moderation (Google Play's User Generated Content policy).
-- Users report a post, a comment or a person (reasons below); admins see open reports in the app
-- (Profile → Reports), get a Telegram/WhatsApp alert for each new one, and can remove the content,
-- dismiss the report or suspend the account. Blocking stays in blocked_users (chats already use it);
-- the app now also blocks from posts, comments and profiles, and hides blocked people's content.
-- Everything here is server-only (service_role); the app goes through /api/moderation.
-- Safe to run more than once.

DO $$
BEGIN
  IF to_regclass('public.profiles') IS NULL OR to_regclass('public.blocked_users') IS NULL THEN
    RAISE EXCEPTION 'Wrong Supabase project: run this in the Book of Memes project (URL starts with zgyphn). Nothing was changed.';
  END IF;
END $$; 

CREATE TABLE IF NOT EXISTS public.content_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  target text NOT NULL CHECK (target IN ('content', 'comment', 'user')),
  item_type text,                 -- content: stories, memes, music_box, …
  item_id uuid,                   -- content: the post; comment: the post it is on
  comment_id uuid,                -- comment
  target_user_id uuid,            -- who posted it (or the reported person)
  reason text NOT NULL CHECK (reason IN ('spam', 'nudity', 'hate', 'violence', 'copyright', 'other')),
  details text CHECK (char_length(details) <= 1000),
  snapshot jsonb,                 -- what it looked like when reported (title, text, picture)
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'removed', 'dismissed', 'suspended')),
  resolved_by uuid,
  resolved_at timestamptz,
  resolution_note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS content_reports_open_idx ON public.content_reports (created_at DESC) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS content_reports_target_idx ON public.content_reports (target, item_id, comment_id, target_user_id);
-- One open report per person per thing.
CREATE UNIQUE INDEX IF NOT EXISTS content_reports_one_open ON public.content_reports
  (reporter_id, target, coalesce(item_id, '00000000-0000-0000-0000-000000000000'::uuid),
   coalesce(comment_id, '00000000-0000-0000-0000-000000000000'::uuid),
   coalesce(target_user_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE status = 'open';
ALTER TABLE public.content_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.content_reports FROM anon, authenticated;
GRANT ALL ON public.content_reports TO service_role;

-- Suspended accounts (the sign-in ban itself is Supabase Auth's; these say when and why).
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS suspended_at timestamptz;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS suspended_reason text;

NOTIFY pgrst, 'reload schema';
