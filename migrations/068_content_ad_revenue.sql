-- 068: Ads inside authors' content, and authors' share of the revenue.
--
-- Ads now also show *inside* content while people engage with it (between
-- story chapters, between book pages, under memes/puzzles/kids items, below
-- music/podcast/TV players), as placement 'content'. Each ad view inside a
-- piece of content is attributed to that content's owner: the current owner if
-- it changed hands on the marketplace, otherwise its author (ads_post_owner).
-- Views by the owner themselves never count.
--
-- Where the money comes from, per view:
--   * Google AdMob ads: the value Google reports for that view (paid event).
--     If impression-level revenue isn't switched on in AdMob, the admin enters
--     the month's AdMob content revenue at settlement and it's split by views.
--   * Book of Memes paid ads (advertisers' campaigns): the campaign's price
--     divided by all of that campaign's views.
--   * Book of Memes house ads: nothing (the platform's own promotion).
-- Once a month an admin settles the previous month: each owner gets
-- author_share_pct (default 50%) of the revenue their content earned, as
-- marketplace earnings (kind 'ad_revenue'), withdrawable like sale earnings
-- after the usual clearing period. Authors see it all on their Ad earnings screen.
BEGIN;

CREATE TABLE IF NOT EXISTS public.content_ad_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  author_share_pct numeric NOT NULL DEFAULT 50 CHECK (author_share_pct BETWEEN 0 AND 100),
  min_payout_usd numeric NOT NULL DEFAULT 0.01 CHECK (min_payout_usd >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.content_ad_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- One row per counted ad view inside content (and one per AdMob paid event).
CREATE TABLE IF NOT EXISTS public.content_ad_impressions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_type text NOT NULL,
  item_id uuid NOT NULL,
  owner_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  source text NOT NULL CHECK (source IN ('admob', 'admob_paid', 'campaign', 'house')),
  ad_ref text NOT NULL,                 -- campaign id, house ad id, or AdMob ad unit
  viewer_key text NOT NULL,
  hour_bucket timestamptz NOT NULL,
  value_usd numeric CHECK (value_usd IS NULL OR value_usd >= 0), -- AdMob paid events only
  precision text,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- A view counts once per viewer, item and ad per hour (paid events are each real money, so not deduped).
CREATE UNIQUE INDEX IF NOT EXISTS content_ad_impressions_once ON public.content_ad_impressions
  (item_type, item_id, source, ad_ref, viewer_key, hour_bucket) WHERE source <> 'admob_paid';
CREATE INDEX IF NOT EXISTS content_ad_impressions_owner ON public.content_ad_impressions (owner_id, created_at);
CREATE INDEX IF NOT EXISTS content_ad_impressions_month ON public.content_ad_impressions (created_at, source);

CREATE TABLE IF NOT EXISTS public.content_ad_months (
  month date PRIMARY KEY CHECK (extract(day FROM month) = 1),
  admob_manual_usd numeric,                -- entered by the admin when AdMob paid events aren't available
  revenue_usd numeric NOT NULL,            -- all content-ad revenue for the month
  authors_usd numeric NOT NULL,            -- paid out to owners
  share_pct numeric NOT NULL,
  settled_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  settled_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.content_ad_payouts (
  month date NOT NULL REFERENCES public.content_ad_months(month) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  impressions integer NOT NULL,
  revenue_usd numeric NOT NULL,            -- what their content earned
  earnings_usd numeric NOT NULL,           -- their share
  breakdown jsonb NOT NULL DEFAULT '{}'::jsonb, -- per item type
  earning_id uuid,
  PRIMARY KEY (month, owner_id)
);

ALTER TABLE public.content_ad_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_ad_impressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_ad_months ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_ad_payouts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.content_ad_settings, public.content_ad_impressions, public.content_ad_months, public.content_ad_payouts FROM anon, authenticated;
GRANT ALL ON public.content_ad_settings, public.content_ad_impressions, public.content_ad_months, public.content_ad_payouts TO service_role;

-- Ad earnings are a new kind of marketplace earnings.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.market_earnings'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%royalty%' LOOP
    EXECUTE format('ALTER TABLE public.market_earnings DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;
ALTER TABLE public.market_earnings ADD CONSTRAINT market_earnings_kind_check CHECK (kind IN ('sale', 'royalty', 'ad_revenue'));

-- Advertisers' ad packages can now show inside content too.
UPDATE public.advertising_packages SET placements = array_append(placements, 'content'), updated_at = now()
 WHERE kind = 'ad' AND NOT ('content' = ANY (placements));

-- House ads can be placed inside content too.
ALTER TABLE public.house_ads DROP CONSTRAINT IF EXISTS house_ads_placements;
ALTER TABLE public.house_ads ADD CONSTRAINT house_ads_placements CHECK (
  cardinality(placements) >= 1 AND placements <@ ARRAY['home', 'explore', 'feed', 'search', 'content']::text[]);

-- ── Record one ad view inside content ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.content_ads_record(
  p_item_type text, p_item_id uuid, p_source text, p_ad_ref text, p_viewer_key text,
  p_viewer_id uuid DEFAULT NULL, p_value_usd numeric DEFAULT NULL, p_precision text DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid;
  v_inserted integer;
BEGIN
  IF p_source NOT IN ('admob', 'admob_paid', 'campaign', 'house')
     OR COALESCE(char_length(p_viewer_key), 0) NOT BETWEEN 8 AND 128
     OR p_ad_ref IS NULL OR (p_value_usd IS NOT NULL AND (p_value_usd < 0 OR p_value_usd > 50)) THEN
    RETURN false;
  END IF;
  v_owner := ads_post_owner(p_item_type, p_item_id);
  IF v_owner IS NULL THEN RETURN false; END IF;               -- unknown item
  IF p_viewer_id IS NOT NULL AND p_viewer_id = v_owner THEN RETURN false; END IF; -- own views don't count
  INSERT INTO content_ad_impressions (item_type, item_id, owner_id, source, ad_ref, viewer_key, hour_bucket, value_usd, precision)
  VALUES (p_item_type, p_item_id, v_owner, p_source, left(p_ad_ref, 100), left(p_viewer_key, 128), date_trunc('hour', now()),
          CASE WHEN p_source = 'admob_paid' THEN p_value_usd END, left(p_precision, 20))
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted > 0;
END;
$$;
REVOKE ALL ON FUNCTION public.content_ads_record(text, uuid, text, text, text, uuid, numeric, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.content_ads_record(text, uuid, text, text, text, uuid, numeric, text) TO service_role;

-- ── What each owner's content earned in a month (estimate until settled) ─────
-- p_admob_manual_usd: the month's AdMob content revenue, only when AdMob paid
-- events aren't available; it's split by AdMob views.
CREATE OR REPLACE FUNCTION public.content_ads_month_report(p_month date, p_admob_manual_usd numeric DEFAULT NULL)
RETURNS TABLE (owner_id uuid, item_type text, item_id uuid, impressions bigint, revenue_usd numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH win AS (SELECT p_month::timestamptz AS a, (p_month + interval '1 month')::timestamptz AS b),
  imp AS (
    SELECT i.* FROM content_ad_impressions i, win WHERE i.created_at >= win.a AND i.created_at < win.b AND i.owner_id IS NOT NULL
  ),
  -- Paid campaigns: price / every view the campaign got (all placements, all time).
  camp_rate AS (
    SELECT c.id::text AS ref, COALESCE(e.price_usd, 0) / NULLIF((SELECT count(*) FROM advertising_events ev WHERE ev.campaign_id = c.id AND ev.kind = 'impression'), 0) AS rate
      FROM advertising_campaigns c JOIN advertising_entitlements e ON e.id = c.entitlement_id
     WHERE e.is_paid AND c.id::text IN (SELECT ad_ref FROM imp WHERE source = 'campaign')
  ),
  admob_views AS (SELECT count(*) AS n FROM imp WHERE source = 'admob'),
  admob_paid_total AS (SELECT COALESCE(sum(value_usd), 0) AS v FROM imp WHERE source = 'admob_paid'),
  valued AS (
    SELECT imp.owner_id, imp.item_type, imp.item_id,
           CASE WHEN imp.source IN ('admob', 'campaign', 'house') THEN 1 ELSE 0 END AS views,
           CASE
             WHEN imp.source = 'admob_paid' THEN imp.value_usd
             WHEN imp.source = 'campaign' THEN COALESCE((SELECT rate FROM camp_rate WHERE ref = imp.ad_ref), 0)
             WHEN imp.source = 'admob' AND p_admob_manual_usd IS NOT NULL AND (SELECT v FROM admob_paid_total) = 0
               THEN p_admob_manual_usd / NULLIF((SELECT n FROM admob_views), 0)
             ELSE 0
           END AS value
      FROM imp
  )
  SELECT owner_id, item_type, item_id, sum(views)::bigint, round(sum(COALESCE(value, 0)), 6)
    FROM valued GROUP BY owner_id, item_type, item_id;
$$;
REVOKE ALL ON FUNCTION public.content_ads_month_report(date, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.content_ads_month_report(date, numeric) TO service_role;

-- ── Settle a finished month: credit every owner's share as earnings ──────────
CREATE OR REPLACE FUNCTION public.content_ads_settle(p_month date, p_admin uuid, p_admob_manual_usd numeric DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cfg content_ad_settings%ROWTYPE;
  ms market_settings%ROWTYPE;
  r record;
  v_total numeric := 0;
  v_authors numeric := 0;
  v_owners integer := 0;
  v_earn uuid;
  v_share numeric;
BEGIN
  IF NOT is_app_admin(p_admin) THEN RAISE EXCEPTION 'admins_only'; END IF;
  IF p_month IS NULL OR extract(day FROM p_month) <> 1 THEN RAISE EXCEPTION 'month_must_be_first_day'; END IF;
  IF p_month + interval '1 month' > date_trunc('month', now()) THEN RAISE EXCEPTION 'month_not_finished'; END IF;
  IF EXISTS (SELECT 1 FROM content_ad_months WHERE month = p_month) THEN RAISE EXCEPTION 'month_already_settled'; END IF;
  SELECT * INTO cfg FROM content_ad_settings WHERE id;
  SELECT * INTO ms FROM market_settings WHERE id;

  INSERT INTO content_ad_months (month, admob_manual_usd, revenue_usd, authors_usd, share_pct, settled_by)
  VALUES (p_month, p_admob_manual_usd, 0, 0, cfg.author_share_pct, p_admin);

  FOR r IN
    SELECT owner_id, sum(impressions)::int AS views, sum(revenue_usd) AS revenue,
           jsonb_object_agg(item_type, jsonb_build_object('views', t_views, 'revenue_usd', t_rev)) AS breakdown
      FROM (SELECT owner_id, item_type, sum(impressions) AS impressions, sum(revenue_usd) AS revenue_usd,
                   sum(impressions) AS t_views, round(sum(revenue_usd), 4) AS t_rev
              FROM content_ads_month_report(p_month, p_admob_manual_usd) GROUP BY owner_id, item_type) per_type
     GROUP BY owner_id
  LOOP
    v_total := v_total + r.revenue;
    v_share := round(r.revenue * cfg.author_share_pct / 100, 2);
    v_earn := NULL;
    IF v_share >= GREATEST(cfg.min_payout_usd, 0.01) THEN
      INSERT INTO market_earnings (user_id, kind, currency, amount, available_at)
      VALUES (r.owner_id, 'ad_revenue', 'USD', v_share, now() + make_interval(days => ms.clearing_days))
      RETURNING id INTO v_earn;
      INSERT INTO market_ledger (user_id, bucket, kind, currency, amount, reference_id, meta)
      VALUES (r.owner_id, 'earnings', 'ad_revenue', 'USD', v_share, v_earn, jsonb_build_object('month', p_month));
      PERFORM market_notify(r.owner_id, 'ad_earnings', 'Ad earnings',
        'Ads shown in your content earned you ' || market_money(v_share, 'USD') || ' for ' || to_char(p_month, 'FMMonth YYYY')
        || '. It can be withdrawn after ' || ms.clearing_days || ' days.', NULL);
      v_authors := v_authors + v_share;
    ELSE
      v_share := 0;
    END IF;
    INSERT INTO content_ad_payouts (month, owner_id, impressions, revenue_usd, earnings_usd, breakdown, earning_id)
    VALUES (p_month, r.owner_id, r.views, round(r.revenue, 4), v_share, r.breakdown, v_earn);
    v_owners := v_owners + 1;
  END LOOP;

  UPDATE content_ad_months SET revenue_usd = round(v_total, 4), authors_usd = v_authors WHERE month = p_month;
  RETURN jsonb_build_object('month', p_month, 'revenue_usd', round(v_total, 4), 'authors_usd', v_authors,
                            'owners', v_owners, 'share_pct', cfg.author_share_pct);
END;
$$;
REVOKE ALL ON FUNCTION public.content_ads_settle(date, uuid, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.content_ads_settle(date, uuid, numeric) TO service_role;

COMMIT;
