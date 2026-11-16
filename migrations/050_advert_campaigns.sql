-- Advert campaigns: the standard three-tier ad structure used by Meta Ads
-- Manager and Google Ads.
--
--   ad_campaigns  -> WHY you are advertising (objective, overall budget, flight)
--     ad_sets     -> WHO sees it and HOW it is delivered/bid (targeting, budget,
--                    optimization goal, billing event, placements, schedule)
--       ads       -> WHAT they see (creative: media, copy, CTA, destination)
--
-- Meta calls the middle tier an "ad set", Google an "ad group"; the shape is
-- identical and one guided-creation pass through the wizard produces exactly
-- one of each, which is how Meta's own guided flow behaves.
--
-- Locations are a child table rather than a text column so geo targeting is
-- queryable by an ad server ("which campaigns target this user's country?")
-- and so include/exclude sets and radius targeting are representable at all.
-- The previous UI collected a single free-text "Country, state, city, or
-- radius" string, which no delivery engine could ever act on.
--
-- Nothing here serves ads. This migration is the setup/eligibility side: it
-- stores what an advertiser configured and what has been spent. The ad server
-- that reads ad_sets + ad_set_locations to pick a winning ad, and the job that
-- writes ad_delivery_stats and draws down budget, are separate work.

-- ── 1. ad_campaigns ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ad_campaigns (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  name          text NOT NULL,
  objective     text NOT NULL CHECK (objective = ANY (ARRAY[
                  'awareness', 'traffic', 'engagement', 'leads', 'app_installs', 'sales'
                ])),
  -- Meta's buying_type. 'auction' is the only one this platform supports;
  -- the column exists so reserved/fixed-price buys can be added without a
  -- table rewrite.
  buying_type   text NOT NULL DEFAULT 'auction' CHECK (buying_type = 'auction'),
  status        text NOT NULL DEFAULT 'draft' CHECK (status = ANY (ARRAY[
                  'draft', 'pending_review', 'rejected', 'scheduled',
                  'active', 'paused', 'completed', 'archived'
                ])),

  -- Campaign Budget Optimization: when budget_level = 'campaign' the budget
  -- lives here and is spread across ad sets; when 'ad_set' the columns below
  -- are null and each ad set carries its own.
  budget_level    text NOT NULL DEFAULT 'campaign' CHECK (budget_level = ANY (ARRAY['campaign', 'ad_set'])),
  budget_type     text CHECK (budget_type = ANY (ARRAY['daily', 'lifetime'])),
  daily_budget    numeric(12,2) CHECK (daily_budget IS NULL OR daily_budget > 0),
  lifetime_budget numeric(12,2) CHECK (lifetime_budget IS NULL OR lifetime_budget > 0),
  -- Hard ceiling on total spend for the campaign, independent of budget_type.
  spend_cap       numeric(12,2) CHECK (spend_cap IS NULL OR spend_cap > 0),
  currency_code   character(3) NOT NULL DEFAULT 'USD' CHECK (currency_code = 'USD'),

  start_at      timestamptz,
  end_at        timestamptz,

  -- Running totals maintained by the (future) delivery/billing job.
  amount_spent  numeric(12,2) NOT NULL DEFAULT 0 CHECK (amount_spent >= 0),

  submitted_at  timestamptz,
  reviewed_at   timestamptz,
  review_notes  text,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- A budget-carrying campaign must say which kind of budget it is, and a
  -- lifetime budget is meaningless without an end date to spread it over.
  -- Drafts are exempt: a half-filled campaign is exactly what a draft is for.
  -- Every completeness constraint in this migration carries the same escape.
  CONSTRAINT ad_campaign_budget_shape CHECK (
    status = 'draft'
    OR budget_level <> 'campaign'
    OR (budget_type = 'daily'    AND daily_budget IS NOT NULL)
    OR (budget_type = 'lifetime' AND lifetime_budget IS NOT NULL AND end_at IS NOT NULL)
  ),
  CONSTRAINT ad_campaign_flight CHECK (end_at IS NULL OR start_at IS NULL OR end_at > start_at)
);

CREATE INDEX IF NOT EXISTS ad_campaigns_user_idx ON public.ad_campaigns (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ad_campaigns_status_idx ON public.ad_campaigns (status) WHERE status IN ('active', 'scheduled');

-- ── 2. ad_sets ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ad_sets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES public.ad_campaigns(id) ON DELETE CASCADE,
  name        text NOT NULL,

  -- What the delivery system should maximise, and what the advertiser is
  -- actually charged for. Keeping these separate is the distinction Meta
  -- draws between optimization_goal and billing_event: you can optimise for
  -- link clicks while still being billed per impression.
  optimization_goal text NOT NULL CHECK (optimization_goal = ANY (ARRAY[
                      'reach', 'impressions', 'link_clicks', 'landing_page_views',
                      'post_engagement', 'video_views', 'leads', 'app_installs',
                      'conversions', 'value'
                    ])),
  billing_event     text NOT NULL CHECK (billing_event = ANY (ARRAY[
                      'impressions', 'link_clicks', 'video_views'
                    ])),

  -- 'lowest_cost' is Meta's "Highest volume" (no bid input). The other three
  -- require bid_amount, enforced by ad_set_bid_shape below.
  bid_strategy text NOT NULL DEFAULT 'lowest_cost' CHECK (bid_strategy = ANY (ARRAY[
                 'lowest_cost', 'cost_cap', 'bid_cap', 'roas_goal'
               ])),
  bid_amount   numeric(12,4) CHECK (bid_amount IS NULL OR bid_amount > 0),

  budget_type     text CHECK (budget_type = ANY (ARRAY['daily', 'lifetime'])),
  daily_budget    numeric(12,2) CHECK (daily_budget IS NULL OR daily_budget > 0),
  lifetime_budget numeric(12,2) CHECK (lifetime_budget IS NULL OR lifetime_budget > 0),

  -- 'standard' spreads spend evenly across the flight; 'accelerated' spends as
  -- fast as the auction allows.
  pacing text NOT NULL DEFAULT 'standard' CHECK (pacing = ANY (ARRAY['standard', 'accelerated'])),

  start_at timestamptz,
  end_at   timestamptz,

  placement_mode text NOT NULL DEFAULT 'automatic' CHECK (placement_mode = ANY (ARRAY['automatic', 'manual'])),
  -- Real in-app surfaces, not generic ad-network names. Validated in the app
  -- layer (src/config/adTargeting.js) rather than by a CHECK so a new surface
  -- does not require a migration to launch on.
  placements text[] NOT NULL DEFAULT '{}',

  -- Frequency capping: at most N impressions per M days per person.
  frequency_cap_impressions integer CHECK (frequency_cap_impressions IS NULL OR frequency_cap_impressions > 0),
  frequency_cap_days        integer CHECK (frequency_cap_days IS NULL OR frequency_cap_days BETWEEN 1 AND 90),

  -- Dayparting. 'always' ignores `schedule`; 'scheduled' reads it as
  -- [{ "day": 0-6, "start_hour": 0-23, "end_hour": 1-24 }, ...] in the
  -- advertiser's local timezone (schedule_timezone).
  schedule_mode     text NOT NULL DEFAULT 'always' CHECK (schedule_mode = ANY (ARRAY['always', 'scheduled'])),
  schedule          jsonb NOT NULL DEFAULT '[]'::jsonb,
  schedule_timezone text,

  -- ── Demographics ──
  -- 13 is the platform's own minimum age; 65 is stored as "65 or older".
  age_min   smallint NOT NULL DEFAULT 18 CHECK (age_min BETWEEN 13 AND 65),
  age_max   smallint NOT NULL DEFAULT 65 CHECK (age_max BETWEEN 13 AND 65),
  genders   text[] NOT NULL DEFAULT '{all}',
  languages text[] NOT NULL DEFAULT '{}',

  -- ── Audience ──
  interests          text[] NOT NULL DEFAULT '{}',
  behaviors          text[] NOT NULL DEFAULT '{}',
  excluded_interests text[] NOT NULL DEFAULT '{}',
  -- Meta's "Connections" targeting, expressed against this app's follow graph.
  connection_targeting text NOT NULL DEFAULT 'all' CHECK (connection_targeting = ANY (ARRAY[
                         'all', 'followers', 'exclude_followers', 'follower_lookalike'
                       ])),

  status     text NOT NULL DEFAULT 'draft' CHECK (status = ANY (ARRAY[
               'draft', 'pending_review', 'rejected', 'scheduled',
               'active', 'paused', 'completed', 'archived'
             ])),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- Coherence constraints: wrong at any status, so no draft exemption.
  CONSTRAINT ad_set_age_range CHECK (age_max >= age_min),
  CONSTRAINT ad_set_flight CHECK (end_at IS NULL OR start_at IS NULL OR end_at > start_at),
  -- Completeness constraints: exempt for drafts.
  CONSTRAINT ad_set_bid_shape CHECK (status = 'draft' OR bid_strategy = 'lowest_cost' OR bid_amount IS NOT NULL),
  -- A manual placement selection that selected nothing would silently deliver
  -- nowhere.
  CONSTRAINT ad_set_manual_placements CHECK (
    status = 'draft' OR placement_mode <> 'manual' OR array_length(placements, 1) > 0
  ),
  -- Both halves of a frequency cap or neither: "3 times per null days" is not
  -- an incomplete cap, it is a meaningless one. buildPayload() in
  -- src/services/adCampaignService.js drops a half-filled pair to null/null so
  -- this never fires from the wizard.
  CONSTRAINT ad_set_frequency_cap_shape CHECK (
    (frequency_cap_impressions IS NULL) = (frequency_cap_days IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS ad_sets_campaign_idx ON public.ad_sets (campaign_id);
CREATE INDEX IF NOT EXISTS ad_sets_placements_idx ON public.ad_sets USING gin (placements);
CREATE INDEX IF NOT EXISTS ad_sets_interests_idx ON public.ad_sets USING gin (interests);

-- ── 3. ad_set_locations ─────────────────────────────────────────────────────
-- One row per targeted place. 'radius' rows carry a centre point and a radius
-- in kilometres; everything else is matched on the named administrative unit.
CREATE TABLE IF NOT EXISTS public.ad_set_locations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ad_set_id     uuid NOT NULL REFERENCES public.ad_sets(id) ON DELETE CASCADE,
  mode          text NOT NULL DEFAULT 'include' CHECK (mode = ANY (ARRAY['include', 'exclude'])),
  location_type text NOT NULL CHECK (location_type = ANY (ARRAY['country', 'region', 'city', 'radius'])),
  name          text NOT NULL,
  country_code  character(2),
  region        text,
  city          text,
  latitude      numeric(9,6)  CHECK (latitude  IS NULL OR latitude  BETWEEN -90 AND 90),
  longitude     numeric(9,6)  CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
  radius_km     numeric(7,2)  CHECK (radius_km IS NULL OR radius_km BETWEEN 1 AND 800),
  created_at    timestamptz NOT NULL DEFAULT now(),

  -- A radius pin without a centre point, or a centre point without a radius,
  -- is not targetable.
  CONSTRAINT ad_location_radius_shape CHECK (
    location_type <> 'radius'
    OR (latitude IS NOT NULL AND longitude IS NOT NULL AND radius_km IS NOT NULL)
  ),
  CONSTRAINT ad_location_country_required CHECK (location_type = 'radius' OR country_code IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS ad_set_locations_ad_set_idx ON public.ad_set_locations (ad_set_id);
CREATE INDEX IF NOT EXISTS ad_set_locations_country_idx ON public.ad_set_locations (country_code, mode);

-- ── 4. ads (creatives) ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ads (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ad_set_id uuid NOT NULL REFERENCES public.ad_sets(id) ON DELETE CASCADE,
  name      text NOT NULL,

  format      text NOT NULL CHECK (format = ANY (ARRAY['image', 'video', 'carousel', 'slideshow', 'collection'])),
  orientation text NOT NULL DEFAULT 'square' CHECK (orientation = ANY (ARRAY['landscape', 'square', 'vertical'])),

  headline     text NOT NULL,
  primary_text text NOT NULL,
  description  text,
  cta_type     text NOT NULL,
  -- Where the CTA sends people. Required for every objective except pure
  -- awareness/engagement plays, enforced in submit_ad_campaign().
  destination_url text,
  display_link    text,

  media_url     text,
  media_type    text CHECK (media_type IS NULL OR media_type = ANY (ARRAY['image', 'video'])),
  -- Carousel/collection cards: [{ "media_url", "headline", "description", "destination_url" }]
  carousel_cards jsonb NOT NULL DEFAULT '[]'::jsonb,

  status     text NOT NULL DEFAULT 'draft' CHECK (status = ANY (ARRAY[
               'draft', 'pending_review', 'rejected', 'active', 'paused', 'archived'
             ])),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- Single-media formats need media_url; multi-card formats need cards.
  -- Drafts are exempt so a creative can be written before the art arrives.
  CONSTRAINT ad_creative_media_shape CHECK (
    status = 'draft'
    OR (format IN ('image', 'video') AND media_url IS NOT NULL)
    OR (format IN ('carousel', 'slideshow', 'collection') AND jsonb_array_length(carousel_cards) >= 2)
  )
);

CREATE INDEX IF NOT EXISTS ads_ad_set_idx ON public.ads (ad_set_id);

-- ── 5. ad_delivery_stats ────────────────────────────────────────────────────
-- Daily rollup written by the delivery job. The wizard reads nothing from
-- here; it exists so the metrics the wizard promises have somewhere to land.
CREATE TABLE IF NOT EXISTS public.ad_delivery_stats (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ad_id       uuid NOT NULL REFERENCES public.ads(id) ON DELETE CASCADE,
  stat_date   date NOT NULL,
  impressions bigint NOT NULL DEFAULT 0 CHECK (impressions >= 0),
  reach       bigint NOT NULL DEFAULT 0 CHECK (reach >= 0),
  clicks      bigint NOT NULL DEFAULT 0 CHECK (clicks >= 0),
  video_views bigint NOT NULL DEFAULT 0 CHECK (video_views >= 0),
  conversions bigint NOT NULL DEFAULT 0 CHECK (conversions >= 0),
  spend       numeric(12,2) NOT NULL DEFAULT 0 CHECK (spend >= 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ad_delivery_stats_unique_day UNIQUE (ad_id, stat_date),
  -- Reach counts people, impressions count deliveries; reach can never exceed it.
  CONSTRAINT ad_delivery_reach_lte_impressions CHECK (reach <= impressions)
);

CREATE INDEX IF NOT EXISTS ad_delivery_stats_ad_date_idx ON public.ad_delivery_stats (ad_id, stat_date DESC);

-- ── 6. wallet_transactions type whitelist ───────────────────────────────────
-- Every new wallet_transactions.type string must be added to this CHECK in the
-- same migration that introduces it, or the insert fails at runtime.
ALTER TABLE wallet_transactions DROP CONSTRAINT IF EXISTS wallet_transactions_type_check;
ALTER TABLE wallet_transactions ADD CONSTRAINT wallet_transactions_type_check
  CHECK (type = ANY (ARRAY[
    'deposit'::text, 'cashout'::text, 'cashout_cancelled'::text,
    'token_purchase'::text, 'token_spend'::text, 'token_reward'::text,
    'transfer_in'::text, 'transfer_out'::text, 'transfer_fee'::text,
    'voucher_spend'::text, 'app_purchase'::text,
    'marketplace_listing_fee'::text, 'marketplace_featured_fee'::text,
    'marketplace_purchase'::text, 'marketplace_sale'::text,
    'marketplace_royalty'::text, 'currency_conversion'::text,
    'leadership_game_join_fee'::text, 'leadership_game_prize'::text,
    'ad_campaign_charge'::text, 'ad_campaign_refund'::text
  ]));

-- ── 7. RLS ──────────────────────────────────────────────────────────────────
-- Advertisers see and edit only their own campaigns and everything under them.
-- Writes all go through submit_ad_campaign(); the INSERT policies exist so the
-- owner check is enforced at the table level too rather than only in the RPC.
ALTER TABLE public.ad_campaigns     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ad_sets          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ad_set_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ads              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ad_delivery_stats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ad_campaigns_owner_select ON public.ad_campaigns;
CREATE POLICY ad_campaigns_owner_select ON public.ad_campaigns
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS ad_campaigns_owner_insert ON public.ad_campaigns;
CREATE POLICY ad_campaigns_owner_insert ON public.ad_campaigns
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Owners may edit a campaign only while it has not been handed to review, and
-- may pause/archive a live one -- they can never move it to 'active' or
-- 'scheduled' themselves, since that is the reviewer's decision.
DROP POLICY IF EXISTS ad_campaigns_owner_update ON public.ad_campaigns;
CREATE POLICY ad_campaigns_owner_update ON public.ad_campaigns
  FOR UPDATE USING (auth.uid() = user_id)
  WITH CHECK (status = ANY (ARRAY['draft', 'pending_review', 'paused', 'archived']));

DROP POLICY IF EXISTS ad_sets_owner_all ON public.ad_sets;
CREATE POLICY ad_sets_owner_all ON public.ad_sets
  FOR ALL USING (
    campaign_id IN (SELECT id FROM public.ad_campaigns WHERE user_id = auth.uid())
  ) WITH CHECK (
    campaign_id IN (SELECT id FROM public.ad_campaigns WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS ad_set_locations_owner_all ON public.ad_set_locations;
CREATE POLICY ad_set_locations_owner_all ON public.ad_set_locations
  FOR ALL USING (
    ad_set_id IN (
      SELECT s.id FROM public.ad_sets s
      JOIN public.ad_campaigns c ON c.id = s.campaign_id
      WHERE c.user_id = auth.uid()
    )
  ) WITH CHECK (
    ad_set_id IN (
      SELECT s.id FROM public.ad_sets s
      JOIN public.ad_campaigns c ON c.id = s.campaign_id
      WHERE c.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS ads_owner_all ON public.ads;
CREATE POLICY ads_owner_all ON public.ads
  FOR ALL USING (
    ad_set_id IN (
      SELECT s.id FROM public.ad_sets s
      JOIN public.ad_campaigns c ON c.id = s.campaign_id
      WHERE c.user_id = auth.uid()
    )
  ) WITH CHECK (
    ad_set_id IN (
      SELECT s.id FROM public.ad_sets s
      JOIN public.ad_campaigns c ON c.id = s.campaign_id
      WHERE c.user_id = auth.uid()
    )
  );

-- Read-only for advertisers: stats are written by the delivery job with the
-- service role, which bypasses RLS.
DROP POLICY IF EXISTS ad_delivery_stats_owner_select ON public.ad_delivery_stats;
CREATE POLICY ad_delivery_stats_owner_select ON public.ad_delivery_stats
  FOR SELECT USING (
    ad_id IN (
      SELECT a.id FROM public.ads a
      JOIN public.ad_sets s ON s.id = a.ad_set_id
      JOIN public.ad_campaigns c ON c.id = s.campaign_id
      WHERE c.user_id = auth.uid()
    )
  );

REVOKE ALL ON public.ad_campaigns, public.ad_sets, public.ad_set_locations, public.ads, public.ad_delivery_stats FROM anon;
GRANT SELECT, INSERT, UPDATE ON public.ad_campaigns, public.ad_sets, public.ad_set_locations, public.ads TO authenticated;
GRANT SELECT ON public.ad_delivery_stats TO authenticated;

-- ── 8. submit_ad_campaign ───────────────────────────────────────────────────
-- Creates campaign + ad set + ad + locations in one transaction. Called with
-- p_status 'draft' to save without submitting, or 'pending_review' to submit.
--
-- Deliberately does NOT charge the wallet. Billing starts only after a
-- reviewer approves the campaign, which is what the wizard tells the user; the
-- balance check below is an eligibility gate, not a payment.
CREATE OR REPLACE FUNCTION public.submit_ad_campaign(
  p_payload jsonb,
  p_status  text DEFAULT 'pending_review'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id       uuid := auth.uid();
  v_campaign      jsonb := p_payload->'campaign';
  v_ad_set        jsonb := p_payload->'ad_set';
  v_ad            jsonb := p_payload->'ad';
  v_locations     jsonb := COALESCE(p_payload->'locations', '[]'::jsonb);
  v_location      jsonb;
  v_campaign_id   uuid;
  v_ad_set_id     uuid;
  v_ad_id         uuid;
  v_objective     text;
  v_budget_level  text;
  v_budget_type   text;
  v_first_charge  numeric;
  v_available     numeric;
  v_wallet        numeric;
  v_voucher       numeric;
  v_include_count int;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not signed in');
  END IF;
  IF p_status NOT IN ('draft', 'pending_review') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Campaigns can only be saved as a draft or submitted for review');
  END IF;
  IF v_campaign IS NULL OR v_ad_set IS NULL OR v_ad IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Campaign, ad set and creative are all required');
  END IF;

  v_objective    := v_campaign->>'objective';
  v_budget_level := COALESCE(v_campaign->>'budget_level', 'campaign');
  v_budget_type  := v_campaign->>'budget_type';

  -- A campaign that targets nowhere would never deliver. Drafts are allowed to
  -- be incomplete; a submission is not.
  IF p_status = 'pending_review' THEN
    SELECT count(*) INTO v_include_count
    FROM jsonb_array_elements(v_locations) loc
    WHERE COALESCE(loc->>'mode', 'include') = 'include';
    IF v_include_count = 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'Add at least one included location before submitting');
    END IF;

    -- Objectives that send people somewhere need somewhere to send them.
    IF v_objective IN ('traffic', 'leads', 'app_installs', 'sales')
       AND COALESCE(v_ad->>'destination_url', '') = '' THEN
      RETURN jsonb_build_object('success', false, 'error', 'This objective requires a destination URL');
    END IF;

    -- Eligibility gate: the advertiser must be able to fund at least the first
    -- day (or, for a lifetime budget, the whole flight) once approved.
    v_first_charge := COALESCE(
      (v_campaign->>'daily_budget')::numeric,
      (v_ad_set->>'daily_budget')::numeric,
      (v_campaign->>'lifetime_budget')::numeric,
      (v_ad_set->>'lifetime_budget')::numeric,
      0
    );
    IF v_first_charge <= 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'Set a budget before submitting');
    END IF;

    SELECT COALESCE(w.wallet_balance, 0) INTO v_wallet FROM wallets w WHERE w.user_id = v_user_id;
    v_voucher := get_spend_voucher_balance();
    v_available := COALESCE(v_wallet, 0) + COALESCE(v_voucher, 0);
    IF v_available < v_first_charge THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', format('Available balance $%s cannot cover the first charge of $%s',
                        to_char(v_available, 'FM999999990.00'), to_char(v_first_charge, 'FM999999990.00'))
      );
    END IF;
  END IF;

  INSERT INTO ad_campaigns (
    user_id, name, objective, status, budget_level, budget_type,
    daily_budget, lifetime_budget, spend_cap, start_at, end_at, submitted_at
  ) VALUES (
    v_user_id,
    COALESCE(NULLIF(v_campaign->>'name', ''), 'Untitled campaign'),
    v_objective,
    p_status,
    v_budget_level,
    v_budget_type,
    CASE WHEN v_budget_level = 'campaign' THEN (v_campaign->>'daily_budget')::numeric END,
    CASE WHEN v_budget_level = 'campaign' THEN (v_campaign->>'lifetime_budget')::numeric END,
    (v_campaign->>'spend_cap')::numeric,
    (v_campaign->>'start_at')::timestamptz,
    (v_campaign->>'end_at')::timestamptz,
    CASE WHEN p_status = 'pending_review' THEN now() END
  ) RETURNING id INTO v_campaign_id;

  INSERT INTO ad_sets (
    campaign_id, name, optimization_goal, billing_event, bid_strategy, bid_amount,
    budget_type, daily_budget, lifetime_budget, pacing, start_at, end_at,
    placement_mode, placements, frequency_cap_impressions, frequency_cap_days,
    schedule_mode, schedule, schedule_timezone,
    age_min, age_max, genders, languages,
    interests, behaviors, excluded_interests, connection_targeting, status
  ) VALUES (
    v_campaign_id,
    COALESCE(NULLIF(v_ad_set->>'name', ''), 'Ad set 1'),
    v_ad_set->>'optimization_goal',
    v_ad_set->>'billing_event',
    COALESCE(v_ad_set->>'bid_strategy', 'lowest_cost'),
    (v_ad_set->>'bid_amount')::numeric,
    CASE WHEN v_budget_level = 'ad_set' THEN v_ad_set->>'budget_type' END,
    CASE WHEN v_budget_level = 'ad_set' THEN (v_ad_set->>'daily_budget')::numeric END,
    CASE WHEN v_budget_level = 'ad_set' THEN (v_ad_set->>'lifetime_budget')::numeric END,
    COALESCE(v_ad_set->>'pacing', 'standard'),
    (v_ad_set->>'start_at')::timestamptz,
    (v_ad_set->>'end_at')::timestamptz,
    COALESCE(v_ad_set->>'placement_mode', 'automatic'),
    COALESCE(ARRAY(SELECT jsonb_array_elements_text(v_ad_set->'placements')), '{}'),
    (v_ad_set->>'frequency_cap_impressions')::int,
    (v_ad_set->>'frequency_cap_days')::int,
    COALESCE(v_ad_set->>'schedule_mode', 'always'),
    COALESCE(v_ad_set->'schedule', '[]'::jsonb),
    v_ad_set->>'schedule_timezone',
    COALESCE((v_ad_set->>'age_min')::smallint, 18),
    COALESCE((v_ad_set->>'age_max')::smallint, 65),
    COALESCE(ARRAY(SELECT jsonb_array_elements_text(v_ad_set->'genders')), '{all}'),
    COALESCE(ARRAY(SELECT jsonb_array_elements_text(v_ad_set->'languages')), '{}'),
    COALESCE(ARRAY(SELECT jsonb_array_elements_text(v_ad_set->'interests')), '{}'),
    COALESCE(ARRAY(SELECT jsonb_array_elements_text(v_ad_set->'behaviors')), '{}'),
    COALESCE(ARRAY(SELECT jsonb_array_elements_text(v_ad_set->'excluded_interests')), '{}'),
    COALESCE(v_ad_set->>'connection_targeting', 'all'),
    p_status
  ) RETURNING id INTO v_ad_set_id;

  FOR v_location IN SELECT * FROM jsonb_array_elements(v_locations) LOOP
    INSERT INTO ad_set_locations (
      ad_set_id, mode, location_type, name, country_code, region, city,
      latitude, longitude, radius_km
    ) VALUES (
      v_ad_set_id,
      COALESCE(v_location->>'mode', 'include'),
      v_location->>'location_type',
      v_location->>'name',
      NULLIF(v_location->>'country_code', ''),
      NULLIF(v_location->>'region', ''),
      NULLIF(v_location->>'city', ''),
      (v_location->>'latitude')::numeric,
      (v_location->>'longitude')::numeric,
      (v_location->>'radius_km')::numeric
    );
  END LOOP;

  INSERT INTO ads (
    ad_set_id, name, format, orientation, headline, primary_text, description,
    cta_type, destination_url, display_link, media_url, media_type,
    carousel_cards, status
  ) VALUES (
    v_ad_set_id,
    COALESCE(NULLIF(v_ad->>'name', ''), 'Ad 1'),
    v_ad->>'format',
    COALESCE(v_ad->>'orientation', 'square'),
    COALESCE(v_ad->>'headline', ''),
    COALESCE(v_ad->>'primary_text', ''),
    NULLIF(v_ad->>'description', ''),
    v_ad->>'cta_type',
    NULLIF(v_ad->>'destination_url', ''),
    NULLIF(v_ad->>'display_link', ''),
    NULLIF(v_ad->>'media_url', ''),
    NULLIF(v_ad->>'media_type', ''),
    COALESCE(v_ad->'carousel_cards', '[]'::jsonb),
    p_status
  ) RETURNING id INTO v_ad_id;

  RETURN jsonb_build_object(
    'success', true,
    'campaign_id', v_campaign_id,
    'ad_set_id', v_ad_set_id,
    'ad_id', v_ad_id,
    'status', p_status
  );
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION public.submit_ad_campaign(jsonb, text) TO authenticated;

-- ── 9. get_ad_audience_size ─────────────────────────────────────────────────
-- The real, countable size of the platform's addressable audience. This app
-- does not collect age, gender or location on profiles, so there is nothing to
-- narrow the count BY -- the wizard shows this as the total pool and is
-- explicit that targeting narrows delivery rather than showing an invented
-- "estimated audience" number the data cannot support.
CREATE OR REPLACE FUNCTION public.get_ad_audience_size()
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT count(*)::bigint FROM profiles;
$$;

GRANT EXECUTE ON FUNCTION public.get_ad_audience_size() TO authenticated;
