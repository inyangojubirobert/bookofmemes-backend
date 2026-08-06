-- Recovered from the bookofmemes-backend GitHub repo's independent migration
-- history (originally '016_kids_collections_cover_images.sql') -- that repo accumulated its own migrations
-- (numbered 002-020 + add_currencies_table) in parallel with this local
-- checkout's own 001-024, both apparently run against the same live Supabase
-- project without ever being reconciled. Renumbered here (025+) to merge both
-- histories into one record without colliding filenames -- content unchanged.

-- Restores the unique per-activity cover images that lived in KidsBox.js's
-- original hardcoded trendingKids array before it was converted to a
-- DB-driven list (matching MemesBox.js/PuzzlesBox.js/StoryBox.js). Those
-- images were never fabricated -- they're the same real, already-hosted
-- Cloudinary URLs the app was already using -- they just never made it into
-- the database because kids_collections has no image column at all.
ALTER TABLE kids_collections ADD COLUMN IF NOT EXISTS cover_image_url text;

UPDATE kids_collections SET cover_image_url = 'https://res.cloudinary.com/dljcj00ht/image/upload/v1755468898/TimeTelling_gwyjxm.png' WHERE title = 'Time Telling';
UPDATE kids_collections SET cover_image_url = 'https://res.cloudinary.com/dljcj00ht/image/upload/v1755469005/Addition_and_subtraction_bvx0rr.png' WHERE title = 'Addition and Subtraction';
UPDATE kids_collections SET cover_image_url = 'https://res.cloudinary.com/dljcj00ht/image/upload/v1755469073/CountingActivity_kihqb7.png' WHERE title = 'Counting Activity';
UPDATE kids_collections SET cover_image_url = 'https://res.cloudinary.com/dljcj00ht/image/upload/v1755469161/AnimalHabitat_pluuey.png' WHERE title = 'Animal Habitat';
UPDATE kids_collections SET cover_image_url = 'https://res.cloudinary.com/dljcj00ht/image/upload/v1755429354/ObjectRecognition_svmgah.png' WHERE title = 'Object Recognition';
UPDATE kids_collections SET cover_image_url = 'https://res.cloudinary.com/dljcj00ht/image/upload/v1755430657/LandformRecognition_urlg0x.png' WHERE title = 'Landform Recognition';
UPDATE kids_collections SET cover_image_url = 'https://res.cloudinary.com/dljcj00ht/image/upload/v1755464568/CulturalIdentoty_rqt20n.png' WHERE title = 'Cultural Identity';
UPDATE kids_collections SET cover_image_url = 'https://res.cloudinary.com/dljcj00ht/image/upload/v1755437185/PresentPastTense_j5t5n3.png' WHERE title = 'Present Past Tense';
UPDATE kids_collections SET cover_image_url = 'https://res.cloudinary.com/dljcj00ht/image/upload/v1755440659/Vowelconsonants_lz0lpe.png' WHERE title = 'Vowels and Consonants';
UPDATE kids_collections SET cover_image_url = 'https://res.cloudinary.com/dljcj00ht/image/upload/v1755442275/TechHome_nn2fwb.png' WHERE title = 'Technology at Home';
UPDATE kids_collections SET cover_image_url = 'https://res.cloudinary.com/dljcj00ht/image/upload/v1755463397/EnglishAlphabets_iqffsn.png' WHERE title = 'English Alphabets';

-- Verify
SELECT title, cover_image_url FROM kids_collections ORDER BY (cover_image_url IS NULL), title;
