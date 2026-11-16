-- Insert the 19 HomeStack stories (Black Diamond already exists in DB).
-- Matches the exact CTE structure of add_explore_stories.sql (5-column VALUES).

WITH admin AS (
  SELECT id FROM auth.users WHERE email = 'madrobert7@gmail.com' LIMIT 1
),
story_data (title, synopsis, category, cover_image_url, author_name) AS (
  VALUES
  ('Game of Betrayal',
   'Two lovers bound by a passionate affair find their connection tested when they are forced to compete in a game.',
   'romance',
   'https://res.cloudinary.com/dljcj00ht/image/upload/q_auto,f_auto/v1749547658/GAME_OF_BETRAYAL_jdbjpc.png',
   'Bascardo Storybox'),

  ('The Forbidden Dance',
   'A forbidden romance blossoms between a noblewoman and a commoner through their shared love of dance.',
   'romance',
   'https://res.cloudinary.com/dljcj00ht/image/upload/q_auto,f_auto/v1749548416/Forbidden_Dance_uljwqx.png',
   'Bascardo Storybox'),

  ('Heart of Deceit',
   'Laura gets married to the man of her dreams only to discover he is entangled in a web of lies and infidelity.',
   'drama',
   'https://res.cloudinary.com/dljcj00ht/image/upload/q_auto,f_auto/v1749550020/heart_of_Deceit_biz3cx.png',
   'Bascardo Storybox'),

  ('Lies of a Lover',
   'Emeka wins over Ayo but she finds she is being deceived - a trail of broken hearts and financial ruin uncovered.',
   'drama',
   'https://res.cloudinary.com/dljcj00ht/image/upload/q_auto,f_auto/v1749547705/lies_of_lover_gjuwhr.png',
   'Bascardo Storybox'),

  ('Love in Exile',
   'In a perilous land a passion for a rebel sparks a bloody revolution testing the loyalty of two lovers.',
   'romance',
   'https://res.cloudinary.com/dljcj00ht/image/upload/q_auto,f_auto/v1749548290/Love_in_exile_mo7qwj.png',
   'Bascardo Storybox'),

  ('Power Play',
   'Bassey seduces and blackmails rivals to gain wealth. Will a former lover expose his secrets before he destroys her?',
   'thriller',
   'https://res.cloudinary.com/dljcj00ht/image/upload/q_auto,f_auto/v1749547586/POWER_PLAY_t2esfx.png',
   'Bascardo Storybox'),

  ('Shadowed Silk',
   'A merchant apprentice sees her trading empire dreams threatened when she uncovers a counterfeit goods conspiracy.',
   'thriller',
   'https://res.cloudinary.com/dljcj00ht/image/upload/q_auto,f_auto/v1749550310/SHADOWED_SILK_ygw3rr.png',
   'Bascardo Storybox'),

  ('Dirty Money',
   'An accountant uncovers a money-laundering scheme. A family threat leads to greed, violence, and moral compromise.',
   'thriller',
   'https://res.cloudinary.com/dljcj00ht/image/upload/q_auto,f_auto/v1749548064/DIRTY_MONEY_ersumb.png',
   'Bascardo Storybox'),

  ('Eye for an Eye',
   'Framed, Adam spends years in prison plotting revenge with a plan that blurs justice and vengeance upon his release.',
   'thriller',
   'https://res.cloudinary.com/dljcj00ht/image/upload/q_auto,f_auto/v1749547696/EYE_FOR_EYE_rbvssa.png',
   'Bascardo Storybox'),

  ('The Obsession',
   'A billionaire obsessed with his lost love manipulates a woman who resembles her, setting off a dangerous game.',
   'romance',
   'https://res.cloudinary.com/dljcj00ht/image/upload/q_auto,f_auto/v1749547562/THE_OBSESSION_hq3ut7.png',
   'Bascardo Storybox'),

  ('Devils Contract',
   'John sells his soul for fame and fortune and pays a devastating price as his life unravels completely around him.',
   'thriller',
   'https://res.cloudinary.com/dljcj00ht/image/upload/q_auto,f_auto/v1752494804/Devils_contract_zyhgzk.png',
   'Bascardo Storybox'),

  ('Golden Heist',
   'A charismatic street performer aims to pull off the ultimate heist but an unexpected alliance complicates everything.',
   'thriller',
   'https://res.cloudinary.com/dljcj00ht/image/upload/q_auto,f_auto/v1749549711/Golden_heist_jhn853.png',
   'Bascardo Storybox'),

  ('Princess Amina',
   'Princess Amina learns hard lessons about money from her grandmother after going bankrupt and must rebuild an empire.',
   'drama',
   'https://res.cloudinary.com/dljcj00ht/image/upload/q_auto,f_auto/v1749549665/princess_amina_ngyfgv.png',
   'Bascardo Storybox'),

  ('City of Whispers',
   'A detective in a corrupt metropolis uncovers interconnected crimes leading to the city elite and their dark secrets.',
   'thriller',
   'https://res.cloudinary.com/dljcj00ht/image/upload/q_auto,f_auto/v1749549803/city_of_whispers_m8tkcn.png',
   'Bascardo Storybox'),

  ('The Pirates Daughter',
   'Raised in secrecy the daughter of a pirate king inherits her father legacy and his enemies to reclaim her place.',
   'adventure',
   'https://res.cloudinary.com/dljcj00ht/image/upload/q_auto,f_auto/v1749550191/the_pirates_daughter_b6bxum.png',
   'Bascardo Storybox'),

  ('The Social Climber',
   'Annabelle marries up but craves more power. Secret affairs and ruthless ambition threaten everything she has built.',
   'drama',
   'https://res.cloudinary.com/dljcj00ht/image/upload/q_auto,f_auto/v1749550217/The_social_climber_r2ifxh.png',
   'Bascardo Storybox'),

  ('Queen of Ponzi',
   'A woman from a once-prestigious family resorts to swindling to maintain her status until a young man investigates.',
   'thriller',
   'https://res.cloudinary.com/dljcj00ht/image/upload/q_auto,f_auto/v1749550012/Queen_of_Ponzi_uyzkjf.png',
   'Bascardo Storybox'),

  ('Ms Pink Smuggles',
   'From a family of smugglers, a young woman must protect her kin after her father is arrested by navigating a dangerous underworld.',
   'thriller',
   'https://res.cloudinary.com/dljcj00ht/image/upload/q_auto,f_auto/v1752494928/MS_PINK_SMUGGLES_rsg0kv.png',
   'Bascardo Storybox'),

  ('Shadow Links',
   'A journalist investigating mysterious disappearances uncovers a conspiracy reaching the highest levels of power.',
   'thriller',
   'https://res.cloudinary.com/dljcj00ht/image/upload/q_auto,f_auto/v1753085874/Shadow_LINKS_iy2xms.png',
   'Bascardo Storybox')
)
INSERT INTO stories (
  author_id, title, story_synopsis, story_category,
  description, cover_image_url, author_name, is_published
)
SELECT
  admin.id, sd.title, sd.synopsis, sd.category,
  sd.synopsis, sd.cover_image_url, sd.author_name, true
FROM story_data sd
CROSS JOIN admin
ON CONFLICT DO NOTHING;
