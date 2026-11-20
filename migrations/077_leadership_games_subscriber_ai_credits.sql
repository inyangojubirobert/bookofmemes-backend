-- 077: Leadership Games become a subscriber benefit with AI-credit prizes.
--
-- Before: every player paid a wallet join fee into a pot; one winner got 65%
-- of it back in wallet money. That is a paid, player-funded, winner-takes-all
-- contest, which Google Play can treat as gambling.
--
-- Now (owner's decision, 2026-11-20):
--   * No join fee. Nothing is held, captured or pooled from players.
--   * Who may enter is a setting: 'subscribers_only' (Bascardo AI Pro or
--     Business; ON) or 'free' (everyone). The subscription is bought for the
--     AI service itself; the games are a supplementary benefit of it.
--   * The prize is a FIXED number of AI credits per title, paid by Book of
--     Memes (not from players), added to the winner's top-up credits (075):
--     non-transferable, non-withdrawable, usable only for Bascardo AI.
--   * Against prize farming: a confirmed email, a minimum account age, at most
--     a few games at once, and a minimum number of correct answers to win.
--   * Official rules are stored with a version so the app can show them.
-- No live player was affected: on 2026-11-20 there were 4 empty waiting
-- circles and no held fees.
BEGIN;

-- ── Settings (one row) ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.leadership_games_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  entry_mode text NOT NULL DEFAULT 'subscribers_only' CHECK (entry_mode IN ('subscribers_only', 'free')),
  ads_enabled boolean NOT NULL DEFAULT true,
  min_account_age_days int NOT NULL DEFAULT 3 CHECK (min_account_age_days >= 0),
  max_open_games int NOT NULL DEFAULT 3 CHECK (max_open_games >= 1),
  min_correct_to_win int NOT NULL DEFAULT 10 CHECK (min_correct_to_win >= 0),
  rules_version text NOT NULL DEFAULT '2026-11-20',
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.leadership_games_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
ALTER TABLE public.leadership_games_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS leadership_games_settings_read ON public.leadership_games_settings;
CREATE POLICY leadership_games_settings_read ON public.leadership_games_settings FOR SELECT USING (true);

-- ── AI-credit prize per title (fixed, platform-funded) ──────────────────────
ALTER TABLE public.game_titles ADD COLUMN IF NOT EXISTS prize_ai_credits int;
ALTER TABLE public.game_circles ADD COLUMN IF NOT EXISTS prize_ai_credits int;
UPDATE public.game_titles SET prize_ai_credits = v.c FROM (VALUES
  ('Duel of Leaders', 20), ('Council of Five', 40), ('League of Ten', 60), ('Circle of Fifteen', 80),
  ('Vision 20', 100), ('Elite Thirty', 150), ('Council of Fifty', 200), ('Century League', 300),
  ('Double Century Arena', 500), ('Titan 500', 800), ('Millennium Masters', 1200), ('Legends Assembly', 2000)
) AS v(n, c) WHERE game_titles.name = v.n AND game_titles.prize_ai_credits IS NULL;
UPDATE public.game_titles SET prize_ai_credits = 50 WHERE prize_ai_credits IS NULL;
ALTER TABLE public.game_titles ALTER COLUMN prize_ai_credits SET NOT NULL;
-- The old wallet fee / cash prize columns stay for history but are no longer used.

-- Release anything still held for a waiting seat (there was nothing on 2026-11-20).
UPDATE public.wallet_holds SET status = 'released'
WHERE reason = 'leadership_game_waitlist' AND status = 'held';

-- ── Who may enter (used by join and shown by the app) ───────────────────────
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

  IF s.entry_mode = 'subscribers_only' AND v_plan NOT IN ('pro', 'business') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'needs_plan', 'reason', 'Leadership Games are a benefit of Bascardo AI Pro and Business.');
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
REVOKE ALL ON FUNCTION public.leadership_eligibility(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.leadership_eligibility(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.my_leadership_eligibility()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT leadership_eligibility(auth.uid());
$$;
GRANT EXECUTE ON FUNCTION public.my_leadership_eligibility() TO authenticated;

-- ── Join: no fee, eligibility first ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.join_leadership_waitlist(p_title_id uuid, p_user_id uuid)
 RETURNS game_waitlist
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_title game_titles%ROWTYPE;
  v_circle game_circles%ROWTYPE;
  v_seat game_waitlist%ROWTYPE;
  v_ok jsonb;
BEGIN
  IF p_user_id <> auth.uid() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT * INTO v_title FROM game_titles WHERE id = p_title_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Game title not found'; END IF;
  IF NOT v_title.is_active THEN RAISE EXCEPTION 'This game title is not currently open'; END IF;

  v_ok := leadership_eligibility(p_user_id);
  IF NOT (v_ok->>'ok')::boolean THEN RAISE EXCEPTION '%', v_ok->>'reason'; END IF;

  IF EXISTS (
    SELECT 1 FROM game_participants gp JOIN game_circles gc ON gc.id = gp.circle_id
    WHERE gc.title_id = p_title_id AND gc.status = 'active' AND gp.user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'You are already playing an active circle of this title';
  END IF;

  SELECT * INTO v_circle FROM game_circles WHERE title_id = p_title_id AND status = 'waitlisting' FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO game_circles (title_id, circle_number)
      VALUES (p_title_id, COALESCE((SELECT MAX(circle_number) FROM game_circles WHERE title_id = p_title_id), 0) + 1)
      RETURNING * INTO v_circle;
  END IF;
  IF v_circle.seats_filled >= v_title.group_size THEN
    RAISE EXCEPTION 'This circle just filled -- try again for the next circle';
  END IF;
  IF EXISTS (SELECT 1 FROM game_waitlist WHERE circle_id = v_circle.id AND user_id = p_user_id) THEN
    RAISE EXCEPTION 'You have already joined this circle';
  END IF;

  INSERT INTO game_waitlist (circle_id, user_id, wallet_hold_id, status)
    VALUES (v_circle.id, p_user_id, NULL, 'waiting')
    RETURNING * INTO v_seat;
  UPDATE game_circles SET seats_filled = seats_filled + 1 WHERE id = v_circle.id RETURNING * INTO v_circle;
  IF v_circle.seats_filled >= v_title.group_size THEN
    PERFORM activate_leadership_circle(v_circle.id);
  END IF;
  RETURN v_seat;
END;
$function$;

-- ── Activate: nothing to capture; the prize is fixed when the circle starts ──
CREATE OR REPLACE FUNCTION public.activate_leadership_circle(p_circle_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_title game_titles%ROWTYPE;
  v_seat record;
BEGIN
  SELECT gt.* INTO v_title FROM game_titles gt JOIN game_circles gc ON gc.title_id = gt.id WHERE gc.id = p_circle_id;
  UPDATE game_circles
    SET status = 'active', activated_at = now(), ends_at = now() + interval '30 days', prize_ai_credits = v_title.prize_ai_credits
    WHERE id = p_circle_id AND status = 'waitlisting';
  IF NOT FOUND THEN RETURN; END IF;

  FOR v_seat IN SELECT * FROM game_waitlist WHERE circle_id = p_circle_id AND status = 'waiting' LOOP
    UPDATE game_waitlist SET status = 'confirmed' WHERE id = v_seat.id;
    INSERT INTO game_participants (circle_id, user_id) VALUES (p_circle_id, v_seat.user_id);
    INSERT INTO notifications (user_id, type, title, body, reference_id)
      VALUES (v_seat.user_id, 'leadership_game_activated', v_title.name || ' is live!',
              'Your circle is full and play has started. You have 30 days to score the most points and win '
              || v_title.prize_ai_credits || ' Bascardo AI credits.', p_circle_id);
  END LOOP;
  PERFORM generate_daily_questions(p_circle_id, 1);
END;
$function$;

-- Leaving a waiting circle: nothing to refund any more.
CREATE OR REPLACE FUNCTION public.leave_leadership_waitlist(p_waitlist_id uuid, p_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_seat game_waitlist%ROWTYPE;
  v_circle game_circles%ROWTYPE;
BEGIN
  IF p_user_id <> auth.uid() THEN RAISE EXCEPTION 'Not authorized'; END IF;
  SELECT * INTO v_seat FROM game_waitlist WHERE id = p_waitlist_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Waitlist seat not found'; END IF;
  SELECT * INTO v_circle FROM game_circles WHERE id = v_seat.circle_id FOR UPDATE;
  IF v_circle.status <> 'waitlisting' THEN RAISE EXCEPTION 'This circle has already started'; END IF;
  IF v_seat.wallet_hold_id IS NOT NULL THEN
    UPDATE wallet_holds SET status = 'released' WHERE id = v_seat.wallet_hold_id AND status = 'held';
  END IF;
  DELETE FROM game_waitlist WHERE id = v_seat.id;
  UPDATE game_circles SET seats_filled = GREATEST(seats_filled - 1, 0) WHERE id = v_circle.id;
END;
$function$;

-- ── Settle: fixed AI-credit prize to the top scorer (if they reached the minimum) ──
CREATE OR REPLACE FUNCTION public.settle_leadership_circle(p_circle_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_circle game_circles%ROWTYPE;
  v_title game_titles%ROWTYPE;
  v_winner game_participants%ROWTYPE;
  v_min int;
  v_prize int;
  v_has_winner boolean := false;
BEGIN
  SELECT * INTO v_circle FROM game_circles WHERE id = p_circle_id FOR UPDATE;
  IF NOT FOUND OR v_circle.status <> 'active' THEN RETURN; END IF;
  SELECT * INTO v_title FROM game_titles WHERE id = v_circle.title_id;
  SELECT min_correct_to_win INTO v_min FROM leadership_games_settings WHERE id;
  v_prize := COALESCE(v_circle.prize_ai_credits, v_title.prize_ai_credits);

  UPDATE game_participants gp SET rank = ranked.rnk
    FROM (SELECT gp2.id, RANK() OVER (ORDER BY gp2.score DESC, gp2.score_updated_at ASC, gp2.user_id ASC) AS rnk
          FROM game_participants gp2 WHERE gp2.circle_id = p_circle_id) ranked
    WHERE gp.id = ranked.id;

  SELECT * INTO v_winner FROM game_participants
    WHERE circle_id = p_circle_id ORDER BY score DESC, score_updated_at ASC, user_id ASC LIMIT 1;
  v_has_winner := FOUND AND v_winner.score >= COALESCE(v_min, 0);

  IF v_has_winner THEN
    PERFORM grant_ai_topup(v_winner.user_id, 'leadership_prize', v_prize, 0, 'leadership:' || p_circle_id::text);
    INSERT INTO notifications (user_id, type, title, body, reference_id)
      VALUES (v_winner.user_id, 'leadership_game_won', 'You won ' || v_title.name || '!',
              'Final score: ' || v_winner.score || '. ' || v_prize || ' Bascardo AI credits have been added to your account. Use them in Bascardo AI Studio.',
              p_circle_id);
  END IF;

  UPDATE game_circles
    SET status = 'completed', completed_at = now(),
        winner_id = CASE WHEN v_has_winner THEN v_winner.user_id END,
        winner_score = CASE WHEN v_has_winner THEN v_winner.score END,
        prize_paid = NULL, prize_ai_credits = CASE WHEN v_has_winner THEN v_prize ELSE 0 END
    WHERE id = p_circle_id;

  INSERT INTO notifications (user_id, type, title, body, reference_id)
    SELECT gp.user_id, 'leadership_game_ended', v_title.name || ' has ended',
      CASE WHEN v_has_winner THEN 'The circle is over. Final rank: #' || gp.rank || '. A new circle is open to join.'
           ELSE 'The circle is over. Nobody reached ' || COALESCE(v_min, 0) || ' correct answers, so no prize this time. A new circle is open.' END,
      p_circle_id
    FROM game_participants gp WHERE gp.circle_id = p_circle_id AND (NOT v_has_winner OR gp.user_id <> v_winner.user_id);

  INSERT INTO game_circles (title_id, circle_number)
    VALUES (v_title.id, v_circle.circle_number + 1)
    ON CONFLICT (title_id, circle_number) DO NOTHING;
END;
$function$;

COMMIT;
