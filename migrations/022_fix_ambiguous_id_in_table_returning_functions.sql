-- "column reference \"id\" is ambiguous" -- a real, pre-existing bug, not
-- something 020 introduced. Any function declared `RETURNS TABLE (id uuid,
-- ...)` gets an implicit PL/pgSQL OUT-parameter variable literally named
-- `id` in scope for its entire body. Both functions below have a bare,
-- unqualified `WHERE id = ...` inside that same body -- Postgres can't tell
-- whether `id` means the table column or the OUT parameter, and errors
-- instead of guessing (this is Postgres's actual default behavior,
-- `#variable_conflict error`, not a one-off glitch).
--
-- get_leadership_daily_questions has had this bug since it was first written
-- in 016 -- it just never got exercised successfully until now (blocked
-- first by the wallet_transactions_type_check bug, then by the empty
-- content pool, then by the UNION/ORDER BY bug, then by a missing .catch()
-- masking whatever error came back). This is the first time it's actually
-- run against real data. submit_leadership_answer's version of the same bug
-- is new to 020, which is what first gave it a `RETURNS TABLE` signature
-- (its original 016 signature was `RETURNS game_answers`, a whole-row
-- composite type -- that style does NOT create named OUT-parameter
-- variables, so it was never at risk of this).
--
-- Fix: qualify every WHERE-clause `id` with a table alias. No signature
-- change on either function, so CREATE OR REPLACE is enough this time (no
-- DROP needed).

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
  SELECT * INTO v_circle FROM game_circles gc WHERE gc.id = p_circle_id;
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

CREATE OR REPLACE FUNCTION public.submit_leadership_answer(p_daily_question_id uuid, p_user_id uuid, p_selected_answer text)
 RETURNS TABLE (
   id uuid, circle_id uuid, daily_question_id uuid, user_id uuid,
   selected_answer text, is_correct boolean, answered_at timestamptz,
   correct_answer text
 )
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

  SELECT * INTO v_question FROM game_daily_questions gdq WHERE gdq.id = p_daily_question_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Question not found';
  END IF;

  SELECT * INTO v_circle FROM game_circles gc WHERE gc.id = v_question.circle_id;
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

  RETURN QUERY SELECT
    v_answer.id, v_answer.circle_id, v_answer.daily_question_id, v_answer.user_id,
    v_answer.selected_answer, v_answer.is_correct, v_answer.answered_at,
    v_question.correct_answer;
END;
$function$;
