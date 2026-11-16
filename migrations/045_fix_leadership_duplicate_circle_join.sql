-- join_leadership_waitlist only ever checked "have I already joined *this
-- specific* circle" (game_waitlist UNIQUE(circle_id, user_id), plus its own
-- explicit "You have already joined this circle" check). Nothing checked
-- whether the calling user was already an active participant in a *different*
-- circle of the same title.
--
-- Concretely: a user joins and plays circle #1 of "Duel of Leaders", answers
-- all of today's ~20 questions, scores ~20 points. Nothing stops them from
-- opening the Leadership Games screen again and tapping "Join Waitlist" on
-- the same title -- join_leadership_waitlist finds no circle in
-- 'waitlisting' status for that title (circle #1 is 'active', not
-- 'waitlisting'), so it happily creates a brand-new circle #2 and lets them
-- join it. Once circle #2 fills and activates (via other joiners, or the
-- same behavior repeated), the user now holds TWO independent
-- game_participants rows for the same title -- two independent daily
-- question streams, two independent ~20-point/day ceilings. That's the "user
-- plays twice same day, scores more than 20 points for a day's game" bug:
-- from the player's perspective it's the same game repeating, but the
-- backend has no concept of "you're already in this title."
--
-- Fix: block joining/creating a waitlisting circle for a title the user
-- already has an ACTIVE participation in. Deliberately scoped to status =
-- 'active' only, not any circle ever -- game_participants rows are never
-- deleted after a circle completes (settle_leadership_circle only updates
-- game_circles), and re-joining a title after a past circle's 30 days are up
-- is exactly the intended "repeating circle" behavior, not a bug.
--
-- No change needed to the waitlist-circle-creation race itself: the existing
-- `SELECT * FROM game_titles ... FOR UPDATE` row lock at the top of this
-- function already serializes concurrent joins for the same title (see that
-- line's own comment), so two overlapping calls can't independently create
-- two 'waitlisting' circles for one title. This migration only closes the
-- separate "active-elsewhere" gap.
CREATE OR REPLACE FUNCTION public.join_leadership_waitlist(p_title_id uuid, p_user_id uuid)
 RETURNS game_waitlist
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_title game_titles%ROWTYPE;
  v_circle game_circles%ROWTYPE;
  v_wallet wallets%ROWTYPE;
  v_held numeric;
  v_available numeric;
  v_hold_id uuid;
  v_seat game_waitlist%ROWTYPE;
BEGIN
  IF p_user_id <> auth.uid() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT * INTO v_title FROM game_titles WHERE id = p_title_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Game title not found';
  END IF;
  IF NOT v_title.is_active THEN
    RAISE EXCEPTION 'This game title is not currently open';
  END IF;

  IF EXISTS (
    SELECT 1 FROM game_participants gp
    JOIN game_circles gc ON gc.id = gp.circle_id
    WHERE gc.title_id = p_title_id AND gc.status = 'active' AND gp.user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'You are already playing an active circle of this title';
  END IF;

  SELECT * INTO v_circle FROM game_circles
    WHERE title_id = p_title_id AND status = 'waitlisting' FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO game_circles (title_id, circle_number)
      VALUES (p_title_id, COALESCE((SELECT MAX(circle_number) FROM game_circles WHERE title_id = p_title_id), 0) + 1)
      RETURNING * INTO v_circle;
  END IF;

  -- A full waitlist has already flipped to 'active' inside this same
  -- transaction below the moment its last seat filled, so reaching this
  -- point with seats_filled >= group_size should not happen -- guarded
  -- anyway since v_circle was read before that possibility.
  IF v_circle.seats_filled >= v_title.group_size THEN
    RAISE EXCEPTION 'This circle just filled -- try again for the next circle';
  END IF;

  IF EXISTS (SELECT 1 FROM game_waitlist WHERE circle_id = v_circle.id AND user_id = p_user_id) THEN
    RAISE EXCEPTION 'You have already joined this circle';
  END IF;

  SELECT * INTO v_wallet FROM wallets WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Wallet not found';
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_held FROM wallet_holds WHERE wallet_id = v_wallet.id AND status = 'held';
  v_available := v_wallet.wallet_balance - v_held;
  IF v_available < v_title.join_fee THEN
    RAISE EXCEPTION 'Insufficient available balance for the $% join fee', v_title.join_fee;
  END IF;

  INSERT INTO wallet_holds (wallet_id, amount, reason, status)
    VALUES (v_wallet.id, v_title.join_fee, 'leadership_game_waitlist', 'held')
    RETURNING id INTO v_hold_id;

  INSERT INTO game_waitlist (circle_id, user_id, wallet_hold_id, status)
    VALUES (v_circle.id, p_user_id, v_hold_id, 'waiting')
    RETURNING * INTO v_seat;

  UPDATE wallet_holds SET reference_id = v_seat.id WHERE id = v_hold_id;

  UPDATE game_circles SET seats_filled = seats_filled + 1 WHERE id = v_circle.id
    RETURNING * INTO v_circle;

  IF v_circle.seats_filled >= v_title.group_size THEN
    PERFORM activate_leadership_circle(v_circle.id);
  END IF;

  RETURN v_seat;
END;
$function$;

-- No REVOKE/GRANT here -- the original 016 definition never added any, so
-- this keeps the same default PUBLIC execute grant clients already rely on
-- (see leadershipGamesService.js's header comment).

-- Verify
SELECT routine_name FROM information_schema.routines
WHERE routine_name = 'join_leadership_waitlist' AND routine_schema = 'public';
