-- The gameplay screen needs to tell the user the right answer after they
-- get a question wrong (same "reveal after you've locked in an attempt"
-- pattern MediaViewer.js uses for the casual practice quiz). But
-- get_leadership_daily_questions deliberately never sends correct_answer to
-- the client (it's mixed unlabeled into `options` -- see that function's own
-- comment), and submit_leadership_answer only returned the game_answers row,
-- which doesn't store the correct answer text either -- so there was no
-- source for that text at all on the client. Safe to add here specifically:
-- by the time this function runs, the UNIQUE (daily_question_id, user_id)
-- constraint has already locked in that this was the user's one attempt at
-- this question, so revealing the answer now can't enable cheating on it.
--
-- Changing the return shape (adding a column) requires DROP + CREATE, not
-- CREATE OR REPLACE -- Postgres doesn't allow changing a function's declared
-- return type in place.
DROP FUNCTION IF EXISTS public.submit_leadership_answer(uuid, uuid, text);

CREATE FUNCTION public.submit_leadership_answer(p_daily_question_id uuid, p_user_id uuid, p_selected_answer text)
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

  SELECT * INTO v_question FROM game_daily_questions WHERE id = p_daily_question_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Question not found';
  END IF;

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

  RETURN QUERY SELECT
    v_answer.id, v_answer.circle_id, v_answer.daily_question_id, v_answer.user_id,
    v_answer.selected_answer, v_answer.is_correct, v_answer.answered_at,
    v_question.correct_answer;
END;
$function$;
