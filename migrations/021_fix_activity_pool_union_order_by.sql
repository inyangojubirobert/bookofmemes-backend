-- 019's generate_daily_questions wrapped the pooled UNION ALL directly as
-- `(%s ORDER BY random() LIMIT 10) s`, applying ORDER BY straight onto a
-- UNION query. Postgres rejects that: after a UNION/UNION ALL, ORDER BY can
-- only reference output column names/positions of the union, not arbitrary
-- expressions like random() -- confirmed live by calling
-- generate_daily_questions directly (2026-08-05): "invalid UNION/INTERSECT/
-- EXCEPT ORDER BY clause ... Only result column names can be used, not
-- expressions or functions." This is exactly why the "Duel of Leaders"
-- circle that activated right after 019 came back with zero rows in
-- game_daily_questions -- the query never ran to completion.
--
-- Fix (per the error's own hint): put the UNION ALL inside a derived table
-- first, then ORDER BY random() on a plain SELECT over that -- a plain
-- SELECT (not itself a UNION) has no such restriction.
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
         FROM (SELECT * FROM (%s) pool ORDER BY random() LIMIT 10) s$q$,
      p_circle_id, p_day_number, v_puzzle_pool
    );
  END IF;

  IF v_kids_pool IS NOT NULL THEN
    EXECUTE format(
      $q$INSERT INTO game_daily_questions
           (circle_id, day_number, source_table, source_id, question_text, image_url, correct_answer, incorrect_answers, question_order)
         SELECT %L, %L, src_table, id, question_text, image_url, correct_answer, incorrect_answers, 10 + row_number() OVER ()
         FROM (SELECT * FROM (%s) pool ORDER BY random() LIMIT 10) s$q$,
      p_circle_id, p_day_number, v_kids_pool
    );
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.generate_daily_questions(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.generate_daily_questions(uuid, integer) FROM anon, authenticated;
