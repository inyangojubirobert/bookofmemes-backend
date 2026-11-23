-- 087: recommendations from authors a user has engaged with, and push notifications
-- that pop up over other apps (Android heads-up, with sound), like WhatsApp/Facebook.
--
--   content_authors      one directory of every post (9 item types): author, title, cover, synopsis
--   affinity_signals     every way a user engaged with an author: views/reads, likes, bookmarks,
--                        shares, comments and replies, marketplace bids, messages, follows
--   author_affinity()    a user's authors, strongest first (weighted, fading over 30 days)
--   author_fans()        the users who engaged with an author (for "new post" pushes)
--   recommend_items()    that author's posts the user hasn't seen and wasn't shown in 30 days
--   push_devices         phones registered for push (FCM tokens)
--   notification_settings  per user: push on/off, recommendations on/off, quiet hours
--   notifications        + pushed_at / push_status / data (what to open when tapped)
--   recommendation_log   what was shown where (in-app card or push), and what the user did
-- Safe to run more than once.

DO $$
BEGIN
  IF to_regclass('public.profiles') IS NULL OR to_regclass('public.interactions') IS NULL OR to_regclass('public.notifications') IS NULL THEN
    RAISE EXCEPTION 'Wrong Supabase project: run this in the Book of Memes project (URL starts with zgyphn). Nothing was changed.';
  END IF;
END $$;

-- ── Every post, one shape ────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.content_authors AS
  SELECT 'stories'::text AS item_type, id AS item_id, author_id, title, COALESCE(cover_image_url, story_image_url, story_thumbnail_url) AS cover_url, COALESCE(NULLIF(story_synopsis, ''), description) AS synopsis, created_at, COALESCE(is_published, true) AS published FROM public.stories
  UNION ALL SELECT 'books_library', id, author_id, title, cover_image_url, description, created_at, COALESCE(is_published, true) FROM public.books_library
  UNION ALL SELECT 'podcast_box', id, author_id, title, cover_image_url, description, created_at, COALESCE(is_published, true) FROM public.podcast_box
  UNION ALL SELECT 'music_box', id, author_id, title, cover_image_url, description, created_at, COALESCE(is_published, true) FROM public.music_box
  UNION ALL SELECT 'tv_box', id, author_id, title, thumbnail_url, description, created_at, COALESCE(is_published, true) FROM public.tv_box
  UNION ALL SELECT 'memes', id, author_id, title, image_url, description, created_at, true FROM public.memes
  UNION ALL SELECT 'kids_collections', id, author_id, title, cover_image_url, description, created_at, true FROM public.kids_collections
  UNION ALL SELECT 'puzzles', id, author_id, title, NULL, description, created_at, true FROM public.puzzles;
REVOKE ALL ON public.content_authors FROM anon, authenticated;
GRANT SELECT ON public.content_authors TO service_role;

-- ── How users engaged with authors (weight = how strong the signal is) ───────
CREATE OR REPLACE VIEW public.affinity_signals AS
  SELECT i.user_id, ca.author_id, ca.item_type, ca.item_id,
         CASE i.interaction_type WHEN 'like' THEN 3 WHEN 'bookmark' THEN 4 WHEN 'share' THEN 4 WHEN 'comment' THEN 5 ELSE 1 END::numeric AS weight,
         i.created_at AS at, 'interaction'::text AS source
    FROM public.interactions i JOIN public.content_authors ca ON ca.item_type = i.item_type AND ca.item_id = i.item_id
  UNION ALL
  SELECT c.user_id, ca.author_id, ca.item_type, ca.item_id, 5, c.created_at, 'comment'      -- comments and replies
    FROM public.comments c JOIN public.content_authors ca ON ca.item_type = c.item_type::text AND ca.item_id = c.item_id
  UNION ALL
  SELECT b.bidder_id, COALESCE(l.creator_id, l.seller_id), l.item_type::text, l.item_id, 6, b.created_at, 'bid'
    FROM public.marketplace_bids b JOIN public.marketplace_listings l ON l.id = b.listing_id
  UNION ALL
  SELECT m.sender_id, m.recipient_id, NULL, NULL, 0.5, m.created_at, 'message'             -- talking to someone
    FROM public.messages m WHERE m.deleted_at IS NULL
  UNION ALL
  SELECT f.follower_id, f.following_id, NULL, NULL, 8, f.created_at, 'follow'
    FROM public.follows f;
REVOKE ALL ON public.affinity_signals FROM anon, authenticated;
GRANT SELECT ON public.affinity_signals TO service_role;

-- A user's authors, strongest first. Each signal fades with age (half-life ~3 weeks); messages are capped.
CREATE OR REPLACE FUNCTION public.author_affinity(p_user uuid, p_limit int DEFAULT 20)
RETURNS TABLE (author_id uuid, score numeric, last_at timestamptz, signals int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.author_id,
         round(sum(CASE WHEN s.source = 'message' THEN 0 ELSE s.weight * exp(-extract(epoch FROM now() - s.at) / 86400 / 30) END)
           + LEAST(4, sum(CASE WHEN s.source = 'message' THEN s.weight * exp(-extract(epoch FROM now() - s.at) / 86400 / 30) ELSE 0 END))::numeric, 3),
         max(s.at), count(*)::int
    FROM public.affinity_signals s
   WHERE s.user_id = p_user AND s.author_id IS NOT NULL AND s.author_id <> p_user AND s.at > now() - interval '180 days'
   GROUP BY s.author_id
   ORDER BY 2 DESC
   LIMIT p_limit;
$$;

-- Everyone who engaged with an author enough (for "a new post from an author you follow" pushes).
CREATE OR REPLACE FUNCTION public.author_fans(p_author uuid, p_min_score numeric DEFAULT 2, p_limit int DEFAULT 500)
RETURNS TABLE (user_id uuid, score numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.user_id, round(sum(CASE WHEN s.source = 'message' THEN LEAST(s.weight, 0.5) ELSE s.weight END * exp(-extract(epoch FROM now() - s.at) / 86400 / 30))::numeric, 3)
    FROM public.affinity_signals s
   WHERE s.author_id = p_author AND s.user_id <> p_author AND s.at > now() - interval '180 days'
   GROUP BY s.user_id
  HAVING sum(CASE WHEN s.source = 'message' THEN LEAST(s.weight, 0.5) ELSE s.weight END * exp(-extract(epoch FROM now() - s.at) / 86400 / 30)) >= p_min_score
   ORDER BY 2 DESC
   LIMIT p_limit;
$$;

-- ── Phones, settings, push state, recommendation history ─────────────────────
CREATE TABLE IF NOT EXISTS public.push_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  platform text NOT NULL DEFAULT 'android' CHECK (platform IN ('android', 'ios')),
  app_version text,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS push_devices_user_idx ON public.push_devices (user_id) WHERE enabled;

CREATE TABLE IF NOT EXISTS public.notification_settings (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  push_enabled boolean NOT NULL DEFAULT true,            -- any pop-up at all
  recommendations_enabled boolean NOT NULL DEFAULT true, -- "you might like" pop-ups and cards
  quiet_start smallint NOT NULL DEFAULT 22 CHECK (quiet_start BETWEEN 0 AND 23), -- no recommendation pop-ups from…
  quiet_end smallint NOT NULL DEFAULT 7 CHECK (quiet_end BETWEEN 0 AND 23),      -- …until (activity alerts still come)
  tz_offset_minutes smallint NOT NULL DEFAULT 60,        -- the phone's offset from UTC (sent by the app)
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS pushed_at timestamptz,
  ADD COLUMN IF NOT EXISTS push_status text,
  ADD COLUMN IF NOT EXISTS data jsonb;                    -- { item_type, item_id, screen } opened on tap
CREATE INDEX IF NOT EXISTS notifications_unpushed_idx ON public.notifications (created_at) WHERE pushed_at IS NULL;

CREATE TABLE IF NOT EXISTS public.recommendation_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  author_id uuid NOT NULL,
  item_type text NOT NULL,
  item_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('card', 'push')),
  reason text,
  shown_at timestamptz NOT NULL DEFAULT now(),
  action text CHECK (action IS NULL OR action IN ('opened', 'dismissed', 'less')),
  acted_at timestamptz
);
CREATE INDEX IF NOT EXISTS recommendation_log_user_idx ON public.recommendation_log (user_id, shown_at DESC);

-- What to recommend: posts by the user's authors that they haven't opened, newest first,
-- skipping anything shown to them (anywhere) in the last 30 days.
CREATE OR REPLACE FUNCTION public.recommend_items(p_user uuid, p_limit int DEFAULT 10, p_min_score numeric DEFAULT 2)
RETURNS TABLE (item_type text, item_id uuid, author_id uuid, author_score numeric, title text, cover_url text, synopsis text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH a AS (SELECT * FROM public.author_affinity(p_user, 15) WHERE score >= p_min_score)
  SELECT ca.item_type, ca.item_id, ca.author_id, a.score, ca.title, ca.cover_url, ca.synopsis, ca.created_at
    FROM a JOIN public.content_authors ca ON ca.author_id = a.author_id
   WHERE ca.published
     AND NOT EXISTS (SELECT 1 FROM public.interactions i WHERE i.user_id = p_user AND i.item_type = ca.item_type AND i.item_id = ca.item_id)
     AND NOT EXISTS (SELECT 1 FROM public.recommendation_log r WHERE r.user_id = p_user AND r.item_type = ca.item_type AND r.item_id = ca.item_id AND r.shown_at > now() - interval '30 days')
     AND NOT EXISTS (SELECT 1 FROM public.recommendation_log r WHERE r.user_id = p_user AND r.author_id = ca.author_id AND r.action = 'less' AND r.shown_at > now() - interval '60 days')
   ORDER BY a.score DESC, ca.created_at DESC
   LIMIT p_limit;
$$;

ALTER TABLE public.push_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recommendation_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.push_devices, public.notification_settings, public.recommendation_log FROM anon, authenticated;
GRANT ALL ON public.push_devices, public.notification_settings, public.recommendation_log TO service_role;
REVOKE ALL ON FUNCTION public.author_affinity(uuid, int), public.author_fans(uuid, numeric, int), public.recommend_items(uuid, int, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.author_affinity(uuid, int), public.author_fans(uuid, numeric, int), public.recommend_items(uuid, int, numeric) TO service_role;

NOTIFY pgrst, 'reload schema';
