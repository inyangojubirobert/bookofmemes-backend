-- Recovered from the bookofmemes-backend GitHub repo's independent migration
-- history (originally '014_memes_trivia_activity.sql') -- that repo accumulated its own migrations
-- (numbered 002-020 + add_currencies_table) in parallel with this local
-- checkout's own 001-024, both apparently run against the same live Supabase
-- project without ever being reconciled. Renumbered here (025+) to merge both
-- histories into one record without colliding filenames -- content unchanged.

-- Real quiz content for memes, using the same generic activity mechanism as
-- kids_collections (009) and puzzles' Art Quiz (012): get_random_activity()
-- looks up the backing table via content_activity_types and MediaViewer
-- renders whatever it returns as an image+multiple-choice quiz.
--
-- Wires up ONE real meme ("Social Memes") end to end -- text-only internet
-- meme-culture trivia (no image_url, same fallback MediaViewer already uses
-- for text-only kids/puzzle questions).

-- 1. Activity table for this quiz.
CREATE TABLE IF NOT EXISTS meme_trivia_activity (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id     uuid        NOT NULL REFERENCES memes(id) ON DELETE CASCADE,
  question_text     text        NOT NULL,
  correct_answer    text        NOT NULL,
  incorrect_answers jsonb       NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE meme_trivia_activity ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read access" ON meme_trivia_activity FOR SELECT USING (true);
GRANT SELECT ON meme_trivia_activity TO anon, authenticated;

-- 2. Real internet meme-culture trivia (10) for the "Social Memes" meme
-- (id 891c2242-4b77-4bcf-a2b5-8261075f01af, confirmed live).
INSERT INTO meme_trivia_activity (collection_id, question_text, correct_answer, incorrect_answers) VALUES
  ('891c2242-4b77-4bcf-a2b5-8261075f01af', 'What is the name of the meme featuring a dog sitting in a burning room saying "This is fine"?', 'This Is Fine', '["Distracted Boyfriend", "Woman Yelling at Cat", "Success Kid"]'),
  ('891c2242-4b77-4bcf-a2b5-8261075f01af', 'The "Distracted Boyfriend" meme is based on what kind of image?', 'A stock photo', '["A movie still", "A tweet screenshot", "A comic strip panel"]'),
  ('891c2242-4b77-4bcf-a2b5-8261075f01af', 'Which meme is based on a Shiba Inu dog and became associated with the cryptocurrency Dogecoin?', 'Doge', '["Grumpy Cat", "Success Kid", "This Is Fine"]'),
  ('891c2242-4b77-4bcf-a2b5-8261075f01af', '"Rickrolling" tricks someone into watching a music video by which artist?', 'Rick Astley', '["Rick James", "Bruno Mars", "Michael Jackson"]'),
  ('891c2242-4b77-4bcf-a2b5-8261075f01af', 'The "Woman Yelling at Cat" meme combines a reality TV screenshot with a photo of what?', 'A confused white cat at a dinner table', '["A dog in sunglasses", "A parrot", "A hamster"]'),
  ('891c2242-4b77-4bcf-a2b5-8261075f01af', '"Success Kid" is based on a real photo of what?', 'A baby clenching sand on a beach', '["A boy holding a trophy", "A kid doing homework", "A baby laughing"]'),
  ('891c2242-4b77-4bcf-a2b5-8261075f01af', 'The "Expanding Brain" meme format is typically used to represent what?', 'An escalating series of ideas', '["A recipe", "A workout routine", "A movie plot"]'),
  ('891c2242-4b77-4bcf-a2b5-8261075f01af', 'In internet meme slang, calling something "based" generally means what?', 'Being unapologetically yourself or agreeing with something', '["Being extremely angry", "Being confused", "Being sarcastic"]'),
  ('891c2242-4b77-4bcf-a2b5-8261075f01af', 'The "Spider-Man Pointing at Spider-Man" meme originally comes from what?', 'A 1967 Spider-Man cartoon episode', '["A Marvel comic book cover", "A 2002 Spider-Man movie", "A video game cutscene"]'),
  ('891c2242-4b77-4bcf-a2b5-8261075f01af', 'The "Two Buttons" sweating-decision meme character is typically shown doing what?', 'Sweating while choosing between two buttons', '["Flipping a coin", "Reading a book", "Running a race"]')
ON CONFLICT DO NOTHING;

-- 3. Register it so get_random_activity('memes', 'meme_trivia', ...) finds it.
INSERT INTO content_activity_types (item_type, activity_type, table_name)
VALUES ('memes', 'meme_trivia', 'meme_trivia_activity'::regclass)
ON CONFLICT (item_type, activity_type) DO NOTHING;

-- 4. Flip the meme row into quiz mode.
UPDATE memes
SET activity_type = 'meme_trivia'
WHERE id = '891c2242-4b77-4bcf-a2b5-8261075f01af' AND activity_type IS NULL;

-- Verify
SELECT m.title, m.activity_type, count(a.id) AS question_count
FROM memes m
LEFT JOIN meme_trivia_activity a ON a.collection_id = m.id
WHERE m.id = '891c2242-4b77-4bcf-a2b5-8261075f01af'
GROUP BY m.title, m.activity_type;
