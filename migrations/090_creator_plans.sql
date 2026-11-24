-- 090: Bascardo AI Creator plans (Creator Artist $40 … Creator Max $400), next to Pro and Business.
-- Each is a Google Play subscription (bascardo_ai_<plan>_monthly; credits in Backend/config/aiPlans.js).
-- The database only knew 'pro' and 'business': this lets the new plans be recorded, ranks them
-- (a user's plan is their highest valid subscription), and opens Leadership Games to every paid plan.
-- The three functions are the 059/077 versions with only those lines changed. Safe to run more than once.

DO $$
BEGIN
  IF to_regclass('public.play_subscriptions') IS NULL OR to_regprocedure('public.leadership_eligibility(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Wrong Supabase project, or 059/077 is missing: run this in the Book of Memes project (URL starts with zgyphn). Nothing was changed.';
  END IF;
END $$;

ALTER TABLE public.play_subscriptions DROP CONSTRAINT IF EXISTS play_subscriptions_plan_check;
ALTER TABLE public.play_subscriptions ADD CONSTRAINT play_subscriptions_plan_check CHECK (plan IN ('pro', 'business', 'artist', 'director', 'beast', 'genius', 'titan', 'max'));

CREATE OR REPLACE FUNCTION public.get_ai_plan(p_user_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(
    (SELECT jsonb_build_object(
        'plan', s.plan, 'status', s.status, 'provider', 'google_play', 'product_id', s.product_id,
        'current_period_end', s.current_period_end, 'pending_product_id', s.pending_product_id,
        'auto_renewing', s.auto_renewing)
       FROM public.play_subscriptions s
      WHERE s.user_id = p_user_id AND s.replaced_by_reference IS NULL
        AND s.status IN ('active', 'cancelled') AND s.current_period_end > now()
      ORDER BY CASE s.plan WHEN 'max' THEN 8 WHEN 'titan' THEN 7 WHEN 'genius' THEN 6 WHEN 'beast' THEN 5 WHEN 'director' THEN 4 WHEN 'artist' THEN 3 WHEN 'business' THEN 2 ELSE 1 END DESC, s.current_period_end DESC, s.observed_at DESC
      LIMIT 1),
    (SELECT jsonb_build_object(
        'plan', 'pro', 'status', 'cancelled', 'provider', 'credits', 'product_id', NULL,
        'current_period_end', l.expires_at, 'pending_product_id', NULL, 'auto_renewing', false)
       FROM public.subscriptions l
      WHERE l.user_id = p_user_id AND l.status = 'active' AND l.expires_at > now()
      ORDER BY l.expires_at DESC LIMIT 1),
    jsonb_build_object('plan', 'free', 'status', 'active', 'provider', NULL));
$$;

CREATE OR REPLACE FUNCTION public.sync_play_subscription(p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid := (p_input->>'user_id')::uuid;
  v_ref text := p_input->>'provider_reference';
  v_linked text := nullif(p_input->>'linked_reference', '');
  v_observed timestamptz := (p_input->>'observed_at')::timestamptz;
  v_row public.play_subscriptions;
BEGIN
  IF v_ref IS NULL OR v_ref = '' OR v_observed IS NULL OR v_linked = v_ref
     OR coalesce(p_input->>'plan', '') NOT IN ('pro', 'business', 'artist', 'director', 'beast', 'genius', 'titan', 'max') THEN
    RAISE EXCEPTION 'invalid_subscription_update';
  END IF;
  PERFORM 1 FROM public.profiles WHERE id = v_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'subscription_account_not_found'; END IF;

  SELECT * INTO v_row FROM public.play_subscriptions WHERE provider_reference = v_ref;
  IF FOUND AND v_row.user_id <> v_user THEN RAISE EXCEPTION 'payment_already_claimed'; END IF;

  INSERT INTO public.play_subscriptions (
    provider_reference, user_id, product_id, plan, status, current_period_start, current_period_end,
    linked_reference, pending_product_id, auto_renewing, observed_at
  ) VALUES (
    v_ref, v_user, p_input->>'product_id', p_input->>'plan', p_input->>'status',
    (p_input->>'current_period_start')::timestamptz, (p_input->>'current_period_end')::timestamptz,
    v_linked, p_input->>'pending_product_id', (p_input->>'auto_renewing')::boolean, v_observed
  ) ON CONFLICT (provider_reference) DO UPDATE SET
    product_id = excluded.product_id, plan = excluded.plan, status = excluded.status,
    current_period_start = excluded.current_period_start, current_period_end = excluded.current_period_end,
    linked_reference = coalesce(excluded.linked_reference, play_subscriptions.linked_reference),
    pending_product_id = excluded.pending_product_id, auto_renewing = excluded.auto_renewing,
    observed_at = excluded.observed_at
  WHERE play_subscriptions.user_id = excluded.user_id
    AND play_subscriptions.observed_at <= excluded.observed_at;

  -- Re-check after ON CONFLICT: two accounts racing for one token.
  SELECT * INTO v_row FROM public.play_subscriptions WHERE provider_reference = v_ref;
  IF v_row.user_id <> v_user THEN RAISE EXCEPTION 'payment_already_claimed'; END IF;

  -- An upgrade/downgrade/resubscribe gives a new token linked to the old one.
  -- Retire the old one (creating a placeholder if we never saw it) so it can
  -- neither be re-activated nor claimed by a different account later.
  IF v_linked IS NOT NULL AND v_row.observed_at = v_observed AND coalesce((p_input->>'retire_linked')::boolean, false) THEN
    INSERT INTO public.play_subscriptions (provider_reference, user_id, plan, status, replaced_by_reference, observed_at)
    VALUES (v_linked, v_user, v_row.plan, 'expired', v_ref, v_observed)
    ON CONFLICT (provider_reference) DO UPDATE
      SET replaced_by_reference = coalesce(play_subscriptions.replaced_by_reference, v_ref)
      WHERE play_subscriptions.user_id = v_user;
    IF NOT FOUND THEN RAISE EXCEPTION 'payment_already_claimed'; END IF;
  END IF;

  RETURN public.get_ai_plan(v_user);
END;
$$;

CREATE OR REPLACE FUNCTION public.leadership_eligibility(p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s leadership_games_settings%ROWTYPE;
  v_plan text;
  v_created timestamptz;
  v_confirmed timestamptz;
  v_open int;
BEGIN
  SELECT * INTO s FROM leadership_games_settings WHERE id;
  v_plan := COALESCE(get_ai_plan(p_user_id)->>'plan', 'free');
  SELECT created_at INTO v_created FROM profiles WHERE id = p_user_id;
  SELECT email_confirmed_at INTO v_confirmed FROM auth.users WHERE id = p_user_id;
  SELECT count(*) INTO v_open FROM (
    SELECT gw.circle_id FROM game_waitlist gw JOIN game_circles gc ON gc.id = gw.circle_id
      WHERE gw.user_id = p_user_id AND gc.status = 'waitlisting'
    UNION
    SELECT gp.circle_id FROM game_participants gp JOIN game_circles gc ON gc.id = gp.circle_id
      WHERE gp.user_id = p_user_id AND gc.status = 'active'
  ) x;

  IF s.entry_mode = 'subscribers_only' AND v_plan = 'free' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'needs_plan', 'reason', 'Leadership Games are a benefit of paid Bascardo AI plans.');
  END IF;
  IF v_confirmed IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'confirm_email', 'reason', 'Confirm your email address to play for prizes.');
  END IF;
  IF v_created IS NOT NULL AND v_created > now() - make_interval(days => s.min_account_age_days) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'too_new', 'reason', format('New accounts can play for prizes after %s days.', s.min_account_age_days));
  END IF;
  IF v_open >= s.max_open_games THEN
    RETURN jsonb_build_object('ok', false, 'code', 'too_many', 'reason', format('You can be in %s games at a time. Finish or leave one first.', s.max_open_games));
  END IF;
  RETURN jsonb_build_object('ok', true, 'plan', v_plan, 'entry_mode', s.entry_mode);
END;
$$;

NOTIFY pgrst, 'reload schema';
