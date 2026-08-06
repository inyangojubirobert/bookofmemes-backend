-- Recovered from the bookofmemes-backend GitHub repo's independent migration
-- history (originally '012_puzzles_art_quiz_activity.sql') -- that repo accumulated its own migrations
-- (numbered 002-020 + add_currencies_table) in parallel with this local
-- checkout's own 001-024, both apparently run against the same live Supabase
-- project without ever being reconciled. Renumbered here (025+) to merge both
-- histories into one record without colliding filenames -- content unchanged.

-- Real quiz content for puzzles, using the same generic activity mechanism
-- built for kids_collections (Backend/migrations/009_generic_content_activity_rpc.sql):
-- get_random_activity() looks up the backing table via content_activity_types
-- and MediaViewer renders whatever it returns as an image+multiple-choice quiz.
--
-- This migration wires up ONE real puzzle ("Art Quiz") end to end as a proof
-- of the pattern -- text-only trivia questions (no image_url), which
-- MediaViewer already falls back to rendering as question_text when an
-- activity row has no image (see Screens/HomeStack/universal/renderers/
-- MediaViewer.js: `question.question_text || question.title || "?"`).
--
-- To add another puzzle quiz later: repeat steps 1-4 for a different puzzle
-- row and a new/reused activity table -- no app code changes needed.

-- 1. Activity table for this quiz.
CREATE TABLE IF NOT EXISTS art_quiz_activity (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id     uuid        NOT NULL REFERENCES puzzles(id) ON DELETE CASCADE,
  question_text     text        NOT NULL,
  correct_answer    text        NOT NULL,
  incorrect_answers jsonb       NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE art_quiz_activity ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read access" ON art_quiz_activity FOR SELECT USING (true);
GRANT SELECT ON art_quiz_activity TO anon, authenticated;

-- 2. Real trivia questions (10) for the "Art Quiz" puzzle
-- (id 460ae538-2fd2-486e-8587-64ce924f128f, confirmed live).
INSERT INTO art_quiz_activity (collection_id, question_text, correct_answer, incorrect_answers) VALUES
  ('460ae538-2fd2-486e-8587-64ce924f128f', 'Who painted the Mona Lisa?', 'Leonardo da Vinci', '["Michelangelo", "Raphael", "Donatello"]'),
  ('460ae538-2fd2-486e-8587-64ce924f128f', 'Who painted The Starry Night?', 'Vincent van Gogh', '["Claude Monet", "Paul Cezanne", "Edvard Munch"]'),
  ('460ae538-2fd2-486e-8587-64ce924f128f', 'Who painted The Persistence of Memory, the painting with the melting clocks?', 'Salvador Dali', '["Rene Magritte", "Joan Miro", "Pablo Picasso"]'),
  ('460ae538-2fd2-486e-8587-64ce924f128f', 'Who painted Guernica?', 'Pablo Picasso', '["Georges Braque", "Henri Matisse", "Wassily Kandinsky"]'),
  ('460ae538-2fd2-486e-8587-64ce924f128f', 'Who painted The Scream?', 'Edvard Munch', '["Gustav Klimt", "Egon Schiele", "James Ensor"]'),
  ('460ae538-2fd2-486e-8587-64ce924f128f', 'Who painted the ceiling of the Sistine Chapel?', 'Michelangelo', '["Leonardo da Vinci", "Raphael", "Donato Bramante"]'),
  ('460ae538-2fd2-486e-8587-64ce924f128f', 'Who painted The Birth of Venus?', 'Sandro Botticelli', '["Titian", "Raphael", "Leonardo da Vinci"]'),
  ('460ae538-2fd2-486e-8587-64ce924f128f', 'Who painted Girl with a Pearl Earring?', 'Johannes Vermeer', '["Rembrandt van Rijn", "Frans Hals", "Jan Steen"]'),
  ('460ae538-2fd2-486e-8587-64ce924f128f', 'Which art movement is Claude Monet most associated with?', 'Impressionism', '["Cubism", "Surrealism", "Baroque"]'),
  ('460ae538-2fd2-486e-8587-64ce924f128f', 'Who painted American Gothic?', 'Grant Wood', '["Edward Hopper", "Norman Rockwell", "Thomas Hart Benton"]')
ON CONFLICT DO NOTHING;

-- 3. Register it so get_random_activity('puzzles', 'art_quiz', ...) finds it.
INSERT INTO content_activity_types (item_type, activity_type, table_name)
VALUES ('puzzles', 'art_quiz', 'art_quiz_activity'::regclass)
ON CONFLICT (item_type, activity_type) DO NOTHING;

-- 4. Flip the puzzle row into quiz mode.
UPDATE puzzles
SET activity_type = 'art_quiz'
WHERE id = '460ae538-2fd2-486e-8587-64ce924f128f' AND activity_type IS NULL;

-- Verify
SELECT p.title, p.activity_type, count(a.id) AS question_count
FROM puzzles p
LEFT JOIN art_quiz_activity a ON a.collection_id = p.id
WHERE p.id = '460ae538-2fd2-486e-8587-64ce924f128f'
GROUP BY p.title, p.activity_type;
