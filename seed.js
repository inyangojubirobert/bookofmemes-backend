import { sql } from './supabase.js'; // Your Neon DB connection
import dotenv from 'dotenv';

dotenv.config();

// --- Define all your seed data in a structured array ---
const seedStoriesData = [
    {
        title: "Black Diamond",
        synopsis: "Driven by poverty, a young teenage girl seeks fame, facing immoral choices and harassment for survival on her difficult rise to fortune. adversity lurks; her goals seem out of reach. Will she come out unscathed, or will the dark forces consume her ambition.",
        category: "Fantasy",
        coverImageUrl: 'https://res.cloudinary.com/dljcj00ht/image/upload/v1749548322/blackdiamond_p9hush.png',
        userId: 'initial_user_1', // IMPORTANT: This user ID must exist in your 'Users' table
        chapters: [
            {
                title: 'Dust on the Floorboards',
                content: `The morning light, thin and hesitant, struggled to pierce the grime on the single window, casting weak, dusty stripes across the worn floorboards of Ellie's cramped room. At eighteen, her chocolate skin, usually vibrant, held a faint, almost translucent quality, a testament to the perpetual hunger that gnawed at her stomach. She traced a pattern in the thick layer of dust on the sill, the grit a familiar companion. Every breath in this tiny apartment felt heavy, laden with the scent of stale air and unspoken dreams. The silence was punctuated only by the distant rumble of the city, a constant reminder of the world beyond her reach—a world where fortune seemed to bloom effortlessly for others. Today, like every day, the dust on the floorboards is a stark mirror of her reality: a life covered in the remnants of what once was, waiting for a force strong enough to sweep it clean.

She ran her finger along the cold, rough wood, the sensation a stark contrast to the silky fabrics and polished surfaces she saw in the glossy magazines sometimes left on park benches. Those images, fleeting glimpses into another existence, fueled a quiet fire within her—a fire that burned against the endless cycle of waking up to the same grimy walls, the same gnawing emptiness. It wasn't just about food anymore; it was about dignity and a future where dust wasn't the predominant feature of her life. There were whispers of opportunities in the air—the kind that beckoned her in dreams, tantalizing and just out of reach, like the shimmering mirage of water in a desert.

A groan from the next room broke the silence. It was her younger brother, Leo, already stirring. Ellie sighed, pushing herself up from the floor. Her stomach gave a hollow protest, a familiar ache that had become a constant companion. The thin blanket on her makeshift bed offered little comfort, and the chill in the air seemed to seep into her bones. But today felt different, charged with an unsettling energy, as if the universe was conspiring to shift the status quo.

She moved to the small, chipped dresser, its paint long since flaked away. Among the few meager belongings, she picked up a faded photograph. It was of her family, taken years ago when her father still had steady work and her mother's laughter wasn't a strained memory. Their faces, once full and bright, now seemed like ghosts from a happier time before the city's relentless indifference had worn them down. The photograph was a reminder of what could be lost again, but it also harbored the possibility of something more—something worth fighting for.

"Ellie? Is there anything to eat?" Leo's thin and hopeful voice drifted from the doorway. He was ten, his eyes too wide for his face, reflecting the same hunger she felt. His small frame, still growing, made the lack of food even more poignant. His small frame, still growing, made the lack of food even more poignant. He stood there, rubbing sleep from his eyes, a silent plea in his gaze that tugged at Ellie's heartstrings and ignited her protective instincts.

Ellie turned, offering a weak smile that felt more like a grimace. "Just a little bread left, Leo. I'll make us some tea." Her voice was soft, trying to inject a warmth she didn't feel. She knew the single, stale piece of bread wouldn't be enough, but it was all they had until she could figure something out. But beneath the weight of their circumstances, a flicker of determination ignited. There were unsettling rumors floating around the neighborhood—whispers of a community organizer who was promising jobs to those willing to fight for change. The city's distant hum seemed to mock her, a symphony of opportunities she couldn't grasp, yet she felt the pull of something transformative.

She looked back at the dusty window, a fierce resolve hardening her gaze. This life, covered in dust, was not her destiny. She would sweep it clean, no matter the cost, no matter what she had to do. Somewhere beyond the grime, beyond the hunger and despair, lay a path waiting to be discovered—one that could lead her and Leo to a future free of dust and filled with possibility. As the tea simmered, Ellie's thoughts raced with plans and dreams, intertwining the mundane with the extraordinary. The fight for a better life had just begun, and she was ready to grasp it with both hands.`,
            },
            {
                title: 'A Crumbling Foundation',
                content: `The "little bread" was a crust, hard and dry, salvaged from yesterday's meager meal. Ellie broke it in half, giving the larger piece to Leo, who devoured it with an urgency that twisted her gut. The tea, brewed from the cheapest, most flavorless leaves, offered only a fleeting warmth. Their breakfast ritual was a silent testament to their daily struggle, a quiet acknowledgment of the crumbling foundation beneath their lives. Every creak of the floorboards, every draft that snaked through the cracks in the walls, felt like a physical manifestation of their precarious existence.

Their mother, Maria, emerged from her room, her face etched with a weariness beyond sleep deprivation. Her eyes, once bright and full of life, now held a dull, distant sadness. She worked two jobs, cleaning offices during the day and waiting tables at night, but it was never enough. The medical bills from Leo's chronic cough, the ever-increasing rent, the constant need for food – it was a relentless tide that threatened to drown them. Yet, behind Maria's weary façade, Ellie sensed an undercurrent of secrecy, a flicker of something unspoken in her mother's tired gaze.

"Morning, Mama," Ellie said, trying to sound cheerful as she poured Maria a cup of tea, the steam doing little to hide the trembling in her hands. As Maria lifted the cup to her lips, Ellie noticed something unusual – a small, crumpled letter peeking out from Maria's pocket. It seemed out of place and strangely at odds with their circumstances. Maria's gaze drifted to the window, lost in thought, but Ellie could feel the tension coiling in the air, thick and palpable.

"Any word from Papa?" Leo asked, his voice barely a whisper, as if the question might break something. Their father had left months ago, promising to find work in another city, to send money. The letters had stopped coming weeks ago, and with each passing day, the hope he represented dwindled, replaced by a cold, hard knot of fear in Ellie's chest.

Maria shook her head, her lips pressed into a thin line. "Not yet, Leo. But he'll send something. He always does." Her voice lacked conviction, a hollow echo of a promise she no longer believed. But Ellie could not shake the feeling that there was more beneath the surface – a truth buried in the silence that spoke volumes.

Ellie watched Maria closely, her shoulders slumped, but the flicker of determination sparked within her. The tension between them felt charged, like a storm brewing just below the surface. With every passing moment, Ellie contemplated the possibilities of what lay beyond their door. The city outside, once a mocking hum, now seemed to call to her, a siren song of opportunity intertwined with danger. Beneath the dirt and dust, she sensed a world filled with secrets; girls who sought fame not just for themselves, but to escape their own nightmares – and at times, they paid a price far greater than they anticipated.

Ellie knew the stories, the whispers that echoed through the streets. She had seen girls consumed by the very world they longed to conquer. Yet she also understood that her best chance lay in the unknown, in uncovering the truths hidden beneath layers of struggle. The dust on the floorboards wasn't just a symbol of poverty; it was a suffocating blanket that stifled her ambition. Someone had to be strong. Someone had to reach for something more — whatever that might involve.

With a fierce, almost desperate resolve, Ellie made a decision: she would unravel the mysteries that loomed over their lives and the letter tucked away in Maria's pocket was just the beginning. Perhaps it held answers, clues to a way out that they hadn't considered before. The foundation of their lives was dissolving, but she refused to let their story end here. No matter the cost to her soul, she would seek the truth, ready to face whatever shadows awaited her.`,
            },
            // Add more chapters for Black Diamond here if needed
            // {
            //    title: 'New Chapter 3 Title',
            //    content: 'Content for chapter 3...',
            // },
        ],
    },
    {
        title: "The Dragon's Breath",
        synopsis: "An ancient prophecy awakens a forgotten power in a land ravaged by a dragon's fury.",
        category: "Fantasy",
        coverImageUrl: 'https://example.com/dragon-breath-cover.png', // Replace with a real URL
        userId: 'initial_user_2', // IMPORTANT: This user ID must exist in your 'Users' table
        chapters: [
            {
                title: 'The Prophecy Unveiled',
                content: 'Whispers of a great beast had filled the taverns for decades, but none believed...',
            },
            {
                title: 'Flight of the Guardian',
                content: 'Elara, the last of her kin, felt the ancient magic stir within her as the mountain trembled.',
            },
            // Add more chapters for The Dragon's Breath here
        ],
    },
    {
        title: "Neon City Chronicles",
        synopsis: "In a cyberpunk metropolis, a lone hacker uncovers a conspiracy that threatens the digital world.",
        category: "Sci-Fi",
        coverImageUrl: 'https://example.com/neon-city-cover.png', // Replace with a real URL
        userId: 'initial_user_1', // Can be the same user if they write multiple stories
        chapters: [
            {
                title: 'Glitches in the System',
                content: 'The rain-slicked streets of Neo-Kyoto hummed with a synthetic energy, masking a deeper hum of discontent.',
            },
            {
                title: 'The Ghost in the Wire',
                content: 'Jax connected to the net, a familiar surge of data flowing through his mind, but this time, something new was waiting.',
            },
        ],
    },
    // Add more story objects here as needed.
    // Each object represents a complete story with its chapters.
];

// --- Main seeding function ---
async function seedDatabase() {
    try {
        console.log("Starting database seeding...");

        // NOTE: TRUNCATE statements have been removed as per your request.
        // Ensure your database tables are empty or you've manually cleared them
        // before running this script if you want fresh IDs starting from 1.

        // Start the transaction using a tagged template literal
        await sql`BEGIN;`;

        try {
            // Iterate through each story defined in your seedStoriesData array
            for (const storyData of seedStoriesData) {
                console.log(`\nSeeding story: "${storyData.title}"`);

                // 1. Create the Story entry
                const newStory = await sql`
                    INSERT INTO "stories" (user_id, story_title, story_synopsis, story_category, likes, comments, views, bookmarks)
                    VALUES (
                        ${storyData.userId},
                        ${storyData.title},
                        ${storyData.synopsis},
                        ${storyData.category},
                        0, 0, 0, 0
                    )
                    RETURNING id;
                `;
                const storyId = newStory[0].id;
                console.log(`-> Created Story with ID: ${storyId}`);

                // 2. Create the Story Cover
                if (storyData.coverImageUrl) {
                    await sql`
                        INSERT INTO "storycovers" (story_id, image_url)
                        VALUES (
                            ${storyId},
                            ${storyData.coverImageUrl}
                        );
                    `;
                    console.log(`-> Created Story Cover for Story ID: ${storyId}`);
                }

                // 3. Create Chapters and their Content for the current story
                for (let i = 0; i < storyData.chapters.length; i++) {
                    const chapterData = storyData.chapters[i];
                    const chapterNumber = i + 1; // Chapters are typically 1-based

                    const newChapter = await sql`
                        INSERT INTO "chapters" (story_id, chapter_number, chapter_title)
                        VALUES (
                            ${storyId},
                            ${chapterNumber},
                            ${chapterData.title}
                        )
                        RETURNING id;
                    `;
                    const chapterId = newChapter[0].id;
                    console.log(`  -> Created Chapter ${chapterNumber} (ID: ${chapterId}) for Story ID: ${storyId}`);

                    // 4. Create Chapter Content
                    await sql`
                        INSERT INTO "chaptercontent" (chapter_id, content)
                        VALUES (
                            ${chapterId},
                            ${chapterData.content}
                        );
                    `;
                    console.log(`    -> Created content for Chapter ID: ${chapterId}`);
                }
            }

            await sql`COMMIT;`; // Commit transaction if all successful
            console.log("\nDatabase seeding completed successfully.");

        } catch (innerError) {
            await sql`ROLLBACK;`; // Rollback transaction if any error occurs
            console.error("Error during transaction, rolling back:", innerError);
            throw innerError; // Re-throw to be caught by the outer catch block
        }

    } catch (outerError) {
        console.error("Error seeding database:", outerError);
        process.exit(1); // Exit with an error code if seeding fails
    }
}

// --- Call the seeding function to start the process ---
seedDatabase();