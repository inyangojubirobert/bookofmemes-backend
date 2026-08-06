-- Recovered from the bookofmemes-backend GitHub repo's independent migration
-- history (originally '010_seed_content.sql') -- that repo accumulated its own migrations
-- (numbered 002-020 + add_currencies_table) in parallel with this local
-- checkout's own 001-024, both apparently run against the same live Supabase
-- project without ever being reconciled. Renumbered here (025+) to merge both
-- histories into one record without colliding filenames -- content unchanged.

-- Seed data for kids_collections, memes, and puzzles so the new DB-driven
-- MemesBox/PuzzlesBox/KidsBox lists have real content to display.
-- Author: Bascardo Originals (existing seed account used by all current content).

-- kids_collections (50 rows)
-- activity_type is set for forward-compatibility with the content_activity_types
-- registry (Backend/migrations/009_generic_content_activity_rpc.sql) -- until a
-- matching table+registry row exists, MediaViewer will show "not configured yet"
-- for these, same as any unregistered activity type.
INSERT INTO kids_collections (title, description, type, universal_item_type, author_id, activity_type) VALUES
  ('Time Telling', 'Time-telling activities for kids involve using clock visuals to teach concepts like hours and minutes. They build essential life skills like punctuality and time management, fostering independence and boosting cognitive and mathematical abilities.', 'for kids', 'kids_collections', '4ba236d0-ea0c-4539-9755-d6bf52b708d5', 'time_telling'),
  ('Addition and Subtraction', 'Adding and subtracting with visuals makes math fun and understandable for kids! These activities build strong number sense and problem-solving skills, making complex concepts easy to grasp.', 'for kids', 'kids_collections', '4ba236d0-ea0c-4539-9755-d6bf52b708d5', 'addition_subtraction'),
  ('Animal Habitat', 'Visual activities about animal habitats help kids understand diverse environments and the animals that live there. They boost environmental awareness, spark curiosity, and empathy for wildlife, making learning engaging and memorable.', 'for kids', 'kids_collections', '4ba236d0-ea0c-4539-9755-d6bf52b708d5', 'animal_habitat'),
  ('Object Recognition', 'Engaging kids with Object Recognition Visual activities help kids identify and differentiate objects, boosting critical thinking, memory, and language. This foundational skill empowers confident learning and understanding of their world.', 'for kids', 'kids_collections', '4ba236d0-ea0c-4539-9755-d6bf52b708d5', 'object_recognition'),
  ('Landform Recognition', 'Through captivating visuals, children learn to identify diverse landscapes: mountains, rivers, and valleys, alongside various living spaces and structures. This builds spatial awareness and broadens their appreciation for our world''s natural and human-made wonders.', 'for kids', 'kids_collections', '4ba236d0-ea0c-4539-9755-d6bf52b708d5', 'landform_recognition'),
  ('Cultural Identity', 'Engaging children with visuals that introduce them to diverse cultural identities through food, clothing, traditions, and art. This fosters empathy, respect, and a rich understanding of our interconnected global community.', 'for kids', 'kids_collections', '4ba236d0-ea0c-4539-9755-d6bf52b708d5', 'cultural_identity'),
  ('Present Past Tense', 'Using visuals to help kids differentiate between current actions and past events builds essential grammar skills, fostering clear communication and strengthening storytelling abilities.', 'for kids', 'kids_collections', '4ba236d0-ea0c-4539-9755-d6bf52b708d5', 'present_past_tense'),
  ('Vowels and Consonants', 'Visually engaging activities that help children differentiate between vowels and consonants, building foundational phonics and spelling skills. This supports early reading, enhances decoding abilities, and promotes overall literacy development.', 'for kids', 'kids_collections', '4ba236d0-ea0c-4539-9755-d6bf52b708d5', 'vowels_consonants'),
  ('Technology at Home', 'Engaging visuals that introduce children to everyday technology, including home appliances and smartphones. This promotes digital literacy, enhances problem-solving skills, and encourages responsible interaction with the digital world, preparing them for the future.', 'for kids', 'kids_collections', '4ba236d0-ea0c-4539-9755-d6bf52b708d5', 'technology_at_home'),
  ('English Alphabets', 'Engaging Visuals for The English alphabet, which is a foundational tool for communication and literacy, enabling expression, preserving knowledge, and fostering global connectivity and understanding.', 'for kids', 'kids_collections', '4ba236d0-ea0c-4539-9755-d6bf52b708d5', 'english_alphabets'),
  ('Human Emotions', 'Engaging visual activities that help children recognize emotions, fostering empathy, self-regulation, and overall well-being.', 'for kids', 'kids_collections', '4ba236d0-ea0c-4539-9755-d6bf52b708d5', 'human_emotions'),
  ('Kid Finance', 'Early financial education empowers kids with money sense, smart decision-making, and early financial independence.', 'for kids', 'kids_collections', '4ba236d0-ea0c-4539-9755-d6bf52b708d5', 'kid_finance'),
  ('Shape Recognition', 'Engaging shape activities help children recognize forms, enhancing visual perception and essential math skills.', 'for kids', 'kids_collections', '4ba236d0-ea0c-4539-9755-d6bf52b708d5', 'shape_recognition'),
  ('Colour Recognition', 'Engaging activities that help children identify colors, enhancing cognitive skills, language development, and visual perception.', 'for kids', 'kids_collections', '4ba236d0-ea0c-4539-9755-d6bf52b708d5', 'colour_recognition'),
  ('Phonics', 'Engaging phonics activities that teach letter-sound connections, enabling children to decode words and read fluently.', 'for kids', 'kids_collections', '4ba236d0-ea0c-4539-9755-d6bf52b708d5', 'phonics'),
  ('Rythm and Words', 'Engaging rhythm and word activities that enhance phonological awareness and literacy skills, nurturing a lifelong love for language.', 'for kids', 'kids_collections', '4ba236d0-ea0c-4539-9755-d6bf52b708d5', 'rhythm_words'),
  ('Food Groups/Sources', 'Food group visuals that educate children on healthy eating by helping them identify nutritious sources for balanced diets.', 'for kids', 'kids_collections', '4ba236d0-ea0c-4539-9755-d6bf52b708d5', 'food_groups'),
  ('Simple Multiplication', 'Fun visuals help kids grasp simple multiplication, building foundational math skills, problem-solving abilities, and number sense.', 'for kids', 'kids_collections', '4ba236d0-ea0c-4539-9755-d6bf52b708d5', 'simple_multiplication'),
  ('Simple Division', 'Visual activities for kids make simple division concrete by helping them share and group objects. This builds foundational math skills.', 'for kids', 'kids_collections', '4ba236d0-ea0c-4539-9755-d6bf52b708d5', 'simple_division'),
  ('Fruit Recognition', 'Vibrant visuals help kids recognize fruits, promoting healthy eating habits, vocabulary growth, and sensory exploration.', 'for kids', 'kids_collections', '4ba236d0-ea0c-4539-9755-d6bf52b708d5', 'fruit_recognition'),
  ('Plant Life', 'Visuals that help kids explore plant life cycles, parts, and needs. This builds scientific curiosity, observation skills, and a love for nature.', 'for kids', 'kids_collections', '4ba236d0-ea0c-4539-9755-d6bf52b708d5', 'plant_life'),
  ('Life Cycles', 'Captivating Visuals that teach kids about nature''s cycles, building understanding of growth, change, and the natural world''s wonders.', 'for kids', 'kids_collections', '4ba236d0-ea0c-4539-9755-d6bf52b708d5', 'life_cycles'),
  ('Weather Forecasting', 'Engaging visuals that help children recognize weather patterns, enhancing observation skills, curiosity, and understanding of nature.', 'for kids', 'kids_collections', '4ba236d0-ea0c-4539-9755-d6bf52b708d5', 'weather_forecasting'),
  ('The Human Body', 'Activities that help kids recognize human body parts, their functions, and appreciate the health and capabilities of their amazing bodies.', 'for kids', 'kids_collections', '4ba236d0-ea0c-4539-9755-d6bf52b708d5', 'human_body'),
  ('Human Sense Organ', 'Engaging visuals that encourage children to explore their five senses, enhancing body awareness and their sensory vocabulary.', 'for kids', 'kids_collections', '4ba236d0-ea0c-4539-9755-d6bf52b708d5', 'human_sense_organ'),
  ('Magnets', 'Children learn how magnets attract and repel each other, which builds foundational physics concepts and magnetism.', 'for kids', 'kids_collections', '4ba236d0-ea0c-4539-9755-d6bf52b708d5', 'magnets'),
  ('Day/Night Activities', 'Visual aids that help children recognize daily routines, enhance time management, and foster connections with the world.', 'for kids', 'kids_collections', '4ba236d0-ea0c-4539-9755-d6bf52b708d5', 'day_night'),
  ('Health and Hygiene', 'Engaging visuals that teach children essential health and hygiene habits, establishing lifelong routines for a healthy and happy life.', 'for kids', 'kids_collections', '4ba236d0-ea0c-4539-9755-d6bf52b708d5', 'health_hygiene'),
  ('Modes of Transport', 'Visuals that engage children in identifying transportation modes and a keen understanding of how things move in the world.', 'for kids', 'kids_collections', '4ba236d0-ea0c-4539-9755-d6bf52b708d5', 'modes_of_transport'),
  ('Animal Sounds', 'Connecting animals to their sounds aids children in learning phonics, vocabulary, and memory skills in a fun and engaging way.', 'for kids', 'kids_collections', '4ba236d0-ea0c-4539-9755-d6bf52b708d5', 'animal_sounds'),
  ('Historical Figures', 'Visual activities that introduce children to historical figures, recognize achievements, and foster appreciation for the past.', 'for kids', 'kids_collections', '4ba236d0-ea0c-4539-9755-d6bf52b708d5', 'historical_figures'),
  ('Flag/Symbol Identity', 'Engaging activities with flags and symbols that help children understand national identity and geography, promoting global awareness.', 'for kids', 'kids_collections', '4ba236d0-ea0c-4539-9755-d6bf52b708d5', 'flag_symbol_identity'),
  ('Famous Landmarks', 'Engaging visuals that introduce children to global landmarks, sparking curiosity, and a deeper appreciation for world history.', 'for kids', 'kids_collections', '4ba236d0-ea0c-4539-9755-d6bf52b708d5', 'famous_landmarks'),
  ('Family Trees', 'Using visuals to create family trees helps children understand their heritage, strengthen family bonds, and feel a sense of belonging.', 'for kids', 'kids_collections', '4ba236d0-ea0c-4539-9755-d6bf52b708d5', 'family_trees'),
  ('Daily Routines', 'Visual aids that help children understand daily routines, fostering independence, time management skills, and a sense of security.', 'for kids', 'kids_collections', '4ba236d0-ea0c-4539-9755-d6bf52b708d5', 'daily_routines'),
  ('Quantitative Aptitude', 'Activities that use visuals to enhance a kid''s number sense and problem-solving abilities, for a solid mathematical foundation.', 'for kids', 'kids_collections', '4ba236d0-ea0c-4539-9755-d6bf52b708d5', 'aptitude'),
  ('Object Positions', 'Visualizing the positions of objects helps children understand their relationships, fostering essential spatial reasoning skills.', 'for kids', 'kids_collections', '4ba236d0-ea0c-4539-9755-d6bf52b708d5', 'object_positions'),
  ('Size Comparisons', 'Engaging activities that help children compare objects of different sizes, build math skills, and develop critical thinking.', 'for kids', 'kids_collections', '4ba236d0-ea0c-4539-9755-d6bf52b708d5', 'comparison'),
  ('Simple Machines', 'Recognising simple machines visually helps kids grasp physics concepts, building foundational problem-solving skills.', 'for kids', 'kids_collections', '4ba236d0-ea0c-4539-9755-d6bf52b708d5', 'simple_machines'),
  ('Singular and Plurals', 'Engaging activities that help kids learn singular and plural forms, enhancing their language skills, vocabulary, and written communication.', 'for kids', 'kids_collections', '4ba236d0-ea0c-4539-9755-d6bf52b708d5', 'singular_plurals'),
  ('Social Activities', 'Visuals that promote social skills, like sharing, cooperation, friendship, and confidence, for positive interactions among children.', 'for kids', 'kids_collections', '4ba236d0-ea0c-4539-9755-d6bf52b708d5', 'social_activities'),
  ('Traffic Recognition', 'Children learn about road signs and signals through engaging visual activities, which helps them develop essential safety awareness for life.', 'for kids', 'kids_collections', '4ba236d0-ea0c-4539-9755-d6bf52b708d5', 'traffic_recognition'),
  ('The Human Calendar', 'This engaging visual activity helps children understand days, weeks, and months, making abstract concepts of time more tangible.', 'for kids', 'kids_collections', '4ba236d0-ea0c-4539-9755-d6bf52b708d5', 'human_calendar'),
  ('Classification of Things', 'Sorting and grouping objects visually helps kids categorize and classify, which enhances organizational skills.', 'for kids', 'kids_collections', '4ba236d0-ea0c-4539-9755-d6bf52b708d5', 'classification'),
  ('Christian Stories', 'Engaging stories that teach children core Christian values, fostering a strong foundation of faith and moral character.', 'for kids', 'kids_collections', '4ba236d0-ea0c-4539-9755-d6bf52b708d5', 'christian_stories'),
  ('Islamic Stories', 'Visually exploring Islamic stories and teachings that build a child''s faith, character, and love for Allah.', 'for kids', 'kids_collections', '4ba236d0-ea0c-4539-9755-d6bf52b708d5', 'islamic_stories'),
  ('Words and Opposites', 'Visuals that aid children connect opposite words, enhancing their vocabulary and conceptual understanding.', 'for kids', 'kids_collections', '4ba236d0-ea0c-4539-9755-d6bf52b708d5', 'words_opposites'),
  ('Synonyms', 'Visual activities that assist children in recognizing words similar in meaning, expanding vocabulary, and communication.', 'for kids', 'kids_collections', '4ba236d0-ea0c-4539-9755-d6bf52b708d5', 'synonyms'),
  ('Verbs', 'Visuals that engage children in learning action words enhance vocabulary, enabling expression of movement and ideas.', 'for kids', 'kids_collections', '4ba236d0-ea0c-4539-9755-d6bf52b708d5', 'verbs'),
  ('Measurements', 'Children learn to measure through visuals that build foundational math skills and an understanding of size, length, and weight.', 'for kids', 'kids_collections', '4ba236d0-ea0c-4539-9755-d6bf52b708d5', 'measurements')
ON CONFLICT DO NOTHING;

-- memes (9 rows)
-- image_url is NOT NULL on this table and there are no real per-meme images
-- yet, so every row shares the "Memes" category cover already used in
-- Screens/ExploreStack/ExploreScreen.js (CATEGORY_CONFIG.memes.coverUri) as a
-- placeholder -- swap in real images per row later.
INSERT INTO memes (title, description, image_url, universal_item_type, author_id) VALUES
  ('Hunger Memes', 'Relatable memes about being hangry and raiding the fridge at 2am.', 'https://res.cloudinary.com/dljcj00ht/image/upload/q_auto,f_auto/v1749551287/Memes_collection_dlvmrr.png', 'memes', '4ba236d0-ea0c-4539-9755-d6bf52b708d5'),
  ('Dating Memes', 'The chaos, cringe, and comedy of modern dating, in meme form.', 'https://res.cloudinary.com/dljcj00ht/image/upload/q_auto,f_auto/v1749551287/Memes_collection_dlvmrr.png', 'memes', '4ba236d0-ea0c-4539-9755-d6bf52b708d5'),
  ('Rejection Memes', 'Turning the sting of rejection into something worth laughing about.', 'https://res.cloudinary.com/dljcj00ht/image/upload/q_auto,f_auto/v1749551287/Memes_collection_dlvmrr.png', 'memes', '4ba236d0-ea0c-4539-9755-d6bf52b708d5'),
  ('Overthinker Memes', 'For everyone who''s replayed one conversation 40 times before bed.', 'https://res.cloudinary.com/dljcj00ht/image/upload/q_auto,f_auto/v1749551287/Memes_collection_dlvmrr.png', 'memes', '4ba236d0-ea0c-4539-9755-d6bf52b708d5'),
  ('Procrastinate', 'Memes for the ''I''ll do it tomorrow'' crowd.', 'https://res.cloudinary.com/dljcj00ht/image/upload/q_auto,f_auto/v1749551287/Memes_collection_dlvmrr.png', 'memes', '4ba236d0-ea0c-4539-9755-d6bf52b708d5'),
  ('Routine Memes', 'The mundane, repetitive comedy of everyday routines.', 'https://res.cloudinary.com/dljcj00ht/image/upload/q_auto,f_auto/v1749551287/Memes_collection_dlvmrr.png', 'memes', '4ba236d0-ea0c-4539-9755-d6bf52b708d5'),
  ('Social Memes', 'Awkward social situations, immortalized as memes.', 'https://res.cloudinary.com/dljcj00ht/image/upload/q_auto,f_auto/v1749551287/Memes_collection_dlvmrr.png', 'memes', '4ba236d0-ea0c-4539-9755-d6bf52b708d5'),
  ('Family Memes', 'Family group chats, sibling chaos, and everything in between.', 'https://res.cloudinary.com/dljcj00ht/image/upload/q_auto,f_auto/v1749551287/Memes_collection_dlvmrr.png', 'memes', '4ba236d0-ea0c-4539-9755-d6bf52b708d5'),
  ('Friendship Memes', 'The unspoken language only your closest friends understand.', 'https://res.cloudinary.com/dljcj00ht/image/upload/q_auto,f_auto/v1749551287/Memes_collection_dlvmrr.png', 'memes', '4ba236d0-ea0c-4539-9755-d6bf52b708d5')
ON CONFLICT DO NOTHING;

-- puzzles (40 rows) -- no image column exists on this table
INSERT INTO puzzles (title, description, universal_item_type, author_id) VALUES
  ('Acrostic Puzzle', 'Solve word puzzles where the first letters of each line spell out a hidden word.', 'puzzles', '4ba236d0-ea0c-4539-9755-d6bf52b708d5'),
  ('Anomaly Puzzle', 'Spot the one element that doesn''t belong among a set of similar images.', 'puzzles', '4ba236d0-ea0c-4539-9755-d6bf52b708d5'),
  ('Art Quiz', 'Test your knowledge of famous artworks and the artists behind them.', 'puzzles', '4ba236d0-ea0c-4539-9755-d6bf52b708d5'),
  ('Celebrity Guess', 'Guess the celebrity from a zoomed-in or obscured photo.', 'puzzles', '4ba236d0-ea0c-4539-9755-d6bf52b708d5'),
  ('Coded Message', 'Crack a coded message using visual and logic clues.', 'puzzles', '4ba236d0-ea0c-4539-9755-d6bf52b708d5'),
  ('Color Blind', 'A color-perception challenge inspired by classic color-blindness tests.', 'puzzles', '4ba236d0-ea0c-4539-9755-d6bf52b708d5'),
  ('Color Palette', 'Enhances visual perception and color theory understanding through palette-matching challenges.', 'puzzles', '4ba236d0-ea0c-4539-9755-d6bf52b708d5'),
  ('DHidden Object', 'A dark-themed hidden object hunt for sharp-eyed players.', 'puzzles', '4ba236d0-ea0c-4539-9755-d6bf52b708d5'),
  ('Dominoe Puzzle', 'Classic domino-matching logic puzzles.', 'puzzles', '4ba236d0-ea0c-4539-9755-d6bf52b708d5'),
  ('Emoji Charade', 'Guess the phrase or title from a string of emojis.', 'puzzles', '4ba236d0-ea0c-4539-9755-d6bf52b708d5'),
  ('Fill Blank', 'Complete the picture or phrase by filling in the missing piece.', 'puzzles', '4ba236d0-ea0c-4539-9755-d6bf52b708d5'),
  ('Find Duplicate', 'Spot the two identical images hidden among many similar ones.', 'puzzles', '4ba236d0-ea0c-4539-9755-d6bf52b708d5'),
  ('Find Impostor', 'Identify the odd one out disguised among a group of look-alikes.', 'puzzles', '4ba236d0-ea0c-4539-9755-d6bf52b708d5'),
  ('Guess Brand', 'Guess the brand from a cropped or stylized logo.', 'puzzles', '4ba236d0-ea0c-4539-9755-d6bf52b708d5'),
  ('Hidden Object', 'Search busy scenes to find a list of hidden objects.', 'puzzles', '4ba236d0-ea0c-4539-9755-d6bf52b708d5'),
  ('Hidden Path', 'Trace the correct hidden path through a visual maze.', 'puzzles', '4ba236d0-ea0c-4539-9755-d6bf52b708d5'),
  ('Hitori Puzzle', 'A classic Hitori number-elimination logic puzzle.', 'puzzles', '4ba236d0-ea0c-4539-9755-d6bf52b708d5'),
  ('Icon Puzzle', 'Guess the word or phrase represented by a set of icons.', 'puzzles', '4ba236d0-ea0c-4539-9755-d6bf52b708d5'),
  ('Image Anagram', 'Rearrange scrambled image tiles to reveal the original picture.', 'puzzles', '4ba236d0-ea0c-4539-9755-d6bf52b708d5'),
  ('Image Crop', 'Guess the full image from a small cropped section.', 'puzzles', '4ba236d0-ea0c-4539-9755-d6bf52b708d5'),
  ('Image Riddle', 'Solve visual riddles hidden inside an image.', 'puzzles', '4ba236d0-ea0c-4539-9755-d6bf52b708d5'),
  ('Image Word', 'Match pictures to the words that describe them.', 'puzzles', '4ba236d0-ea0c-4539-9755-d6bf52b708d5'),
  ('Logic Puzzle', 'Classic logic-grid puzzles that test deduction skills.', 'puzzles', '4ba236d0-ea0c-4539-9755-d6bf52b708d5'),
  ('Maze Puzzle', 'Navigate through increasingly tricky mazes.', 'puzzles', '4ba236d0-ea0c-4539-9755-d6bf52b708d5'),
  ('Mosaic Maker', 'Boosts spatial reasoning and creativity by piecing together colorful mosaic patterns.', 'puzzles', '4ba236d0-ea0c-4539-9755-d6bf52b708d5'),
  ('Pattern Match', 'Find and match repeating visual patterns.', 'puzzles', '4ba236d0-ea0c-4539-9755-d6bf52b708d5'),
  ('Pattern Memory', 'Memorize and repeat an increasingly complex visual pattern.', 'puzzles', '4ba236d0-ea0c-4539-9755-d6bf52b708d5'),
  ('Pattern Recog', 'Spot the rule behind a sequence and pick what comes next.', 'puzzles', '4ba236d0-ea0c-4539-9755-d6bf52b708d5'),
  ('Photo Hunt', 'Compare two near-identical photos and spot the differences.', 'puzzles', '4ba236d0-ea0c-4539-9755-d6bf52b708d5'),
  ('Picture Quiz', 'Answer trivia questions based on a revealed picture.', 'puzzles', '4ba236d0-ea0c-4539-9755-d6bf52b708d5'),
  ('Rebus', 'Classic rebus puzzles where pictures and symbols represent words or phrases.', 'puzzles', '4ba236d0-ea0c-4539-9755-d6bf52b708d5'),
  ('Riddle Puzzle', 'Classic riddles paired with visual clues.', 'puzzles', '4ba236d0-ea0c-4539-9755-d6bf52b708d5'),
  ('Shape Puzzle', 'Fit and match shapes to complete each puzzle.', 'puzzles', '4ba236d0-ea0c-4539-9755-d6bf52b708d5'),
  ('Silhouette Match', 'Match an object or character to its correct silhouette.', 'puzzles', '4ba236d0-ea0c-4539-9755-d6bf52b708d5'),
  ('Solitaire', 'A classic card solitaire puzzle.', 'puzzles', '4ba236d0-ea0c-4539-9755-d6bf52b708d5'),
  ('Spot Difference', 'Spot the Difference puzzles enhance focused attention to detail, concentration, and patience.', 'puzzles', '4ba236d0-ea0c-4539-9755-d6bf52b708d5'),
  ('Triple Tile', 'Match tiles in sets of three to clear the board.', 'puzzles', '4ba236d0-ea0c-4539-9755-d6bf52b708d5'),
  ('Visual Math', 'Solve math problems presented as visual puzzles.', 'puzzles', '4ba236d0-ea0c-4539-9755-d6bf52b708d5'),
  ('Visual Novel', 'A choice-driven visual story with puzzle elements.', 'puzzles', '4ba236d0-ea0c-4539-9755-d6bf52b708d5'),
  ('Zoom Puzzle', 'Guess the object from an extreme close-up before it zooms out.', 'puzzles', '4ba236d0-ea0c-4539-9755-d6bf52b708d5')
ON CONFLICT DO NOTHING;

-- Verify
SELECT 'kids_collections' AS t, count(*) FROM kids_collections
UNION ALL SELECT 'memes', count(*) FROM memes
UNION ALL SELECT 'puzzles', count(*) FROM puzzles;

