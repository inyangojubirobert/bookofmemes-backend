-- 056: Promotions (post boosts and sponsored ads), priced like One Dream.
--
-- Paid with credits (Google Play), so Google Billing is the only way money
-- comes in for these. Credit packs in Backend/config/playProducts.js line up
-- with every package price.
--
--   boost: promote your own post (or one you own through the marketplace).
--          Goes live immediately.
--   ad:    a sponsored card with your own image, text and external link.
--          Waits for admin review; credits are refunded if it's rejected.
--
-- Serving: get_sponsored(placement) picks live promotions, weighted by the
-- package's priority, never showing users their own. Impressions and clicks
-- are counted once per viewer per day, so they can't be inflated.
--
-- Run after 055 (uses is_app_admin). Safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS public.ad_packages (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('boost', 'ad')),
  name text NOT NULL,
  tagline text,
  price_usd numeric(10,2) NOT NULL CHECK (price_usd > 0 AND price_usd <= 400),
  duration_hours integer NOT NULL CHECK (duration_hours > 0),
  placements text[] NOT NULL,
  priority integer NOT NULL CHECK (priority > 0),
  allow_external_link boolean NOT NULL DEFAULT false,
  benefits jsonb NOT NULL DEFAULT '[]'::jsonb,
  highlight text,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ad_packages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ad_packages_read ON public.ad_packages;
CREATE POLICY ad_packages_read ON public.ad_packages FOR SELECT USING (true);
REVOKE INSERT, UPDATE, DELETE ON public.ad_packages FROM anon, authenticated;

-- Same ladder as One Dream. Edit prices here (or in the table) any time;
-- changes only affect future purchases.
INSERT INTO public.ad_packages
  (id, kind, name, tagline, price_usd, duration_hours, placements, priority, allow_external_link, benefits, highlight, sort_order)
VALUES
  ('quick_boost',  'boost', 'Quick Boost',  'A one-day push for a post',        3,   24, '{explore,feed}',               10, false, '["24 hours of extra visibility","Explore and feeds","Standard priority"]', NULL, 10),
  ('weekly_boost', 'boost', 'Weekly Boost', 'A week at the front',             10,  168, '{explore,feed,search}',        20, false, '["7 days of extra visibility","Explore, feeds and search","Enhanced priority"]', 'Popular', 20),
  ('power_boost',  'boost', 'Power Boost',  'A month of maximum visibility',   25,  720, '{home,explore,feed,search}',   30, false, '["30 days of extra visibility","Every placement","High priority"]', NULL, 30),
  ('starter_ads',  'ad',    'Starter Ads',  'Get your business seen',          10,   72, '{explore,feed}',               10, true,  '["3 days of sponsored placements","1 image","Standard priority","External link + analytics"]', NULL, 110),
  ('growth_ads',   'ad',    'Growth Ads',   'Reach more of the community',     20,  168, '{home,explore,feed}',          20, true,  '["7 days on home and discovery","Enhanced priority","External link + analytics"]', 'Popular', 120),
  ('premium_ads',  'ad',    'Premium Ads',  'Premium visibility',              40,  360, '{home,explore,feed,search}',   30, true,  '["15 days in premium placements","High priority","External link + analytics"]', NULL, 130),
  ('business_ads', 'ad',    'Business Ads', 'For established brands',          75,  720, '{home,explore,feed,search}',   40, true,  '["30 days across all placements","High priority","External link + analytics"]', NULL, 140),
  ('bronze_ads',   'ad',    'Bronze Ads',   'More reach for a full month',    100,  720, '{home,explore,feed,search}',   50, true,  '["30 days across all placements","1.25x the exposure of Business Ads","External link + analytics"]', NULL, 150),
  ('silver_ads',   'ad',    'Silver Ads',   'Be seen more often, all month',  200,  720, '{home,explore,feed,search}',   65, true,  '["30 days across all placements","1.6x the exposure of Business Ads","External link + analytics"]', NULL, 160),
  ('gold_ads',     'ad',    'Gold Ads',     'Premium exposure, all month',    400,  720, '{home,explore,feed,search}',   80, true,  '["30 days across all placements","2x the exposure of Business Ads","External link + analytics"]', 'Top tier', 170)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.promotions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
  package_id text NOT NULL REFERENCES public.ad_packages(id),
  package_snapshot jsonb NOT NULL,
  kind text NOT NULL CHECK (kind IN ('boost', 'ad')),
  status text NOT NULL CHECK (status IN ('pending_review', 'active', 'rejected', 'stopped', 'removed')),
  item_type text,
  item_id uuid,
  headline text CHECK (headline IS NULL OR char_length(headline) BETWEEN 3 AND 60),
  body text CHECK (body IS NULL OR char_length(body) <= 140),
  media_url text,
  link_url text CHECK (link_url IS NULL OR link_url ~ '^https://[^\s]+$'),
  price_paid numeric(10,2) NOT NULL,
  starts_at timestamptz,
  ends_at timestamptz,
  review_note text,
  reviewed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'boost' OR (item_type IS NOT NULL AND item_id IS NOT NULL)),
  CHECK (kind <> 'ad' OR (headline IS NOT NULL AND media_url IS NOT NULL AND link_url IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS promotions_live_idx ON public.promotions (status, ends_at);
CREATE INDEX IF NOT EXISTS promotions_user_idx ON public.promotions (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.promotion_events (
  promotion_id uuid NOT NULL REFERENCES public.promotions(id) ON DELETE CASCADE,
  viewer_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('impression', 'click')),
  day date NOT NULL DEFAULT current_date,
  PRIMARY KEY (promotion_id, viewer_id, kind, day)
);

CREATE TABLE IF NOT EXISTS public.promotion_stats (
  promotion_id uuid PRIMARY KEY REFERENCES public.promotions(id) ON DELETE CASCADE,
  impressions bigint NOT NULL DEFAULT 0,
  clicks bigint NOT NULL DEFAULT 0
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['promotions','promotion_events','promotion_stats'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON public.%I FROM anon, authenticated', t);
  END LOOP;
END $$;
DROP POLICY IF EXISTS promotions_own ON public.promotions;
CREATE POLICY promotions_own ON public.promotions FOR SELECT USING (auth.uid() = user_id OR is_app_admin());
DROP POLICY IF EXISTS promotion_stats_own ON public.promotion_stats;
CREATE POLICY promotion_stats_own ON public.promotion_stats FOR SELECT
  USING (is_app_admin() OR EXISTS (SELECT 1 FROM promotions p WHERE p.id = promotion_id AND p.user_id = auth.uid()));

-- Charge or refund credits (wallets.wallet_balance) for promotions.
CREATE OR REPLACE FUNCTION public.promotion_credit_refund(p_promotion_id uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_p promotions%ROWTYPE;
  v_wallet wallets%ROWTYPE;
BEGIN
  SELECT * INTO v_p FROM promotions WHERE id = p_promotion_id FOR UPDATE;
  IF v_p.user_id IS NULL THEN RETURN; END IF;
  PERFORM ensure_wallet(v_p.user_id);
  SELECT * INTO v_wallet FROM wallets WHERE user_id = v_p.user_id FOR UPDATE;
  UPDATE wallets SET wallet_balance = wallet_balance + v_p.price_paid, updated_at = now() WHERE id = v_wallet.id;
  INSERT INTO wallet_transactions (wallet_id, type, amount, description, status, currency_code, metadata)
    VALUES (v_wallet.id, 'ad_campaign_refund', v_p.price_paid, 'Promotion refund: ' || p_reason, 'completed', 'USD',
            jsonb_build_object('promotion_id', v_p.id));
END;
$$;
REVOKE ALL ON FUNCTION public.promotion_credit_refund(uuid, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.buy_promotion(
  p_package_id text,
  p_item_type text DEFAULT NULL, p_item_id uuid DEFAULT NULL,
  p_headline text DEFAULT NULL, p_body text DEFAULT NULL, p_media_url text DEFAULT NULL, p_link_url text DEFAULT NULL
) RETURNS promotions LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_pkg ad_packages%ROWTYPE;
  v_author uuid;
  v_owner uuid;
  v_charge jsonb;
  v_p promotions%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF EXISTS (SELECT 1 FROM account_deletion_requests WHERE user_id = v_uid AND status = 'pending') THEN
    RAISE EXCEPTION 'This account is being deleted';
  END IF;
  SELECT * INTO v_pkg FROM ad_packages WHERE id = p_package_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Package not available'; END IF;

  IF v_pkg.kind = 'boost' THEN
    IF p_item_type NOT IN ('stories', 'memes', 'puzzles', 'kids_collections', 'music_box', 'podcast_box', 'tv_box') OR p_item_id IS NULL THEN
      RAISE EXCEPTION 'Choose the post to boost';
    END IF;
    EXECUTE format('SELECT author_id FROM %I WHERE id = $1', p_item_type) INTO v_author USING p_item_id;
    SELECT to_user_id INTO v_owner FROM marketplace_ownership_history
      WHERE item_type = p_item_type AND item_id = p_item_id ORDER BY transferred_at DESC LIMIT 1;
    IF NOT FOUND THEN v_owner := v_author; END IF;
    IF v_owner IS DISTINCT FROM v_uid THEN RAISE EXCEPTION 'You can only boost posts you own'; END IF;
    p_headline := NULL; p_body := NULL; p_media_url := NULL; p_link_url := NULL;
  ELSE
    IF p_headline IS NULL OR p_media_url IS NULL OR p_link_url IS NULL THEN
      RAISE EXCEPTION 'An ad needs a headline, an image and a link';
    END IF;
    IF p_media_url !~ '^https://res\.cloudinary\.com/' THEN
      RAISE EXCEPTION 'Upload the ad image through the app';
    END IF;
    p_item_type := NULL; p_item_id := NULL;
  END IF;

  v_charge := consume_app_balance(v_pkg.price_usd, 'Promotion: ' || v_pkg.name);
  IF NOT (v_charge ->> 'success')::boolean THEN
    RAISE EXCEPTION '%', COALESCE(v_charge ->> 'error', 'Not enough credits');
  END IF;

  INSERT INTO promotions (user_id, package_id, package_snapshot, kind, status, item_type, item_id,
                          headline, body, media_url, link_url, price_paid, starts_at, ends_at)
  VALUES (v_uid, v_pkg.id, to_jsonb(v_pkg), v_pkg.kind,
          CASE WHEN v_pkg.kind = 'boost' THEN 'active' ELSE 'pending_review' END,
          p_item_type, p_item_id, p_headline, p_body, p_media_url, p_link_url, v_pkg.price_usd,
          CASE WHEN v_pkg.kind = 'boost' THEN now() END,
          CASE WHEN v_pkg.kind = 'boost' THEN now() + make_interval(hours => v_pkg.duration_hours) END)
  RETURNING * INTO v_p;
  INSERT INTO promotion_stats (promotion_id) VALUES (v_p.id);

  PERFORM record_revenue(
    p_source => 'promotion', p_user_id => v_uid, p_reference_id => v_p.id,
    p_gross_amount => v_pkg.price_usd, p_revenue_amount => v_pkg.price_usd, p_currency => 'USD',
    p_payment_method => 'credits', p_original_currency => 'USD', p_original_amount => v_pkg.price_usd,
    p_metadata => jsonb_build_object('package', v_pkg.id));

  IF v_pkg.kind = 'ad' THEN
    INSERT INTO notifications (user_id, type, title, body, reference_id)
      SELECT a.user_id, 'admin_ad_review', 'Ad waiting for review', v_pkg.name || ': ' || p_headline, v_p.id FROM app_admins a;
  END IF;
  RETURN v_p;
END;
$$;
GRANT EXECUTE ON FUNCTION public.buy_promotion(text, text, uuid, text, text, text, text) TO authenticated;

INSERT INTO public.revenue_sources (source, fee_type, category, enabled, description)
VALUES ('promotion', 'fixed', 'advertising', true, 'Post boosts and sponsored ads (ad_packages), paid in credits')
ON CONFLICT (source) DO NOTHING;

-- Admin review of ads. Approval starts the clock; rejection refunds credits.
CREATE OR REPLACE FUNCTION public.review_promotion(p_promotion_id uuid, p_approve boolean, p_note text)
RETURNS promotions LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_p promotions%ROWTYPE;
BEGIN
  IF NOT is_app_admin() THEN RAISE EXCEPTION 'Admins only'; END IF;
  SELECT * INTO v_p FROM promotions WHERE id = p_promotion_id FOR UPDATE;
  IF NOT FOUND OR v_p.status <> 'pending_review' THEN RAISE EXCEPTION 'Not waiting for review'; END IF;
  IF p_approve THEN
    UPDATE promotions SET status = 'active', starts_at = now(),
      ends_at = now() + make_interval(hours => (package_snapshot ->> 'duration_hours')::int),
      review_note = p_note, reviewed_by = auth.uid()
      WHERE id = v_p.id RETURNING * INTO v_p;
    PERFORM market_notify(v_p.user_id, 'promotion_live', 'Your ad is live', COALESCE(v_p.headline, 'Your ad') || ' is now showing.', v_p.id);
  ELSE
    UPDATE promotions SET status = 'rejected', review_note = p_note, reviewed_by = auth.uid()
      WHERE id = v_p.id RETURNING * INTO v_p;
    PERFORM promotion_credit_refund(v_p.id, 'rejected');
    PERFORM market_notify(v_p.user_id, 'promotion_rejected', 'Ad not approved',
      COALESCE(p_note, 'Your ad was not approved.') || ' Your credits have been refunded.', v_p.id);
  END IF;
  RETURN v_p;
END;
$$;
GRANT EXECUTE ON FUNCTION public.review_promotion(uuid, boolean, text) TO authenticated;

-- Admin takedown of a live promotion that breaks the rules (no refund).
CREATE OR REPLACE FUNCTION public.remove_promotion(p_promotion_id uuid, p_note text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT is_app_admin() THEN RAISE EXCEPTION 'Admins only'; END IF;
  UPDATE promotions SET status = 'removed', review_note = p_note, reviewed_by = auth.uid(), ends_at = LEAST(ends_at, now())
    WHERE id = p_promotion_id AND status = 'active';
END;
$$;
GRANT EXECUTE ON FUNCTION public.remove_promotion(uuid, text) TO authenticated;

-- Owner stops their own promotion early (no refund for unused time).
CREATE OR REPLACE FUNCTION public.stop_promotion(p_promotion_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE promotions SET status = 'stopped', ends_at = LEAST(COALESCE(ends_at, now()), now())
    WHERE id = p_promotion_id AND user_id = auth.uid() AND status = 'active';
  -- An ad still waiting for review can be withdrawn for a full refund.
  IF NOT FOUND THEN
    UPDATE promotions SET status = 'stopped' WHERE id = p_promotion_id AND user_id = auth.uid() AND status = 'pending_review';
    IF FOUND THEN PERFORM promotion_credit_refund(p_promotion_id, 'withdrawn before review'); END IF;
  END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION public.stop_promotion(uuid) TO authenticated;

-- Live promotions for a placement, weighted by priority, never the viewer's own.
CREATE OR REPLACE FUNCTION public.get_sponsored(p_placement text, p_limit integer DEFAULT 2)
RETURNS TABLE (promotion_id uuid, kind text, item_type text, item_id uuid, headline text, body text, media_url text, link_url text)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.id, p.kind, p.item_type, p.item_id, p.headline, p.body, p.media_url, p.link_url
  FROM promotions p
  WHERE p.status = 'active' AND p.starts_at <= now() AND p.ends_at > now()
    AND p_placement = ANY (ARRAY(SELECT jsonb_array_elements_text(p.package_snapshot -> 'placements')))
    AND p.user_id IS DISTINCT FROM auth.uid()
  ORDER BY -ln(greatest(random(), 1e-9)) / (p.package_snapshot ->> 'priority')::numeric
  LIMIT LEAST(GREATEST(p_limit, 1), 5);
$$;
GRANT EXECUTE ON FUNCTION public.get_sponsored(text, integer) TO anon, authenticated;

-- One impression / click per viewer per promotion per day; owners' own views don't count.
CREATE OR REPLACE FUNCTION public.record_promotion_event(p_promotion_id uuid, p_kind text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR p_kind NOT IN ('impression', 'click') THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM promotions WHERE id = p_promotion_id AND status = 'active'
                 AND user_id IS DISTINCT FROM v_uid AND now() BETWEEN starts_at AND ends_at) THEN
    RETURN;
  END IF;
  INSERT INTO promotion_events (promotion_id, viewer_id, kind) VALUES (p_promotion_id, v_uid, p_kind)
    ON CONFLICT DO NOTHING;
  IF FOUND THEN
    UPDATE promotion_stats SET
      impressions = impressions + CASE WHEN p_kind = 'impression' THEN 1 ELSE 0 END,
      clicks = clicks + CASE WHEN p_kind = 'click' THEN 1 ELSE 0 END
    WHERE promotion_id = p_promotion_id;
  END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION public.record_promotion_event(uuid, text) TO authenticated;

COMMIT;
