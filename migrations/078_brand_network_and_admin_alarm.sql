-- 078: (1) the brand-ads hub for all our own products, (2) admin alarms.
--
-- 1. Brand network. One list of our own products (One Dream, Bascardo
--    TaskMaster, Book of Memes, Bascardo Oxygen, One Dream marketplace
--    products, ...) with a video, a picture and download / visit links. Every
--    app shows the OTHER products: Book of Memes serves them through its own ad
--    slots, and the other apps fetch them from /api/brand/serve. Each partner
--    app has a key; with a "manage" key its admin panel (through its own
--    server) can add and edit products too. Book of Memes admins manage them
--    in the app.
-- 2. Admin alarm. A message waiting for an admin rings (in-app full-screen
--    alarm, and repeated Telegram/WhatsApp reminders) until an admin checks it
--    off or marks the conversation handled. A new message rings again.
BEGIN;

-- ── 1. Brand network ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.brand_partner_apps (
  app_key text PRIMARY KEY CHECK (app_key ~ '^[a-z0-9_]{2,40}$'),   -- e.g. bookofmemes, onedream, taskmaster, oxygen
  name text NOT NULL,
  api_key_hash text,                                   -- sha256 of the app's key; the key itself is shown once
  can_manage boolean NOT NULL DEFAULT false,           -- may add/edit products through the API
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.brand_partner_apps (app_key, name, can_manage) VALUES
  ('bookofmemes', 'Book of Memes', true), ('onedream', 'One Dream', true),
  ('taskmaster', 'Bascardo TaskMaster', true), ('oxygen', 'Bascardo Oxygen', true)
ON CONFLICT (app_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.brand_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_app text REFERENCES public.brand_partner_apps(app_key),   -- the app this promotes (null = a marketplace product)
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  headline text NOT NULL CHECK (length(headline) BETWEEN 1 AND 120),
  body text CHECK (body IS NULL OR length(body) <= 400),
  video_url text CHECK (video_url IS NULL OR video_url ~ '^https://'),
  image_url text CHECK (image_url IS NULL OR image_url ~ '^https://'),
  android_url text CHECK (android_url IS NULL OR android_url ~ '^https://'),   -- Play Store "download"
  ios_url text CHECK (ios_url IS NULL OR ios_url ~ '^https://'),
  web_url text CHECK (web_url IS NULL OR web_url ~ '^https://'),               -- "visit"
  cta_label text,
  show_in text[] NOT NULL DEFAULT ARRAY['bookofmemes', 'onedream', 'taskmaster', 'oxygen'],   -- which apps show it (never its own app)
  placements text[] NOT NULL DEFAULT ARRAY['home', 'explore', 'feed', 'search'],
  mode text NOT NULL DEFAULT 'fill' CHECK (mode IN ('fill', 'rotate')),        -- fill = only empty slots; rotate = competes with paid ads
  weight int NOT NULL DEFAULT 10 CHECK (weight BETWEEN 1 AND 100),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz,
  created_by_app text,
  created_by_user uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (video_url IS NOT NULL OR image_url IS NOT NULL),
  CHECK (android_url IS NOT NULL OR ios_url IS NOT NULL OR web_url IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS brand_products_live_idx ON public.brand_products (status, starts_at);

-- Views and taps per product, per app, per day (no personal data).
CREATE TABLE IF NOT EXISTS public.brand_ad_stats (
  product_id uuid NOT NULL REFERENCES public.brand_products(id) ON DELETE CASCADE,
  shown_in text NOT NULL,
  day date NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
  impressions int NOT NULL DEFAULT 0,
  clicks int NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, shown_in, day)
);
CREATE OR REPLACE FUNCTION public.brand_record_event(p_product_id uuid, p_app text, p_kind text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_kind NOT IN ('impression', 'click') THEN RETURN false; END IF;
  INSERT INTO brand_ad_stats (product_id, shown_in, impressions, clicks)
  VALUES (p_product_id, left(p_app, 40), CASE WHEN p_kind = 'impression' THEN 1 ELSE 0 END, CASE WHEN p_kind = 'click' THEN 1 ELSE 0 END)
  ON CONFLICT (product_id, shown_in, day) DO UPDATE
    SET impressions = brand_ad_stats.impressions + excluded.impressions, clicks = brand_ad_stats.clicks + excluded.clicks;
  RETURN true;
EXCEPTION WHEN foreign_key_violation THEN RETURN false;
END;
$$;

ALTER TABLE public.brand_partner_apps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.brand_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.brand_ad_stats ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.brand_partner_apps, public.brand_products, public.brand_ad_stats FROM anon, authenticated;
GRANT ALL ON public.brand_partner_apps, public.brand_products, public.brand_ad_stats TO service_role;
REVOKE ALL ON FUNCTION public.brand_record_event(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.brand_record_event(uuid, text, text) TO service_role;

-- ── 2. Admin alarm ──────────────────────────────────────────────────────────
ALTER TABLE public.support_threads
  ADD COLUMN IF NOT EXISTS admin_ack_at timestamptz,          -- an admin checked it off (until a new user message)
  ADD COLUMN IF NOT EXISTS admin_ack_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reminder_count int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reminder_last_at timestamptz;
ALTER TABLE public.admin_alert_config
  ADD COLUMN IF NOT EXISTS reminder_minutes int NOT NULL DEFAULT 15 CHECK (reminder_minutes BETWEEN 5 AND 240),
  ADD COLUMN IF NOT EXISTS max_reminders int NOT NULL DEFAULT 24 CHECK (max_reminders BETWEEN 1 AND 200);

COMMIT;
