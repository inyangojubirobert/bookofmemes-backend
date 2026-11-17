-- 058: Advertising, boosts and campaigns, on One Dream's model and prices.
--
-- Replaces the simpler promotions from 056 (its tables are empty). Ported
-- from One Dream's supabase/add_advertising.sql, add_ad_tier_packages.sql,
-- add_boost_tiers.sql and add_house_ads.sql, adapted to Book of Memes:
--   participants -> profiles; listings -> posts (item_type + item_id);
--   placements home / explore / feed / search.
--
--   advertising_packages      7 ad tiers ($10-$400) + 9 boost tiers ($3-$4,000)
--   advertising_entitlements  one per purchase (Google Play product, credits,
--                             or admin grant); a purchase is one campaign
--   advertising_media         Cloudinary references; private until approved
--   advertising_campaigns     ads (reviewed) and post boosts (live at once)
--   advertising_events        impressions / clicks, one per viewer per hour
--   advertising_moderation    every decision, logged
--   house_ads                 Book of Memes' own ads, filling empty slots
--
-- Duration policy (same as One Dream):
--   * The paid period starts when a campaign first goes live; review time
--     before that is never charged.
--   * Editing a live ad pauses it for re-review; the paused time is given
--     back on re-approval. A live boost can't be changed.
--   * Admin suspension for a policy breach doesn't stop the clock.
--   * Platform problems are compensated by an admin extension, capped at the
--     package duration.
--
-- All tables are server-only (the backend uses the service role); clients
-- read nothing directly. Run after 057. Safe to re-run.

BEGIN;

-- ── Remove 056 promotions (empty) ──────────────────────────────────────────
DROP FUNCTION IF EXISTS public.buy_promotion(text, text, uuid, text, text, text, text);
DROP FUNCTION IF EXISTS public.review_promotion(uuid, boolean, text);
DROP FUNCTION IF EXISTS public.remove_promotion(uuid, text);
DROP FUNCTION IF EXISTS public.stop_promotion(uuid);
DROP FUNCTION IF EXISTS public.get_sponsored(text, integer);
DROP FUNCTION IF EXISTS public.record_promotion_event(uuid, text);
DROP FUNCTION IF EXISTS public.promotion_credit_refund(uuid, text);
DO $$
DECLARE v_has boolean := false;
BEGIN
  IF to_regclass('public.promotions') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.promotions)' INTO v_has;
  END IF;
  IF v_has THEN
    RAISE EXCEPTION '058 replaces the 056 promotions tables, which already contain data';
  END IF;
END $$;
DROP TABLE IF EXISTS public.promotion_stats, public.promotion_events, public.promotions, public.ad_packages CASCADE;

-- ── Packages ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.advertising_packages (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9_]{2,40}$'),
  kind text NOT NULL CHECK (kind IN ('ad', 'boost')),
  name text NOT NULL,
  tagline text,
  price_usd numeric(10,2) NOT NULL CHECK (price_usd > 0),
  duration_hours integer NOT NULL CHECK (duration_hours > 0),
  max_creatives integer NOT NULL DEFAULT 1 CHECK (max_creatives BETWEEN 0 AND 10),
  placements text[] NOT NULL,
  priority integer NOT NULL DEFAULT 10 CHECK (priority BETWEEN 1 AND 100),
  allow_external_link boolean NOT NULL DEFAULT false,
  benefits jsonb NOT NULL DEFAULT '[]'::jsonb,
  highlight text,
  sort_order integer NOT NULL DEFAULT 100,
  google_play_product_id text UNIQUE,   -- null = not sold on Google Play (above Play's $400 limit)
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.advertising_placements (
  key text PRIMARY KEY,
  name text NOT NULL,
  max_active_ads integer NOT NULL DEFAULT 10 CHECK (max_active_ads BETWEEN 0 AND 100),
  is_active boolean NOT NULL DEFAULT true
);
INSERT INTO public.advertising_placements (key, name, max_active_ads) VALUES
  ('home', 'Home screen', 6),
  ('explore', 'Explore', 10),
  ('feed', 'Feeds', 10),
  ('search', 'Search results', 10)
ON CONFLICT (key) DO NOTHING;

-- One Dream's prices, tiers and durations. Boosts promote one of your posts;
-- ads are your own image/video, internal or with an external link. Every
-- package is a Google Play product priced exactly in USD. Premier ($1,500)
-- and Ultimate ($4,000) are above Google Play's $400 limit, so they are kept
-- switched off (One Dream sells them only on its website).
INSERT INTO public.advertising_packages
  (id, kind, name, tagline, price_usd, duration_hours, max_creatives, placements, priority, allow_external_link, benefits, highlight, sort_order, google_play_product_id)
VALUES
  ('starter_ads',  'ad', 'Starter Ads',  'Get your business seen',          10,  72, 1, '{explore,feed}',             10, true,
   '["3 days of sponsored placements", "1 creative (image or video)", "Standard delivery priority", "External link + analytics"]', NULL, 10, 'bom_ad_starter'),
  ('growth_ads',   'ad', 'Growth Ads',   'Reach more of the community',     20, 168, 2, '{home,explore,feed}',        20, true,
   '["7 days on home and discovery", "2 creatives (image or video)", "Enhanced delivery priority", "External link + analytics"]', 'Popular', 20, 'bom_ad_growth'),
  ('premium_ads',  'ad', 'Premium Ads',  'Premium visibility',              40, 360, 3, '{home,explore,feed,search}', 30, true,
   '["15 days in premium placements", "3 creatives (image or video)", "High delivery priority", "External link + analytics"]', NULL, 30, 'bom_ad_premium'),
  ('business_ads', 'ad', 'Business Ads', 'For established brands',          75, 720, 5, '{home,explore,feed,search}', 40, true,
   '["30 days across all eligible placements", "5 creatives (image or video)", "High delivery priority", "External link + analytics"]', NULL, 40, 'bom_ad_business'),
  ('bronze_ads',   'ad', 'Bronze Ads',   'More reach for a full month',    100, 720, 6, '{home,explore,feed,search}', 50, true,
   '["30 days across all eligible placements", "6 creatives (image or video)", "1.25x the exposure of Business Ads", "Featured first slot", "External link + analytics"]', NULL, 50, 'bom_ad_bronze'),
  ('silver_ads',   'ad', 'Silver Ads',   'Be seen more often, all month',  200, 720, 7, '{home,explore,feed,search}', 65, true,
   '["30 days across all eligible placements", "7 creatives (image or video)", "1.6x the exposure of Business Ads", "Featured first slot", "External link + analytics"]', NULL, 60, 'bom_ad_silver'),
  ('gold_ads',     'ad', 'Gold Ads',     'Premium exposure, all month',    400, 720, 8, '{home,explore,feed,search}', 80, true,
   '["30 days across all eligible placements", "8 creatives (image or video)", "2x the exposure of Business Ads", "Featured first slot", "External link + analytics"]', 'Top tier', 70, 'bom_ad_gold'),

  ('quick_boost',    'boost', 'Quick Boost',    'A one-day push for a post',           3,  24, 0, '{explore,feed}',        10, false, '["24 hours of extra visibility", "Explore and feeds", "Standard boost priority"]', NULL, 110, 'bom_boost_quick'),
  ('creator_boost',  'boost', 'Creator Boost',  'A week at the front of the shelf',   10, 168, 0, '{explore,feed,search}', 20, false, '["7 days of extra visibility", "Explore, feeds and search", "Enhanced boost priority"]', 'Popular', 120, 'bom_boost_creator'),
  ('power_boost',    'boost', 'Power Boost',    'A month of high visibility',         25, 720, 0, '{explore,feed,search}', 30, false, '["30 days of extra visibility", "Explore, feeds and search", "High boost priority"]', NULL, 130, 'bom_boost_power'),
  ('pro_boost',      'boost', 'Pro Boost',      'A month near the top',              100, 720, 0, '{explore,feed,search}', 40, false, '["30 days of extra visibility", "Explore, feeds and search", "High boost priority"]', NULL, 140, 'bom_boost_pro'),
  ('prime_boost',    'boost', 'Prime Boost',    'A month of stronger placement',     200, 720, 0, '{explore,feed,search}', 50, false, '["30 days of extra visibility", "Explore, feeds and search", "Very high boost priority"]', NULL, 144, 'bom_boost_prime'),
  ('star_boost',     'boost', 'Star Boost',     'A month of standout placement',     300, 720, 0, '{explore,feed,search}', 60, false, '["30 days of extra visibility", "Explore, feeds and search", "Premium boost priority"]', NULL, 147, 'bom_boost_star'),
  ('elite_boost',    'boost', 'Elite Boost',    'A month of premium placement',      400, 720, 0, '{explore,feed,search}', 70, false, '["30 days of extra visibility", "Explore, feeds and search", "Elite boost priority"]', NULL, 150, 'bom_boost_elite'),
  ('premier_boost',  'boost', 'Premier Boost',  'A month of top-level placement',   1500, 720, 0, '{explore,feed,search}', 85, false, '["30 days of extra visibility", "Explore, feeds and search", "Top-level boost priority"]', NULL, 160, NULL),
  ('ultimate_boost', 'boost', 'Ultimate Boost', 'A month at maximum priority',      4000, 720, 0, '{explore,feed,search}', 100, false, '["30 days of extra visibility", "Explore, feeds and search", "Maximum boost priority"]', 'Top tier', 170, NULL)
ON CONFLICT (id) DO NOTHING;
-- Above Google Play's $400 product limit: not sold in the app.
UPDATE public.advertising_packages SET is_active = false, updated_at = now()
 WHERE price_usd > 400 AND google_play_product_id IS NULL;

-- ── Entitlements (one per purchase) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.advertising_entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  package_id text NOT NULL REFERENCES public.advertising_packages(id),
  package_snapshot jsonb NOT NULL,                 -- terms as purchased
  provider text NOT NULL CHECK (provider IN ('google_play', 'credits', 'admin_grant')),
  provider_ref text NOT NULL,                      -- purchase token / credit charge id / grant id
  order_id text,
  price_usd numeric(10,2),
  is_paid boolean NOT NULL,
  status text NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'used', 'refunded', 'revoked')),
  note text,
  granted_by uuid,
  revoke_reason text,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT advertising_entitlements_provider_ref_key UNIQUE (provider, provider_ref)
);
CREATE INDEX IF NOT EXISTS advertising_entitlements_owner_idx ON public.advertising_entitlements (user_id, status);

-- ── Media (Cloudinary references only) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.advertising_media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  cloudinary_public_id text NOT NULL UNIQUE,
  cloudinary_asset_id text,
  resource_type text NOT NULL CHECK (resource_type IN ('image', 'video')),
  delivery_type text NOT NULL DEFAULT 'authenticated' CHECK (delivery_type IN ('authenticated', 'upload')),
  format text NOT NULL,
  bytes bigint NOT NULL CHECK (bytes > 0),
  width integer,
  height integer,
  duration_seconds numeric(8,2),
  version bigint,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'removed')),
  reviewed_by uuid,
  reviewed_at timestamptz,
  reject_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  -- Unapproved media is never publicly delivered.
  CONSTRAINT advertising_media_public_only_when_approved CHECK (delivery_type = 'authenticated' OR status = 'approved')
);
CREATE INDEX IF NOT EXISTS advertising_media_owner_idx ON public.advertising_media (owner_id, status);

-- ── Campaigns ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.advertising_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('ad', 'boost')),
  package_id text NOT NULL REFERENCES public.advertising_packages(id),
  entitlement_id uuid NOT NULL UNIQUE REFERENCES public.advertising_entitlements(id),
  title text NOT NULL CHECK (char_length(title) BETWEEN 2 AND 80),
  body text CHECK (body IS NULL OR char_length(body) <= 280),
  cta_label text CHECK (cta_label IS NULL OR char_length(cta_label) <= 24),
  destination_type text NOT NULL CHECK (destination_type IN ('external', 'post', 'profile')),
  destination_url text CHECK (destination_url IS NULL OR (destination_url LIKE 'https://%' AND char_length(destination_url) <= 2048)),
  destination_final_url text,
  destination_checked_at timestamptz,
  item_type text CHECK (item_type IS NULL OR item_type IN ('stories', 'memes', 'puzzles', 'kids_collections', 'music_box', 'podcast_box', 'tv_box')),
  item_id uuid,
  placements text[] NOT NULL DEFAULT '{}',
  priority integer NOT NULL DEFAULT 10,
  -- Set by the Add Content advert wizard: objective, audience, schedule,
  -- format and CTA, kept with the campaign for targeting and review.
  objective text,
  targeting jsonb,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending_review', 'active', 'paused', 'rejected', 'suspended', 'revoked')),
  starts_at timestamptz,
  ends_at timestamptz,
  submitted_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by uuid,
  review_note text,
  paused_at timestamptz,                            -- set while a live ad awaits re-review after an edit
  compensated_hours integer NOT NULL DEFAULT 0 CHECK (compensated_hours >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT advertising_campaigns_destination CHECK (
    (destination_type = 'external' AND destination_url IS NOT NULL)
    OR (destination_type = 'post' AND item_type IS NOT NULL AND item_id IS NOT NULL)
    OR destination_type = 'profile'
  ),
  CONSTRAINT advertising_campaigns_boost_post CHECK (kind = 'ad' OR destination_type = 'post')
);
CREATE INDEX IF NOT EXISTS advertising_campaigns_live_idx ON public.advertising_campaigns (status, ends_at);
CREATE INDEX IF NOT EXISTS advertising_campaigns_owner_idx ON public.advertising_campaigns (owner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.advertising_campaign_media (
  campaign_id uuid NOT NULL REFERENCES public.advertising_campaigns(id) ON DELETE CASCADE,
  media_id uuid NOT NULL REFERENCES public.advertising_media(id),
  position integer NOT NULL DEFAULT 0,
  PRIMARY KEY (campaign_id, media_id)
);

-- ── Analytics + moderation history ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.advertising_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  campaign_id uuid NOT NULL REFERENCES public.advertising_campaigns(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('impression', 'click')),
  placement text,
  viewer_key text NOT NULL,
  bucket timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT advertising_events_dedupe UNIQUE (campaign_id, kind, viewer_key, bucket)
);
CREATE INDEX IF NOT EXISTS advertising_events_campaign_idx ON public.advertising_events (campaign_id, kind);

CREATE TABLE IF NOT EXISTS public.advertising_moderation (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  campaign_id uuid REFERENCES public.advertising_campaigns(id) ON DELETE CASCADE,
  media_id uuid REFERENCES public.advertising_media(id),
  entitlement_id uuid REFERENCES public.advertising_entitlements(id),
  action text NOT NULL,
  actor text NOT NULL CHECK (actor IN ('admin', 'system', 'owner')),
  actor_id uuid,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── House ads (Book of Memes' own, admin-uploaded) ──────────────────────────
CREATE TABLE IF NOT EXISTS public.house_ads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (char_length(trim(title)) BETWEEN 2 AND 80),
  body text CHECK (body IS NULL OR char_length(body) <= 300),
  cta_label text CHECK (cta_label IS NULL OR char_length(cta_label) <= 24),
  destination_type text NOT NULL CHECK (destination_type IN ('external', 'post', 'profile')),
  destination_url text,
  item_type text,
  item_id uuid,
  profile_username text,
  resource_type text NOT NULL CHECK (resource_type IN ('image', 'video')),
  format text NOT NULL,
  cloudinary_public_id text NOT NULL UNIQUE,
  bytes bigint,
  width integer,
  height integer,
  duration_seconds numeric(8,2),
  version bigint,
  placements text[] NOT NULL DEFAULT ARRAY['home', 'explore', 'feed', 'search']::text[],
  mode text NOT NULL DEFAULT 'fill' CHECK (mode IN ('fill', 'rotate')),
  weight integer NOT NULL DEFAULT 10 CHECK (weight BETWEEN 1 AND 100),
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT house_ads_destination CHECK (
    (destination_type = 'external' AND destination_url ~ '^https://' AND item_id IS NULL AND profile_username IS NULL)
    OR (destination_type = 'post' AND item_type IS NOT NULL AND item_id IS NOT NULL AND destination_url IS NULL)
    OR (destination_type = 'profile' AND profile_username IS NOT NULL AND destination_url IS NULL)
  ),
  CONSTRAINT house_ads_placements CHECK (
    cardinality(placements) >= 1 AND placements <@ ARRAY['home', 'explore', 'feed', 'search']::text[]
  ),
  CONSTRAINT house_ads_window CHECK (ends_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS house_ads_live ON public.house_ads (status, starts_at, ends_at);

CREATE TABLE IF NOT EXISTS public.house_ad_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  house_ad_id uuid NOT NULL REFERENCES public.house_ads(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('impression', 'click')),
  placement text,
  viewer_key text NOT NULL,
  hour_bucket timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT house_ad_events_once UNIQUE (house_ad_id, kind, viewer_key, hour_bucket)
);
CREATE INDEX IF NOT EXISTS house_ad_events_ad ON public.house_ad_events (house_ad_id, kind);

-- ── Rules ───────────────────────────────────────────────────────────────────

-- Current owner of a post: the last marketplace buyer, else the author.
CREATE OR REPLACE FUNCTION public.ads_post_owner(p_item_type text, p_item_id uuid)
RETURNS uuid LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE
  v_owner uuid;
  v_author uuid;
BEGIN
  IF p_item_type NOT IN ('stories', 'memes', 'puzzles', 'kids_collections', 'music_box', 'podcast_box', 'tv_box') THEN
    RETURN NULL;
  END IF;
  SELECT to_user_id INTO v_owner FROM marketplace_ownership_history
   WHERE item_type = p_item_type AND item_id = p_item_id ORDER BY transferred_at DESC LIMIT 1;
  IF FOUND THEN RETURN v_owner; END IF;
  EXECUTE format('SELECT author_id FROM %I WHERE id = $1', p_item_type) INTO v_author USING p_item_id;
  RETURN v_author;
END;
$$;

-- Everything that must be true for a campaign to be (or become) live.
CREATE OR REPLACE FUNCTION public.ads_assert_publishable(p_campaign_id uuid)
RETURNS void LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  c advertising_campaigns%ROWTYPE;
  e advertising_entitlements%ROWTYPE;
  v_unapproved integer;
BEGIN
  SELECT * INTO c FROM advertising_campaigns WHERE id = p_campaign_id;
  SELECT * INTO e FROM advertising_entitlements WHERE id = c.entitlement_id;
  IF e.status <> 'used' THEN RAISE EXCEPTION 'entitlement_invalid'; END IF;
  IF c.ends_at IS NOT NULL AND c.ends_at <= now() THEN RAISE EXCEPTION 'campaign_expired'; END IF;
  SELECT count(*) INTO v_unapproved
    FROM advertising_campaign_media cm JOIN advertising_media m ON m.id = cm.media_id
   WHERE cm.campaign_id = c.id AND (m.status <> 'approved' OR m.delivery_type <> 'upload' OR m.owner_id IS DISTINCT FROM c.owner_id);
  IF v_unapproved > 0 THEN RAISE EXCEPTION 'media_not_approved'; END IF;
  IF c.kind = 'ad' AND NOT EXISTS (SELECT 1 FROM advertising_campaign_media WHERE campaign_id = c.id) THEN
    RAISE EXCEPTION 'creative_required';
  END IF;
  IF c.destination_type = 'external' AND c.destination_checked_at IS NULL THEN RAISE EXCEPTION 'destination_unchecked'; END IF;
  -- A website can change after it was checked: require a recent check.
  IF c.destination_type = 'external' AND c.destination_checked_at < now() - interval '7 days' THEN RAISE EXCEPTION 'destination_stale'; END IF;
  IF c.destination_type = 'post' AND ads_post_owner(c.item_type, c.item_id) IS DISTINCT FROM c.owner_id THEN
    RAISE EXCEPTION 'post_not_owned';
  END IF;
END;
$$;

-- Every placement the campaign uses must have room. A campaign paused for
-- re-review keeps its slot. Serialised so two approvals can't both take the
-- last slot.
CREATE OR REPLACE FUNCTION public.ads_assert_capacity(p_campaign_id uuid)
RETURNS void LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  c advertising_campaigns%ROWTYPE;
  v_full text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('advertising_placement_capacity'));
  SELECT * INTO c FROM advertising_campaigns WHERE id = p_campaign_id;
  IF c.kind <> 'ad' THEN RETURN; END IF;
  IF cardinality(c.placements) = 0 THEN RAISE EXCEPTION 'placements_full'; END IF;
  SELECT want.key INTO v_full
    FROM unnest(c.placements) AS want(key)
    LEFT JOIN advertising_placements p ON p.key = want.key
   WHERE p.key IS NULL OR NOT p.is_active
      OR (SELECT count(*) FROM advertising_campaigns x
           WHERE x.id <> c.id AND x.kind = 'ad' AND x.ends_at > now() AND p.key = ANY (x.placements)
             AND (x.status = 'active' OR (x.status = 'pending_review' AND x.paused_at IS NOT NULL))) >= p.max_active_ads
   LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION 'placements_full: %', COALESCE(v_full, 'unknown'); END IF;
END;
$$;

-- Goes live (first time) or resumes (after a pause for re-review).
CREATE OR REPLACE FUNCTION public.ads_go_live(p_campaign_id uuid)
RETURNS void LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  c advertising_campaigns%ROWTYPE;
  v_hours integer;
BEGIN
  SELECT * INTO c FROM advertising_campaigns WHERE id = p_campaign_id;
  SELECT (package_snapshot->>'duration_hours')::int INTO v_hours FROM advertising_entitlements WHERE id = c.entitlement_id;
  IF c.starts_at IS NULL THEN
    UPDATE advertising_campaigns
       SET status = 'active', starts_at = now(), ends_at = now() + make_interval(hours => v_hours), paused_at = NULL, updated_at = now()
     WHERE id = c.id;
  ELSE
    -- Paused for the advertiser's own edit: give the paused time back.
    UPDATE advertising_campaigns
       SET status = 'active',
           ends_at = ends_at + CASE WHEN paused_at IS NOT NULL THEN now() - paused_at ELSE interval '0' END,
           paused_at = NULL, updated_at = now()
     WHERE id = c.id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.ads_submit_campaign(p_campaign_id uuid, p_owner_id uuid)
RETURNS text LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  c advertising_campaigns%ROWTYPE;
  e advertising_entitlements%ROWTYPE;
  v_max integer;
  v_count integer;
  v_bad integer;
BEGIN
  SELECT * INTO c FROM advertising_campaigns WHERE id = p_campaign_id AND owner_id = p_owner_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'campaign_not_found'; END IF;
  IF c.status NOT IN ('draft', 'rejected', 'paused') THEN RAISE EXCEPTION 'campaign_not_submittable'; END IF;
  IF c.ends_at IS NOT NULL AND c.ends_at <= now() THEN RAISE EXCEPTION 'campaign_expired'; END IF;

  SELECT * INTO e FROM advertising_entitlements WHERE id = c.entitlement_id FOR UPDATE;
  IF e.status <> 'used' OR e.user_id IS DISTINCT FROM p_owner_id THEN RAISE EXCEPTION 'entitlement_invalid'; END IF;

  v_max := (e.package_snapshot->>'max_creatives')::int;
  SELECT count(*) INTO v_count FROM advertising_campaign_media WHERE campaign_id = c.id;
  SELECT count(*) INTO v_bad
    FROM advertising_campaign_media cm JOIN advertising_media m ON m.id = cm.media_id
   WHERE cm.campaign_id = c.id AND (m.owner_id IS DISTINCT FROM p_owner_id OR m.status IN ('rejected', 'removed'));
  IF v_bad > 0 THEN RAISE EXCEPTION 'media_invalid'; END IF;
  IF v_count > v_max THEN RAISE EXCEPTION 'too_many_creatives'; END IF;
  IF c.kind = 'ad' AND v_count < 1 THEN RAISE EXCEPTION 'creative_required'; END IF;

  IF c.destination_type = 'external' THEN
    IF COALESCE((e.package_snapshot->>'allow_external_link')::boolean, false) IS NOT TRUE THEN RAISE EXCEPTION 'external_link_not_allowed'; END IF;
    IF c.destination_checked_at IS NULL THEN RAISE EXCEPTION 'destination_unchecked'; END IF;
  END IF;

  IF c.kind = 'boost' THEN
    -- Boosts promote an already-public post: no new content to review.
    PERFORM ads_assert_publishable(c.id);
    PERFORM ads_go_live(c.id);
    UPDATE advertising_campaigns SET submitted_at = now() WHERE id = c.id;
    INSERT INTO advertising_moderation (campaign_id, action, actor, actor_id, note)
    VALUES (c.id, 'boost_activated', 'system', p_owner_id, 'Boost of an existing post');
    RETURN 'active';
  END IF;

  UPDATE advertising_campaigns SET status = 'pending_review', submitted_at = now(), updated_at = now() WHERE id = c.id;
  INSERT INTO advertising_moderation (campaign_id, action, actor, actor_id) VALUES (c.id, 'submitted', 'owner', p_owner_id);
  RETURN 'pending_review';
END;
$$;

CREATE OR REPLACE FUNCTION public.ads_review_campaign(p_campaign_id uuid, p_admin_id uuid, p_action text, p_note text)
RETURNS text LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  c advertising_campaigns%ROWTYPE;
BEGIN
  IF NOT is_app_admin(p_admin_id) THEN RAISE EXCEPTION 'admins_only'; END IF;
  SELECT * INTO c FROM advertising_campaigns WHERE id = p_campaign_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'campaign_not_found'; END IF;

  IF p_action = 'approve' THEN
    IF c.status <> 'pending_review' THEN RAISE EXCEPTION 'campaign_not_pending'; END IF;
    PERFORM ads_assert_publishable(c.id);
    PERFORM ads_assert_capacity(c.id);
    PERFORM ads_go_live(c.id);
    UPDATE advertising_campaigns SET reviewed_at = now(), reviewed_by = p_admin_id, review_note = p_note WHERE id = c.id;
  ELSIF p_action = 'reject' THEN
    IF c.status <> 'pending_review' THEN RAISE EXCEPTION 'campaign_not_pending'; END IF;
    UPDATE advertising_campaigns SET status = 'rejected', reviewed_at = now(), reviewed_by = p_admin_id, review_note = p_note, updated_at = now() WHERE id = c.id;
  ELSIF p_action = 'suspend' THEN
    -- Policy action: the clock keeps running.
    IF c.status NOT IN ('active', 'pending_review') THEN RAISE EXCEPTION 'campaign_not_suspendable'; END IF;
    UPDATE advertising_campaigns SET status = 'suspended', paused_at = NULL, reviewed_at = now(), reviewed_by = p_admin_id, review_note = p_note, updated_at = now() WHERE id = c.id;
  ELSIF p_action = 'reinstate' THEN
    IF c.status <> 'suspended' THEN RAISE EXCEPTION 'campaign_not_suspended'; END IF;
    IF c.starts_at IS NULL THEN
      UPDATE advertising_campaigns SET status = 'pending_review', reviewed_at = now(), reviewed_by = p_admin_id, review_note = p_note, updated_at = now() WHERE id = c.id;
    ELSE
      PERFORM ads_assert_publishable(c.id);
      PERFORM ads_assert_capacity(c.id);
      UPDATE advertising_campaigns SET status = 'active', reviewed_at = now(), reviewed_by = p_admin_id, review_note = p_note, updated_at = now() WHERE id = c.id;
    END IF;
  ELSE
    RAISE EXCEPTION 'invalid_action';
  END IF;

  INSERT INTO advertising_moderation (campaign_id, action, actor, actor_id, note) VALUES (c.id, p_action, 'admin', p_admin_id, p_note);
  RETURN (SELECT status FROM advertising_campaigns WHERE id = c.id);
END;
$$;

-- Compensation for platform problems; total capped at the package duration.
CREATE OR REPLACE FUNCTION public.ads_extend_campaign(p_campaign_id uuid, p_admin_id uuid, p_hours integer, p_note text)
RETURNS timestamptz LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  c advertising_campaigns%ROWTYPE;
  v_duration integer;
BEGIN
  IF NOT is_app_admin(p_admin_id) THEN RAISE EXCEPTION 'admins_only'; END IF;
  IF COALESCE(trim(p_note), '') = '' THEN RAISE EXCEPTION 'note_required'; END IF;
  SELECT * INTO c FROM advertising_campaigns WHERE id = p_campaign_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'campaign_not_found'; END IF;
  IF c.starts_at IS NULL OR c.status IN ('revoked') THEN RAISE EXCEPTION 'campaign_not_started'; END IF;
  SELECT (package_snapshot->>'duration_hours')::int INTO v_duration FROM advertising_entitlements WHERE id = c.entitlement_id;
  IF p_hours IS NULL OR p_hours < 1 OR c.compensated_hours + p_hours > v_duration THEN RAISE EXCEPTION 'extension_too_long'; END IF;
  UPDATE advertising_campaigns
     SET ends_at = greatest(ends_at, now()) + make_interval(hours => p_hours),
         compensated_hours = compensated_hours + p_hours, updated_at = now()
   WHERE id = c.id;
  INSERT INTO advertising_moderation (campaign_id, action, actor, actor_id, note)
  VALUES (c.id, 'extended_' || p_hours || 'h', 'admin', p_admin_id, p_note);
  RETURN (SELECT ends_at FROM advertising_campaigns WHERE id = c.id);
END;
$$;

-- Withdraws approval of a creative (the backend first makes the Cloudinary
-- asset private again). Live campaigns using it are suspended at once.
CREATE OR REPLACE FUNCTION public.ads_reject_media(p_media_id uuid, p_admin_id uuid, p_note text)
RETURNS integer LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_suspended integer;
BEGIN
  IF NOT is_app_admin(p_admin_id) THEN RAISE EXCEPTION 'admins_only'; END IF;
  IF COALESCE(trim(p_note), '') = '' THEN RAISE EXCEPTION 'note_required'; END IF;
  UPDATE advertising_media
     SET status = 'rejected', delivery_type = 'authenticated', reviewed_by = p_admin_id, reviewed_at = now(), reject_reason = p_note
   WHERE id = p_media_id AND status IN ('pending', 'approved');
  IF NOT FOUND THEN RAISE EXCEPTION 'media_not_found'; END IF;
  UPDATE advertising_campaigns
     SET status = 'suspended', paused_at = NULL, review_note = 'A creative was withdrawn: ' || p_note, updated_at = now()
   WHERE status IN ('active', 'pending_review')
     AND id IN (SELECT campaign_id FROM advertising_campaign_media WHERE media_id = p_media_id);
  GET DIAGNOSTICS v_suspended = ROW_COUNT;
  INSERT INTO advertising_moderation (media_id, action, actor, actor_id, note) VALUES (p_media_id, 'media_rejected', 'admin', p_admin_id, p_note);
  RETURN v_suspended;
END;
$$;

-- Any change to what a live ad shows or where it leads withdraws its approval,
-- whoever makes the change (enforced here, not only in the backend).
CREATE OR REPLACE FUNCTION public.ads_campaign_requires_review()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF OLD.status = 'active' AND NEW.status IN ('active', 'pending_review') AND (
       NEW.title IS DISTINCT FROM OLD.title OR NEW.body IS DISTINCT FROM OLD.body
    OR NEW.cta_label IS DISTINCT FROM OLD.cta_label OR NEW.destination_type IS DISTINCT FROM OLD.destination_type
    OR NEW.destination_url IS DISTINCT FROM OLD.destination_url OR NEW.item_id IS DISTINCT FROM OLD.item_id
    OR NEW.item_type IS DISTINCT FROM OLD.item_type) THEN
    IF OLD.kind = 'boost' THEN RAISE EXCEPTION 'live_boost_locked'; END IF;
    NEW.status := 'pending_review';
  END IF;
  IF OLD.status = 'active' AND NEW.status = 'pending_review' THEN
    NEW.paused_at := COALESCE(NEW.paused_at, now());
    NEW.submitted_at := now();
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS advertising_campaigns_requires_review ON public.advertising_campaigns;
CREATE TRIGGER advertising_campaigns_requires_review
  BEFORE UPDATE ON public.advertising_campaigns
  FOR EACH ROW EXECUTE FUNCTION public.ads_campaign_requires_review();

CREATE OR REPLACE FUNCTION public.ads_media_change_requires_review()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_campaign uuid := COALESCE(NEW.campaign_id, OLD.campaign_id);
BEGIN
  IF EXISTS (SELECT 1 FROM advertising_campaigns WHERE id = v_campaign AND status = 'active' AND kind = 'boost') THEN
    RAISE EXCEPTION 'live_boost_locked';
  END IF;
  UPDATE advertising_campaigns SET status = 'pending_review' WHERE id = v_campaign AND status = 'active';
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS advertising_campaign_media_requires_review ON public.advertising_campaign_media;
CREATE TRIGGER advertising_campaign_media_requires_review
  AFTER INSERT OR UPDATE OR DELETE ON public.advertising_campaign_media
  FOR EACH ROW EXECUTE FUNCTION public.ads_media_change_requires_review();

-- One impression / click per campaign, viewer and hour; only for live campaigns.
CREATE OR REPLACE FUNCTION public.ads_record_event(p_campaign_id uuid, p_kind text, p_placement text, p_viewer_key text)
RETURNS boolean LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_inserted integer;
BEGIN
  IF p_kind NOT IN ('impression', 'click') OR COALESCE(char_length(p_viewer_key), 0) NOT BETWEEN 8 AND 128 THEN
    RETURN false;
  END IF;
  INSERT INTO advertising_events (campaign_id, kind, placement, viewer_key, bucket)
  SELECT p_campaign_id, p_kind, left(p_placement, 30), p_viewer_key, date_trunc('hour', now())
   WHERE EXISTS (SELECT 1 FROM advertising_campaigns
                  WHERE id = p_campaign_id AND status = 'active' AND starts_at <= now() AND ends_at > now())
  ON CONFLICT ON CONSTRAINT advertising_events_dedupe DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted > 0;
END;
$$;

CREATE OR REPLACE FUNCTION public.house_ads_record_event(p_house_ad_id uuid, p_kind text, p_placement text, p_viewer_key text)
RETURNS boolean LANGUAGE plpgsql SET search_path = public AS $$
DECLARE inserted bigint;
BEGIN
  IF p_kind NOT IN ('impression', 'click') OR COALESCE(p_viewer_key, '') = '' THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM house_ads WHERE id = p_house_ad_id AND status = 'active') THEN RETURN false; END IF;
  INSERT INTO house_ad_events (house_ad_id, kind, placement, viewer_key, hour_bucket)
  VALUES (p_house_ad_id, p_kind, left(p_placement, 20), left(p_viewer_key, 100), date_trunc('hour', now()))
  ON CONFLICT ON CONSTRAINT house_ad_events_once DO NOTHING
  RETURNING id INTO inserted;
  RETURN inserted IS NOT NULL;
END;
$$;

-- Refund or revocation (Google Play voided purchase, admin): the campaign ends.
CREATE OR REPLACE FUNCTION public.ads_revoke_entitlement(p_provider text, p_provider_ref text, p_status text, p_reason text)
RETURNS integer LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  e advertising_entitlements%ROWTYPE;
BEGIN
  IF p_status NOT IN ('refunded', 'revoked') THEN RAISE EXCEPTION 'invalid_status'; END IF;
  SELECT * INTO e FROM advertising_entitlements WHERE provider = p_provider AND provider_ref = p_provider_ref FOR UPDATE;
  IF NOT FOUND OR e.status IN ('refunded', 'revoked') THEN RETURN 0; END IF;
  UPDATE advertising_entitlements SET status = p_status, revoke_reason = p_reason, revoked_at = now(), updated_at = now() WHERE id = e.id;
  UPDATE advertising_campaigns SET status = 'revoked', paused_at = NULL, review_note = p_reason, updated_at = now()
   WHERE entitlement_id = e.id AND status <> 'revoked';
  INSERT INTO advertising_moderation (entitlement_id, campaign_id, action, actor, note)
  VALUES (e.id, (SELECT id FROM advertising_campaigns WHERE entitlement_id = e.id), p_status, 'system', p_reason);
  RETURN 1;
END;
$$;

-- Book of Memes addition: buy a package with credits (Google Play-bought, so
-- no money comes in outside Google Play). Credits held for marketplace-era
-- bids are never spent; vouchers are not used for ads.
CREATE OR REPLACE FUNCTION public.ads_buy_with_credits(p_user_id uuid, p_package_id text)
RETURNS advertising_entitlements LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_pkg advertising_packages%ROWTYPE;
  v_wallet wallets%ROWTYPE;
  v_ref uuid := gen_random_uuid();
  v_ent advertising_entitlements%ROWTYPE;
BEGIN
  IF EXISTS (SELECT 1 FROM account_deletion_requests WHERE user_id = p_user_id AND status = 'pending') THEN
    RAISE EXCEPTION 'account_being_deleted';
  END IF;
  SELECT * INTO v_pkg FROM advertising_packages WHERE id = p_package_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'package_unavailable'; END IF;
  PERFORM ensure_wallet(p_user_id);
  SELECT * INTO v_wallet FROM wallets WHERE user_id = p_user_id FOR UPDATE;
  IF wallet_available_balance(v_wallet.id) < v_pkg.price_usd THEN RAISE EXCEPTION 'insufficient_credits'; END IF;

  UPDATE wallets SET wallet_balance = wallet_balance - v_pkg.price_usd, updated_at = now() WHERE id = v_wallet.id;
  INSERT INTO wallet_transactions (wallet_id, type, amount, description, status, currency_code, metadata)
  VALUES (v_wallet.id, 'ad_campaign_charge', -v_pkg.price_usd, v_pkg.name, 'completed', 'USD',
          jsonb_build_object('package_id', v_pkg.id, 'charge_ref', v_ref));

  INSERT INTO advertising_entitlements (user_id, package_id, package_snapshot, provider, provider_ref, price_usd, is_paid, status)
  VALUES (p_user_id, v_pkg.id,
          jsonb_build_object('id', v_pkg.id, 'kind', v_pkg.kind, 'name', v_pkg.name, 'price_usd', v_pkg.price_usd,
                             'duration_hours', v_pkg.duration_hours, 'max_creatives', v_pkg.max_creatives,
                             'placements', to_jsonb(v_pkg.placements), 'priority', v_pkg.priority,
                             'allow_external_link', v_pkg.allow_external_link),
          'credits', v_ref::text, v_pkg.price_usd, true, 'available')
  RETURNING * INTO v_ent;

  PERFORM record_revenue(
    p_source => 'advertising', p_user_id => p_user_id, p_reference_id => v_ent.id,
    p_gross_amount => v_pkg.price_usd, p_revenue_amount => v_pkg.price_usd, p_currency => 'USD',
    p_payment_method => 'credits', p_original_currency => 'USD', p_original_amount => v_pkg.price_usd,
    p_metadata => jsonb_build_object('package_id', v_pkg.id));
  RETURN v_ent;
END;
$$;

INSERT INTO public.revenue_sources (source, fee_type, category, enabled, description)
VALUES ('advertising', 'fixed', 'advertising', true, 'Ad and boost packages (advertising_packages)')
ON CONFLICT (source) DO NOTHING;

-- ── Server-only access ──────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['advertising_packages', 'advertising_placements', 'advertising_entitlements', 'advertising_media',
                           'advertising_campaigns', 'advertising_campaign_media', 'advertising_events', 'advertising_moderation',
                           'house_ads', 'house_ad_events'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated, public', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', t);
    END IF;
  END LOOP;
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'ads_post_owner(text, uuid)', 'ads_assert_publishable(uuid)', 'ads_assert_capacity(uuid)', 'ads_go_live(uuid)',
    'ads_submit_campaign(uuid, uuid)', 'ads_review_campaign(uuid, uuid, text, text)',
    'ads_extend_campaign(uuid, uuid, integer, text)', 'ads_reject_media(uuid, uuid, text)',
    'ads_record_event(uuid, text, text, text)', 'house_ads_record_event(uuid, text, text, text)',
    'ads_revoke_entitlement(text, text, text, text)', 'ads_buy_with_credits(uuid, text)',
    'ads_campaign_requires_review()', 'ads_media_change_requires_review()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM public, anon, authenticated', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
    END IF;
  END LOOP;
END $$;

COMMIT;
