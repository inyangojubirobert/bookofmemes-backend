-- Leadership Games: 12 fixed-size, repeating-circle prediction/trivia games.
-- Each game_titles row is a permanent template (name, group size, join fee,
-- winner-take-all grand prize). Each run of a title is a game_circles row
-- ("circle"): opens in 'waitlisting', locks and flips to 'active' the instant
-- its waitlist hits group_size (winner_take_all_amount already enforced to be
-- < join_fee * group_size via the CHECK constraint below, so every circle is
-- profitable by construction), runs for a fixed 30-day window with a daily
-- random trivia set, then settles a single winner (highest score, ties broken
-- by whoever reached that score first) and reopens a fresh circle.
--
-- Deliberately NOT built on the pre-existing events/event_participants/
-- event_waitlist/event_scores/leaderboard_snapshots tables (see
-- database-schema.json) -- those are generic one-off-event scaffolding with
-- no references anywhere in the codebase, no concept of a fixed group size,
-- recurring circles, or daily content rotation. Purpose-built tables here
-- instead of bending that shape.
--
-- Scoring is intentionally a brand-new ledger (game_daily_questions /
-- game_answers), not a retrofit onto puzzle_user_quiz_activity /
-- kids_user_quiz_activity or the puzzles/kids_collections screens. Those
-- source tables already hold authored quiz questions (question_text,
-- correct_answer, incorrect_answers) but nothing anywhere plays them today --
-- see PuzzlesBox.js / KidsBox.js, which never reference "quiz" at all. Game
-- content is a denormalized COPY of a random draw from those tables at
-- generation time, so normal puzzle/kids browsing is never touched by game
-- play, and a client can never read game_daily_questions.correct_answer
-- directly (no SELECT policy on that table -- see below).

-- ── 1. game_titles ───────────────────────────────────────────────────────────
CREATE TABLE game_titles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  description text,
  group_size integer NOT NULL CHECK (group_size > 0),
  join_fee numeric NOT NULL CHECK (join_fee > 0),
  grand_prize numeric NOT NULL CHECK (grand_prize > 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT game_titles_profitable CHECK (join_fee * group_size > grand_prize)
);

ALTER TABLE game_titles ENABLE ROW LEVEL SECURITY;
CREATE POLICY game_titles_select ON game_titles FOR SELECT USING (true);

-- ── 2. game_circles ──────────────────────────────────────────────────────────
CREATE TABLE game_circles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title_id uuid NOT NULL REFERENCES game_titles(id) ON DELETE CASCADE,
  circle_number integer NOT NULL,
  status text NOT NULL DEFAULT 'waitlisting' CHECK (status IN ('waitlisting', 'active', 'completed')),
  seats_filled integer NOT NULL DEFAULT 0,
  activated_at timestamptz,
  ends_at timestamptz,
  completed_at timestamptz,
  winner_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  winner_score integer,
  prize_paid numeric,
  created_at timestamptz DEFAULT now(),
  UNIQUE (title_id, circle_number)
);

CREATE INDEX game_circles_title_status_idx ON game_circles(title_id, status);
CREATE INDEX game_circles_active_ends_idx ON game_circles(status, ends_at) WHERE status = 'active';

ALTER TABLE game_circles ENABLE ROW LEVEL SECURITY;
CREATE POLICY game_circles_select ON game_circles FOR SELECT USING (true);

-- ── 3. game_waitlist ─────────────────────────────────────────────────────────
CREATE TABLE game_waitlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id uuid NOT NULL REFERENCES game_circles(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  wallet_hold_id uuid REFERENCES wallet_holds(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'confirmed', 'left')),
  joined_at timestamptz DEFAULT now(),
  left_at timestamptz,
  UNIQUE (circle_id, user_id)
);

CREATE INDEX game_waitlist_user_idx ON game_waitlist(user_id);

ALTER TABLE game_waitlist ENABLE ROW LEVEL SECURITY;
CREATE POLICY game_waitlist_select ON game_waitlist FOR SELECT USING (auth.uid() = user_id);

-- ── 4. game_participants ─────────────────────────────────────────────────────
-- Created from game_waitlist the moment a circle activates. score_updated_at
-- is the tie-break: at settlement, highest score wins outright; if two
-- participants share the top score, whichever of them reached it earliest
-- wins -- so settlement always resolves to exactly one winner.
CREATE TABLE game_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id uuid NOT NULL REFERENCES game_circles(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  score integer NOT NULL DEFAULT 0,
  score_updated_at timestamptz NOT NULL DEFAULT now(),
  rank integer,
  created_at timestamptz DEFAULT now(),
  UNIQUE (circle_id, user_id)
);

CREATE INDEX game_participants_circle_score_idx ON game_participants(circle_id, score DESC, score_updated_at ASC);
CREATE INDEX game_participants_user_idx ON game_participants(user_id);

ALTER TABLE game_participants ENABLE ROW LEVEL SECURITY;
-- Public on purpose -- this table IS the leaderboard.
CREATE POLICY game_participants_select ON game_participants FOR SELECT USING (true);

-- ── 5. game_daily_questions ──────────────────────────────────────────────────
-- Denormalized copy of a random draw from puzzle_user_quiz_activity /
-- kids_user_quiz_activity, one set per (circle, day). No SELECT policy at all
-- -- correct_answer must never be directly queryable by a client; questions
-- are only ever handed out via get_leadership_daily_questions() below, which
-- returns the options unlabeled.
CREATE TABLE game_daily_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id uuid NOT NULL REFERENCES game_circles(id) ON DELETE CASCADE,
  day_number integer NOT NULL CHECK (day_number BETWEEN 1 AND 30),
  source_table text NOT NULL CHECK (source_table IN ('puzzle_user_quiz_activity', 'kids_user_quiz_activity')),
  source_id uuid NOT NULL,
  question_text text,
  image_url text,
  correct_answer text NOT NULL,
  incorrect_answers jsonb NOT NULL,
  -- Assigned once at generation time (see generate_daily_questions) and
  -- read back via ORDER BY in get_leadership_daily_questions -- without a
  -- stored order, "Question 1/2/3..." in the gameplay screen could reshuffle
  -- between requests, since a bare SELECT with no ORDER BY has no
  -- guaranteed row order in Postgres.
  question_order integer NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE (circle_id, day_number, source_id)
);

CREATE INDEX game_daily_questions_circle_day_idx ON game_daily_questions(circle_id, day_number);

ALTER TABLE game_daily_questions ENABLE ROW LEVEL SECURITY;

-- ── 6. game_answers ──────────────────────────────────────────────────────────
-- Dedicated scoring ledger -- completely separate from `interactions` /
-- comments / any general engagement tracking, exactly so ordinary puzzle and
-- kids browsing is never affected by game scoring. One attempt per question.
-- No INSERT/UPDATE policy -- only submit_leadership_answer() (SECURITY
-- DEFINER) may write here.
CREATE TABLE game_answers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id uuid NOT NULL REFERENCES game_circles(id) ON DELETE CASCADE,
  daily_question_id uuid NOT NULL REFERENCES game_daily_questions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  selected_answer text NOT NULL,
  is_correct boolean NOT NULL,
  answered_at timestamptz DEFAULT now(),
  UNIQUE (daily_question_id, user_id)
);

CREATE INDEX game_answers_user_idx ON game_answers(user_id);

ALTER TABLE game_answers ENABLE ROW LEVEL SECURITY;
CREATE POLICY game_answers_select ON game_answers FOR SELECT USING (auth.uid() = user_id);

-- ── 7. revenue_sources entry ─────────────────────────────────────────────────
-- database-schema.json (the repo's schema dump) is stale here -- the live
-- table also requires `category` (confirmed via the PostgREST OpenAPI doc,
-- since RLS on this table has no SELECT policy for anon/authenticated -- see
-- 001_revenue_ledger_system.sql's comment -- so only a service-role query
-- can actually read it). Existing rows use one-word groupings ('marketplace',
-- 'exchange', 'withdrawal', 'transfer'); 'games' follows that convention.
INSERT INTO revenue_sources (source, fee_type, category, enabled, description)
VALUES ('leadership_game_margin', 'fixed', 'games', true, 'Platform margin on a settled Leadership Games circle (pot minus grand prize paid to winner)')
ON CONFLICT (source) DO NOTHING;

-- ── 8. generate_daily_questions (internal) ───────────────────────────────────
-- Draws 10 random rows from puzzle_user_quiz_activity + 10 from
-- kids_user_quiz_activity ("puzzle type content ... covers just puzzles item
-- type content and for kids item type content"). No-ops if the day's set
-- already exists (idempotent -- safe to call from both activation and the
-- sweep).
CREATE OR REPLACE FUNCTION public.generate_daily_questions(p_circle_id uuid, p_day_number integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM game_daily_questions WHERE circle_id = p_circle_id AND day_number = p_day_number) THEN
    RETURN;
  END IF;

  INSERT INTO game_daily_questions (circle_id, day_number, source_table, source_id, question_text, image_url, correct_answer, incorrect_answers, question_order)
  SELECT p_circle_id, p_day_number, 'puzzle_user_quiz_activity', id, question_text, image_url, correct_answer, incorrect_answers, row_number() OVER ()
  FROM (SELECT * FROM puzzle_user_quiz_activity ORDER BY random() LIMIT 10) s;

  INSERT INTO game_daily_questions (circle_id, day_number, source_table, source_id, question_text, image_url, correct_answer, incorrect_answers, question_order)
  SELECT p_circle_id, p_day_number, 'kids_user_quiz_activity', id, question_text, image_url, correct_answer, incorrect_answers,
    10 + row_number() OVER ()
  FROM (SELECT * FROM kids_user_quiz_activity ORDER BY random() LIMIT 10) s;
END;
$function$;

REVOKE ALL ON FUNCTION public.generate_daily_questions(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.generate_daily_questions(uuid, integer) FROM anon, authenticated;

-- ── 9. activate_leadership_circle (internal) ─────────────────────────────────
-- Captures every waiting member's held join fee, turns them into
-- game_participants, starts the 30-day clock, generates day 1's questions,
-- and notifies everyone the circle is live.
--
-- The UPDATE ... WHERE status = 'waitlisting' + IF NOT FOUND guard below
-- makes this idempotent: join_leadership_waitlist's only current call site
-- already can't invoke this twice for the same circle (it locks the
-- game_titles row FOR UPDATE before ever reading the circle, which
-- serializes every join/activation for a title through one lock -- see that
-- function's header comment), so this can't currently double-fire. The guard
-- is here anyway so the function stays safe on its own terms if another call
-- site is ever added.
CREATE OR REPLACE FUNCTION public.activate_leadership_circle(p_circle_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_title game_titles%ROWTYPE;
  v_seat record;
  v_wallet wallets%ROWTYPE;
BEGIN
  SELECT gt.* INTO v_title FROM game_titles gt
    JOIN game_circles gc ON gc.title_id = gt.id WHERE gc.id = p_circle_id;

  UPDATE game_circles
    SET status = 'active', activated_at = now(), ends_at = now() + interval '30 days'
    WHERE id = p_circle_id AND status = 'waitlisting';
  IF NOT FOUND THEN
    RETURN;
  END IF;

  FOR v_seat IN SELECT * FROM game_waitlist WHERE circle_id = p_circle_id AND status = 'waiting' LOOP
    SELECT * INTO v_wallet FROM wallets WHERE user_id = v_seat.user_id FOR UPDATE;

    UPDATE wallet_holds SET status = 'captured' WHERE id = v_seat.wallet_hold_id AND status = 'held';
    UPDATE wallets SET wallet_balance = wallet_balance - v_title.join_fee, updated_at = now() WHERE id = v_wallet.id;
    INSERT INTO wallet_ledger (wallet_id, transaction_type, debit, credit, balance_before, balance_after, reference_id)
      VALUES (v_wallet.id, 'leadership_game_join_fee', v_title.join_fee, 0,
              v_wallet.wallet_balance, v_wallet.wallet_balance - v_title.join_fee, p_circle_id);
    INSERT INTO wallet_transactions (wallet_id, type, amount, description, status, currency_code, metadata)
      VALUES (v_wallet.id, 'leadership_game_join_fee', -v_title.join_fee,
              'Leadership Games join fee: ' || v_title.name, 'completed', 'USD',
              jsonb_build_object('circle_id', p_circle_id, 'title_id', v_title.id));

    UPDATE game_waitlist SET status = 'confirmed' WHERE id = v_seat.id;
    INSERT INTO game_participants (circle_id, user_id) VALUES (p_circle_id, v_seat.user_id);

    INSERT INTO notifications (user_id, type, title, body, reference_id)
      VALUES (v_seat.user_id, 'leadership_game_activated', v_title.name || ' is live!',
              'Your circle is full and game play has started. You have 30 days to score points and win the $' || v_title.grand_prize || ' grand prize.',
              p_circle_id);
  END LOOP;

  PERFORM generate_daily_questions(p_circle_id, 1);
END;
$function$;

REVOKE ALL ON FUNCTION public.activate_leadership_circle(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.activate_leadership_circle(uuid) FROM anon, authenticated;

-- ── 10. join_leadership_waitlist ─────────────────────────────────────────────
-- Finds (or lazily creates) the title's current 'waitlisting' circle, holds
-- the join fee in escrow (refundable via leave_leadership_waitlist while
-- still waiting), and activates the circle the instant it fills. Locking
-- game_titles row first serializes concurrent joins/circle-creation for the
-- same title, so two simultaneous joiners can never both create circle #1 or
-- both squeeze past a full waitlist.
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

-- ── 11. leave_leadership_waitlist ────────────────────────────────────────────
-- Only allowed while the circle is still 'waitlisting' -- once it activates,
-- a participant is committed for the 30-day run (matches join_leadership_
-- waitlist rejecting joins to an already-full/active circle).
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
  IF p_user_id <> auth.uid() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT * INTO v_seat FROM game_waitlist WHERE id = p_waitlist_id FOR UPDATE;
  IF NOT FOUND OR v_seat.user_id <> p_user_id THEN
    RAISE EXCEPTION 'Waitlist entry not found';
  END IF;
  IF v_seat.status <> 'waiting' THEN
    RAISE EXCEPTION 'This circle has already started -- you can no longer leave';
  END IF;

  SELECT * INTO v_circle FROM game_circles WHERE id = v_seat.circle_id FOR UPDATE;

  UPDATE wallet_holds SET status = 'released' WHERE id = v_seat.wallet_hold_id AND status = 'held';
  UPDATE game_waitlist SET status = 'left', left_at = now() WHERE id = p_waitlist_id;
  UPDATE game_circles SET seats_filled = GREATEST(0, seats_filled - 1) WHERE id = v_circle.id;
END;
$function$;

-- ── 12. get_leadership_daily_questions ───────────────────────────────────────
-- Only route by which a client ever sees a question -- returns today's set
-- for the caller's circle with the correct answer mixed anonymously into
-- `options` (never labeled), plus whether the caller already answered it.
CREATE OR REPLACE FUNCTION public.get_leadership_daily_questions(p_circle_id uuid)
 RETURNS TABLE (
   id uuid, day_number integer, question_text text, image_url text,
   options text[], already_answered boolean
 )
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_circle game_circles%ROWTYPE;
  v_day integer;
BEGIN
  SELECT * INTO v_circle FROM game_circles WHERE id = p_circle_id;
  IF NOT FOUND OR v_circle.status <> 'active' THEN
    RAISE EXCEPTION 'This circle is not currently active';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM game_participants WHERE circle_id = p_circle_id AND user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Not a participant in this game';
  END IF;

  v_day := LEAST(30, GREATEST(1, FLOOR(EXTRACT(EPOCH FROM (now() - v_circle.activated_at)) / 86400)::int + 1));

  RETURN QUERY
  SELECT
    q.id, q.day_number, q.question_text, q.image_url,
    (SELECT array_agg(opt ORDER BY random()) FROM (
       SELECT q.correct_answer AS opt
       UNION ALL
       SELECT jsonb_array_elements_text(q.incorrect_answers)
     ) opts) AS options,
    EXISTS(SELECT 1 FROM game_answers a WHERE a.daily_question_id = q.id AND a.user_id = auth.uid()) AS already_answered
  FROM game_daily_questions q
  WHERE q.circle_id = p_circle_id AND q.day_number = v_day
  ORDER BY q.question_order;
END;
$function$;

-- ── 13. submit_leadership_answer ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.submit_leadership_answer(p_daily_question_id uuid, p_user_id uuid, p_selected_answer text)
 RETURNS game_answers
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_question game_daily_questions%ROWTYPE;
  v_circle game_circles%ROWTYPE;
  v_correct boolean;
  v_answer game_answers%ROWTYPE;
BEGIN
  IF p_user_id <> auth.uid() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT * INTO v_question FROM game_daily_questions WHERE id = p_daily_question_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Question not found';
  END IF;

  -- Not locked (FOR UPDATE) -- this function never writes to game_circles,
  -- and locking it here would serialize every answer submission across the
  -- whole circle (up to 2000 participants x 20 questions/day) through one
  -- row lock for no benefit; the actual per-user score update below is
  -- already a single-row UPDATE and needs no extra locking.
  SELECT * INTO v_circle FROM game_circles WHERE id = v_question.circle_id;
  IF v_circle.status <> 'active' OR now() > v_circle.ends_at THEN
    RAISE EXCEPTION 'This circle is not currently accepting answers';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM game_participants WHERE circle_id = v_circle.id AND user_id = p_user_id) THEN
    RAISE EXCEPTION 'Not a participant in this game';
  END IF;
  IF EXISTS (SELECT 1 FROM game_answers WHERE daily_question_id = p_daily_question_id AND user_id = p_user_id) THEN
    RAISE EXCEPTION 'You already answered this question';
  END IF;

  v_correct := (p_selected_answer = v_question.correct_answer);

  INSERT INTO game_answers (circle_id, daily_question_id, user_id, selected_answer, is_correct)
    VALUES (v_circle.id, p_daily_question_id, p_user_id, p_selected_answer, v_correct)
    RETURNING * INTO v_answer;

  IF v_correct THEN
    UPDATE game_participants SET score = score + 1, score_updated_at = now()
      WHERE circle_id = v_circle.id AND user_id = p_user_id;
  END IF;

  RETURN v_answer;
END;
$function$;

-- ── 14. settle_leadership_circle (internal) ──────────────────────────────────
-- Highest score wins; a tie on score is broken by whoever's score_updated_at
-- is earliest (reached that score first) -- ORDER BY below always yields
-- exactly one winner. Ranks every participant, pays the grand prize out of
-- the pot already captured at activation (the gap between pot and prize is
-- the platform's margin, recorded via record_revenue), notifies everyone,
-- and opens the title's next circle so the waitlist immediately reopens.
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
  v_winner_wallet wallets%ROWTYPE;
  v_pot numeric;
BEGIN
  SELECT * INTO v_circle FROM game_circles WHERE id = p_circle_id FOR UPDATE;
  IF NOT FOUND OR v_circle.status <> 'active' THEN
    RETURN;
  END IF;

  SELECT * INTO v_title FROM game_titles WHERE id = v_circle.title_id;
  v_pot := v_title.join_fee * v_title.group_size;

  UPDATE game_participants gp SET rank = ranked.rnk
    FROM (
      SELECT id, RANK() OVER (ORDER BY score DESC, score_updated_at ASC, user_id ASC) AS rnk
      FROM game_participants WHERE circle_id = p_circle_id
    ) ranked
    WHERE gp.id = ranked.id;

  SELECT * INTO v_winner FROM game_participants
    WHERE circle_id = p_circle_id ORDER BY score DESC, score_updated_at ASC, user_id ASC LIMIT 1;

  IF FOUND THEN
    SELECT * INTO v_winner_wallet FROM wallets WHERE user_id = v_winner.user_id FOR UPDATE;
    UPDATE wallets SET wallet_balance = wallet_balance + v_title.grand_prize, updated_at = now()
      WHERE id = v_winner_wallet.id;
    INSERT INTO wallet_ledger (wallet_id, transaction_type, debit, credit, balance_before, balance_after, reference_id)
      VALUES (v_winner_wallet.id, 'leadership_game_prize', 0, v_title.grand_prize,
              v_winner_wallet.wallet_balance, v_winner_wallet.wallet_balance + v_title.grand_prize, p_circle_id);
    INSERT INTO wallet_transactions (wallet_id, type, amount, description, status, currency_code, metadata)
      VALUES (v_winner_wallet.id, 'leadership_game_prize', v_title.grand_prize,
              'Leadership Games grand prize: ' || v_title.name, 'completed', 'USD',
              jsonb_build_object('circle_id', p_circle_id, 'title_id', v_title.id));

    PERFORM record_revenue(
      p_source => 'leadership_game_margin', p_user_id => v_winner.user_id, p_reference_id => p_circle_id,
      p_gross_amount => v_pot, p_revenue_amount => v_pot - v_title.grand_prize, p_currency => 'USD',
      p_payment_method => 'wallet', p_original_currency => 'USD', p_original_amount => v_pot,
      p_metadata => jsonb_build_object('title_id', v_title.id, 'title', v_title.name)
    );

    INSERT INTO notifications (user_id, type, title, body, reference_id)
      VALUES (v_winner.user_id, 'leadership_game_won', 'You won ' || v_title.name || '!',
              'Final score: ' || v_winner.score || '. The $' || v_title.grand_prize || ' grand prize has been credited to your wallet.',
              p_circle_id);
  END IF;

  UPDATE game_circles
    SET status = 'completed', completed_at = now(),
        winner_id = v_winner.user_id, winner_score = v_winner.score, prize_paid = v_title.grand_prize
    WHERE id = p_circle_id;

  INSERT INTO notifications (user_id, type, title, body, reference_id)
    SELECT gp.user_id, 'leadership_game_ended', v_title.name || ' has ended',
      CASE WHEN gp.user_id = v_winner.user_id
        THEN 'You won this circle!'
        ELSE 'The circle is over. Final rank: #' || gp.rank || '. A new circle is now open to join.'
      END,
      p_circle_id
    FROM game_participants gp WHERE gp.circle_id = p_circle_id AND gp.user_id <> v_winner.user_id;

  -- ON CONFLICT is free insurance, not a fix for a live gap: the SELECT ...
  -- FOR UPDATE + "status <> 'active' THEN RETURN" guard at the top of this
  -- function already makes double-settlement impossible on its own (a
  -- second concurrent call blocks on that row lock, then sees status =
  -- 'completed' once it's released and returns before ever reaching this
  -- INSERT) -- same guarantee activate_leadership_circle's guard gives it,
  -- just expressed as an early exit instead of a conditional UPDATE.
  INSERT INTO game_circles (title_id, circle_number)
    VALUES (v_title.id, v_circle.circle_number + 1)
    ON CONFLICT (title_id, circle_number) DO NOTHING;
END;
$function$;

REVOKE ALL ON FUNCTION public.settle_leadership_circle(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.settle_leadership_circle(uuid) FROM anon, authenticated;

-- ── 15. sweep_leadership_games ───────────────────────────────────────────────
-- Called on an interval by the backend (see startLeadershipGamesSweepTimer in
-- routes/leadershipGamesRoutes.js), same pattern as runMarketplaceSweep /
-- sweep_expired_agent_orders. Settles any circle whose 30 days are up, and
-- makes sure every still-active circle has today's question set generated.
CREATE OR REPLACE FUNCTION public.sweep_leadership_games()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_circle record;
  v_day integer;
BEGIN
  FOR v_circle IN SELECT id FROM game_circles WHERE status = 'active' AND ends_at <= now() LOOP
    PERFORM settle_leadership_circle(v_circle.id);
  END LOOP;

  FOR v_circle IN SELECT id, activated_at FROM game_circles WHERE status = 'active' LOOP
    v_day := LEAST(30, GREATEST(1, FLOOR(EXTRACT(EPOCH FROM (now() - v_circle.activated_at)) / 86400)::int + 1));
    PERFORM generate_daily_questions(v_circle.id, v_day);
  END LOOP;
END;
$function$;

REVOKE ALL ON FUNCTION public.sweep_leadership_games() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sweep_leadership_games() FROM anon, authenticated;

-- ── 16. Seed the 12 titles ───────────────────────────────────────────────────
-- Prize = 65% of the pot (join_fee * group_size) throughout, for a
-- consistent ~35% platform margin on every title.
INSERT INTO game_titles (name, description, group_size, join_fee, grand_prize) VALUES
  ('Duel of Leaders',      '1v1, winner takes all.',                     2,    10, 13),
  ('Council of Five',      'Five compete, one walks away with it all.',  5,    10, 32),
  ('League of Ten',        'Ten players, one champion.',                 10,   8,  52),
  ('Circle of Fifteen',    'Fifteen players, one champion.',             15,   8,  78),
  ('Vision 20',            'Twenty players, one champion.',              20,   6,  78),
  ('Elite Thirty',         'Thirty players battle for the top spot.',    30,   6,  117),
  ('Council of Fifty',     'Fifty players battle for the top spot.',     50,   5,  162),
  ('Century League',       'A hundred players, one grand prize.',        100,  5,  325),
  ('Double Century Arena', 'Two hundred players, one grand prize.',      200,  3,  390),
  ('Titan 500',            'Five hundred players chase one jackpot.',    500,  2,  650),
  ('Millennium Masters',   'A thousand players chase one jackpot.',      1000, 2,  1300),
  ('Legends Assembly',     'Two thousand players, one legend.',          2000, 1,  1300)
ON CONFLICT (name) DO NOTHING;
