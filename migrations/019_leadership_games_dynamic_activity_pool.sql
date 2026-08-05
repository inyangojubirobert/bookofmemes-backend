-- generate_daily_questions only ever drew from puzzle_user_quiz_activity /
-- kids_user_quiz_activity, which turned out to be completely empty (0 rows
-- each, confirmed live 2026-08-05) -- every circle's daily question set came
-- back empty, showing as a blank "Today's questions aren't ready yet" screen
-- on activation.
--
-- The real content was there all along, just in different tables:
-- content_activity_types (item_type, activity_type, table_name) is a live
-- registry of EVERY quiz/activity table that exists per item type --
-- 'puzzles' has both puzzle_user_quiz_activity AND art_quiz_activity (10
-- rows), 'kids_collections' has both kids_user_quiz_activity AND
-- counting_activity (51 rows, e.g. the "Counting Activity" title). Nothing
-- in the Leadership Games schema was reading that registry -- this migration
-- makes generate_daily_questions look up every table content_activity_types
-- lists for 'puzzles'/'kids_collections' and pool across all of them,
-- instead of one hardcoded table per item type, so newly registered activity
-- types are picked up automatically without another code change here.
--
-- counting_activity has no question_text column (its "question" is just the
-- image -- count what's shown), unlike puzzle_user_quiz_activity/
-- kids_user_quiz_activity/art_quiz_activity which all have one -- the pool
-- builder below checks information_schema per table and substitutes
-- NULL::text where the column doesn't exist, rather than assuming every
-- registered activity table has an identical shape.

-- ── 1. game_daily_questions.source_table CHECK no longer makes sense ────────
-- It hardcoded the same two table names generate_daily_questions used to be
-- limited to. The valid set is now whatever content_activity_types lists --
-- a fixed enum CHECK can't express that, so this is dropped rather than
-- extended.
ALTER TABLE game_daily_questions DROP CONSTRAINT IF EXISTS game_daily_questions_source_table_check;

-- ── 2. build_leadership_activity_pool_sql (internal helper) ─────────────────
-- Returns one big `SELECT ... UNION ALL SELECT ...` fragment (as text) over
-- every table content_activity_types registers for p_item_type, each row
-- normalized to (id, question_text, image_url, correct_answer,
-- incorrect_answers, src_table). NULL if the item type has no registered
-- activity tables at all.
CREATE OR REPLACE FUNCTION public.build_leadership_activity_pool_sql(p_item_type text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row record;
  v_has_question_text boolean;
  v_fragments text[] := ARRAY[]::text[];
BEGIN
  FOR v_row IN SELECT table_name FROM content_activity_types WHERE item_type = p_item_type LOOP
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = v_row.table_name::text AND column_name = 'question_text'
    ) INTO v_has_question_text;

    v_fragments := array_append(v_fragments, format(
      'SELECT id, %s AS question_text, image_url, correct_answer, incorrect_answers, %L AS src_table FROM %s',
      CASE WHEN v_has_question_text THEN 'question_text' ELSE 'NULL::text' END,
      v_row.table_name::text,
      v_row.table_name
    ));
  END LOOP;

  IF array_length(v_fragments, 1) IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN array_to_string(v_fragments, ' UNION ALL ');
END;
$function$;

REVOKE ALL ON FUNCTION public.build_leadership_activity_pool_sql(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.build_leadership_activity_pool_sql(text) FROM anon, authenticated;

-- ── 3. generate_daily_questions, rewritten to pool dynamically ──────────────
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
         FROM (%s ORDER BY random() LIMIT 10) s$q$,
      p_circle_id, p_day_number, v_puzzle_pool
    );
  END IF;

  IF v_kids_pool IS NOT NULL THEN
    EXECUTE format(
      $q$INSERT INTO game_daily_questions
           (circle_id, day_number, source_table, source_id, question_text, image_url, correct_answer, incorrect_answers, question_order)
         SELECT %L, %L, src_table, id, question_text, image_url, correct_answer, incorrect_answers, 10 + row_number() OVER ()
         FROM (%s ORDER BY random() LIMIT 10) s$q$,
      p_circle_id, p_day_number, v_kids_pool
    );
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.generate_daily_questions(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.generate_daily_questions(uuid, integer) FROM anon, authenticated;
