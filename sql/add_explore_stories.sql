-- ─── 1. Ensure stories table has the extra columns needed for Explore ────────
ALTER TABLE stories ADD COLUMN IF NOT EXISTS cover_image_url  text;
ALTER TABLE stories ADD COLUMN IF NOT EXISTS description       text;
ALTER TABLE stories ADD COLUMN IF NOT EXISTS author_name       text;
ALTER TABLE stories ADD COLUMN IF NOT EXISTS is_published      boolean DEFAULT true;
ALTER TABLE stories ADD COLUMN IF NOT EXISTS views_count       integer DEFAULT 0;
ALTER TABLE stories ADD COLUMN IF NOT EXISTS likes_count       integer DEFAULT 0;
ALTER TABLE stories ADD COLUMN IF NOT EXISTS bookmarks_count   integer DEFAULT 0;

-- ─── 2. Insert the 20 ExploreStack stories ────────────────────────────────────
-- NOT NULL columns that need values: author_id, story_synopsis, story_category
-- universal_item_type defaults to 'stories' so no need to supply it.

WITH admin AS (
  SELECT id FROM auth.users WHERE email = 'madrobert7@gmail.com' LIMIT 1
),
story_data (title, synopsis, category, cover_image_url, author_name) AS (
  VALUES
  ('Iron and Lies',
   'A boxing legend''s volatile marriage publicly unravels amidst accusations of abuse, betrayal, and a media storm that neither can escape.',
   'drama',
   'https://res.cloudinary.com/dljcj00ht/image/upload/q_auto,f_auto/v1752514401/IRON_AND_LIES_mhwe1y.png',
   'Bascardo Storybox'),

  ('The Outlaw',
   'Juls, captured by a fearsome outlaw, finds passionate love in the most unexpected circumstances — but freedom has a price.',
   'romance',
   'https://res.cloudinary.com/dljcj00ht/image/upload/q_auto,f_auto/v1752854447/THE_OUTLAW_zplso8.png',
   'Bascardo Storybox'),

  ('Music Billions',
   'A street musician''s billion-dollar rise exposes the dark secrets, jealousy, and betrayal lurking behind the spotlight.',
   'drama',    NULL, 'Bascardo Storybox'),

  ('Redemption Plan',
   'A man released after a decade in prison sets a meticulous plan in motion — but will revenge consume him before justice arrives?',
   'thriller', NULL, 'Bascardo Storybox'),

  ('Lion Pride',
   'In a cutthroat family dynasty, the eldest son must fight siblings, rivals, and his own conscience to protect the legacy.',
   'drama',    NULL, 'Bascardo Storybox'),

  ('City of Spies',
   'Two intelligence operatives from rival agencies are forced to collaborate — and resist an attraction neither can afford.',
   'thriller', NULL, 'Bascardo Storybox'),

  ('Fallen Favourite',
   'The darling of the internet loses everything overnight. Her journey back is messier, darker, and more honest than her rise.',
   'drama',    NULL, 'Bascardo Storybox'),

  ('Love Me Not',
   'He says all the right things. She knows better — yet every time she walks away, she finds herself walking back.',
   'romance',  NULL, 'Bascardo Storybox'),

  ('The Matrimony',
   'A lavish wedding hides a dangerous deal. Two strangers agree to marry for mutual gain — until feelings ruin everything.',
   'romance',  NULL, 'Bascardo Storybox'),

  ('The Girl is Mine',
   'When two childhood friends fall for the same woman, their brotherhood is put to its most brutal test.',
   'romance',  NULL, 'Bascardo Storybox'),

  ('The Price',
   'She agreed to be his fake fiancée — just for six months. No one told her hearts don''t read contracts.',
   'romance',  NULL, 'Bascardo Storybox'),

  ('The Downfall',
   'A corrupt politician''s empire begins to crack when his most loyal aide decides enough is enough.',
   'thriller', NULL, 'Bascardo Storybox'),

  ('Sugar Daddy',
   'She needed money. He needed company. They both needed something the arrangement could never provide.',
   'romance',  NULL, 'Bascardo Storybox'),

  ('Gold Digger',
   'She is called a gold digger — but the real story is far more complicated than the headlines suggest.',
   'romance',  NULL, 'Bascardo Storybox'),

  ('Secret Concubine',
   'In a palace of whispers, the secret wife must fight invisible wars to protect her child and her heart.',
   'romance',  NULL, 'Bascardo Storybox'),

  ('Runaway Bride',
   'She left him at the altar — twice. The third time, he is not giving her a choice.',
   'romance',  NULL, 'Bascardo Storybox'),

  ('The Rat',
   'When a trusted insider becomes an informant, loyalties in the city''s most feared crime family collapse overnight.',
   'thriller', NULL, 'Bascardo Storybox'),

  ('Second Chances',
   'They were each other''s greatest mistake. A decade later, fate deposits them in the same small town with no exit.',
   'romance',  NULL, 'Bascardo Storybox'),

  ('The Baker',
   'A small-town baker''s secret recipe becomes the centre of a corporate war — and the unexpected start of a love story.',
   'romance',  NULL, 'Bascardo Storybox'),

  ('Immortal Love',
   'He has lived for centuries waiting for her. She has been born again and again — and never remembers him.',
   'romance',  NULL, 'Bascardo Storybox')
)
INSERT INTO stories (
  author_id,
  title,
  story_synopsis,
  story_category,
  description,
  cover_image_url,
  author_name,
  is_published
)
SELECT
  admin.id,
  sd.title,
  sd.synopsis,
  sd.category,
  sd.synopsis,
  sd.cover_image_url,
  sd.author_name,
  true
FROM story_data sd
CROSS JOIN admin
ON CONFLICT DO NOTHING;

-- ─── 3. Verify ────────────────────────────────────────────────────────────────
SELECT id, title, story_category, cover_image_url IS NOT NULL AS has_cover
FROM stories
ORDER BY created_at DESC
LIMIT 25;
