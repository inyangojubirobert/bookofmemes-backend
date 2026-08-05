-- Images matter far more than text for this content -- questions are meant
-- to be asked IN the picture (counting_activity has no question_text column
-- at all; art_quiz_activity mixes both). Not just "prefer image rows" --
-- text-only rows (art_quiz_activity questions with no image_url yet) are
-- excluded outright via WHERE image_url IS NOT NULL. counting_activity's
-- image_url is NOT NULL at the schema level so every one of its rows always
-- qualifies; art_quiz_activity rows without an image simply won't be picked
-- until an image is added to them. If a pool has fewer than 10 image-bearing
-- rows, that day just gets fewer than 10 from that side rather than backfilling
-- with text -- same graceful-degradation behavior as an under-sized pool
-- already has elsewhere in this function.
CREATE OR REPLACE FUNCTION public.generate_daily_questions(p_circle_id uuid, p_day_number integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_puzzle_pool text;
  v_kids_pool text;
BEGIN
  IF EXISTS (SELECT 1 FROM game_daily_questions WHERE circle_id = p_circle_id AND day_number = p_day_number) THEN
    RETURN;
  END IF;

  v_puzzle_pool := build_leadership_activity_pool_sql('puzzles');
  v_kids_pool := build_leadership_activity_pool_sql('kids_collections');

  IF v_puzzle_pool IS NOT NULL THEN
    EXECUTE format(
      $q$INSERT INTO game_daily_questions
           (circle_id, day_number, source_table, source_id, question_text, image_url, correct_answer, incorrect_answers, question_order)
         SELECT %L, %L, src_table, id, question_text, image_url, correct_answer, incorrect_answers, row_number() OVER ()
         FROM (SELECT * FROM (%s) pool WHERE image_url IS NOT NULL ORDER BY random() LIMIT 10) s$q$,
      p_circle_id, p_day_number, v_puzzle_pool
    );
  END IF;

  IF v_kids_pool IS NOT NULL THEN
    EXECUTE format(
      $q$INSERT INTO game_daily_questions
           (circle_id, day_number, source_table, source_id, question_text, image_url, correct_answer, incorrect_answers, question_order)
         SELECT %L, %L, src_table, id, question_text, image_url, correct_answer, incorrect_answers, 10 + row_number() OVER ()
         FROM (SELECT * FROM (%s) pool WHERE image_url IS NOT NULL ORDER BY random() LIMIT 10) s$q$,
      p_circle_id, p_day_number, v_kids_pool
    );
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.generate_daily_questions(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.generate_daily_questions(uuid, integer) FROM anon, authenticated;
