-- 059: Bascardo AI plans as Google Play subscriptions (One Dream's model).
--
-- Free / Pro ($9 a month) / Business ($20 a month), each a monthly pool of AI
-- credits (25 / 200 / 750, see Backend/config/aiPlans.js). Each Play purchase token is
-- one subscription row; the user's plan is the best valid row. Raw purchase
-- tokens are never stored, only their sha256 (provider_reference).
--
-- The old single "Premium" (subscriptions table, $9.99 in credits for 30 days)
-- is no longer sold. Anyone with a live one keeps Pro until it expires.
--
-- Everything here is server-only (service_role) except my_ai_plan(), which
-- lets the signed-in user read their own plan.
BEGIN;

CREATE TABLE IF NOT EXISTS public.play_subscriptions (
  provider_reference text PRIMARY KEY,               -- sha256 of the Play purchase token
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  product_id text,
  plan text NOT NULL CHECK (plan IN ('pro', 'business')),
  status text NOT NULL CHECK (status IN ('pending', 'active', 'cancelled', 'past_due', 'expired', 'refunded')),
  current_period_start timestamptz,
  current_period_end timestamptz,
  linked_reference text,                              -- token this one replaced (upgrade/downgrade/resubscribe)
  replaced_by_reference text,                         -- set when a newer token took over
  pending_product_id text,                            -- deferred downgrade waiting for the period end
  auto_renewing boolean,
  observed_at timestamptz NOT NULL,                   -- Google's state at this time; older observations never overwrite newer ones
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS play_subscriptions_user_idx ON public.play_subscriptions (user_id);
ALTER TABLE public.play_subscriptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.play_subscriptions FROM anon, authenticated;
GRANT ALL ON public.play_subscriptions TO service_role;

-- The plan in force: the highest valid, not-replaced Play subscription; else a
-- still-running legacy credits Premium (= Pro); else Free. Expiry alone moves
-- a user down, without waiting for a notification from Google.
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
      ORDER BY CASE s.plan WHEN 'business' THEN 2 ELSE 1 END DESC, s.current_period_end DESC, s.observed_at DESC
      LIMIT 1),
    (SELECT jsonb_build_object(
        'plan', 'pro', 'status', 'cancelled', 'provider', 'credits', 'product_id', NULL,
        'current_period_end', l.expires_at, 'pending_product_id', NULL, 'auto_renewing', false)
       FROM public.subscriptions l
      WHERE l.user_id = p_user_id AND l.status = 'active' AND l.expires_at > now()
      ORDER BY l.expires_at DESC LIMIT 1),
    jsonb_build_object('plan', 'free', 'status', 'active', 'provider', NULL));
$$;

CREATE OR REPLACE FUNCTION public.my_ai_plan()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT public.get_ai_plan(auth.uid());
$$;

-- Records one verified Google state for a token. The profile row lock
-- serialises updates for one user; ownership is checked in the same transaction.
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
     OR coalesce(p_input->>'plan', '') NOT IN ('pro', 'business') THEN
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

REVOKE ALL ON FUNCTION public.get_ai_plan(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_play_subscription(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_ai_plan(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.sync_play_subscription(jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.my_ai_plan() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_ai_plan() TO authenticated, service_role;

-- The monthly AI credit pool is counted in ai_usage_monthly (feature
-- 'ai_credits', unit 'credits'). Replace any older unit check with one that
-- allows it.
DO $$
DECLARE r record;
BEGIN
  IF to_regclass('public.ai_usage_monthly') IS NOT NULL THEN
    FOR r IN SELECT conname FROM pg_constraint
              WHERE conrelid = 'public.ai_usage_monthly'::regclass AND contype = 'c'
                AND pg_get_constraintdef(oid) ILIKE '%unit%' LOOP
      EXECUTE format('ALTER TABLE public.ai_usage_monthly DROP CONSTRAINT %I', r.conname);
    END LOOP;
    ALTER TABLE public.ai_usage_monthly ADD CONSTRAINT ai_usage_monthly_unit_check
      CHECK (unit IN ('generations', 'seconds', 'credits')) NOT VALID;
  END IF;
END $$;

-- Stop selling the old credits Premium (existing ones run out normally).
DO $$
BEGIN
  IF to_regprocedure('public.purchase_premium_subscription()') IS NOT NULL THEN
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.purchase_premium_subscription() FROM PUBLIC, anon, authenticated';
  END IF;
END $$;

COMMIT;
