-- Recovered from the bookofmemes-backend GitHub repo's independent migration
-- history (originally '013_art_quiz_activity_image.sql') -- that repo accumulated its own migrations
-- (numbered 002-020 + add_currencies_table) in parallel with this local
-- checkout's own 001-024, both apparently run against the same live Supabase
-- project without ever being reconciled. Renumbered here (025+) to merge both
-- histories into one record without colliding filenames -- content unchanged.

-- Adds a media image column to art_quiz_activity so each trivia question can
-- show the painting it's asking about (MediaViewer.js already prefers
-- question.image_url over question.question_text when both are present --
-- see Screens/HomeStack/universal/renderers/MediaViewer.js).
--
-- Nullable: existing text-only rows keep working (MediaViewer falls back to
-- question_text when image_url is null), and new questions can be inserted
-- with or without an image.
ALTER TABLE art_quiz_activity ADD COLUMN IF NOT EXISTS image_url text;

-- Once you have a real image URL for a question, set it like this (repeat
-- per question -- match on question_text, or on id if you have it):
-- UPDATE art_quiz_activity
-- SET image_url = 'https://your-real-hosted-image-url'
-- WHERE question_text = 'Who painted the Mona Lisa?';

-- Verify
SELECT question_text, image_url FROM art_quiz_activity ORDER BY created_at;
