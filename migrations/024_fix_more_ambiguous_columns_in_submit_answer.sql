-- 022 only qualified the bare `id` references in submit_leadership_answer,
-- but its RETURNS TABLE declares circle_id, daily_question_id, and user_id
-- as OUT parameters too -- and the function body had three more bare,
-- unqualified references to exactly those names (two EXISTS checks, one
-- UPDATE ... WHERE), each equally ambiguous for the same reason "id" was.
-- Confirmed live: "column reference \"circle_id\" is ambiguous" when
-- submitting an answer.
--
-- Lesson learned from missing these the first time: every bare identifier in
-- a RETURNS TABLE(...) function's body has to be checked against the FULL
-- list of declared OUT parameter names, not just whichever one happened to
-- error first -- fixing one occurrence doesn't mean the others aren't
-- lurking. get_leadership_daily_questions was re-checked against its own
-- full OUT parameter list (id, day_number, question_text, image_url,
-- options, already_answered) while writing this and has no other instances
-- of this bug -- its remaining bare `circle_id`/`user_id` references (in the
-- game_participants check) aren't ambiguous because neither name is one of
-- *that* function's declared OUT parameters.
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
  IF NOT EXISTS (SELECT 1 FROM game_participants gp WHERE gp.circle_id = v_circle.id AND gp.user_id = p_user_id) THEN
    RAISE EXCEPTION 'Not a participant in this game';
  END IF;
  IF EXISTS (SELECT 1 FROM game_answers ga WHERE ga.daily_question_id = p_daily_question_id AND ga.user_id = p_user_id) THEN
    RAISE EXCEPTION 'You already answered this question';
  END IF;

  v_correct := (p_selected_answer = v_question.correct_answer);

  INSERT INTO game_answers (circle_id, daily_question_id, user_id, selected_answer, is_correct)
    VALUES (v_circle.id, p_daily_question_id, p_user_id, p_selected_answer, v_correct)
    RETURNING * INTO v_answer;

  IF v_correct THEN
    UPDATE game_participants gp SET score = gp.score + 1, score_updated_at = now()
      WHERE gp.circle_id = v_circle.id AND gp.user_id = p_user_id;
  END IF;

  RETURN QUERY SELECT
    v_answer.id, v_answer.circle_id, v_answer.daily_question_id, v_answer.user_id,
    v_answer.selected_answer, v_answer.is_correct, v_answer.answered_at,
    v_question.correct_answer;
END;
$function$;
