-- Recovered from the bookofmemes-backend GitHub repo's independent migration
-- history (originally '015_meme_trivia_activity_image.sql') -- that repo accumulated its own migrations
-- (numbered 002-020 + add_currencies_table) in parallel with this local
-- checkout's own 001-024, both apparently run against the same live Supabase
-- project without ever being reconciled. Renumbered here (025+) to merge both
-- histories into one record without colliding filenames -- content unchanged.

-- Adds a media image column to meme_trivia_activity so each trivia question
-- can show a picture of the specific meme it's asking about -- the same
-- image + question + next-image flow Counting.js uses for kids, and the same
-- fix already applied to puzzles' Art Quiz (013_art_quiz_activity_image.sql).
-- MediaViewer.js already prefers question.image_url over question.question_text
-- when both are present, so no app code changes are needed here.
--
-- Nullable: existing text-only rows keep working (MediaViewer falls back to
-- question_text when image_url is null) until real images are attached.
ALTER TABLE meme_trivia_activity ADD COLUMN IF NOT EXISTS image_url text;

-- Once you have a real image URL for a question, set it like this (repeat
-- per question -- match on question_text):
-- UPDATE meme_trivia_activity
-- SET image_url = 'https://your-real-hosted-image-url'
-- WHERE question_text = 'What is the name of the meme featuring a dog sitting in a burning room saying "This is fine"?';

-- Verify
SELECT question_text, image_url FROM meme_trivia_activity ORDER BY created_at;
