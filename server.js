// backend/server.js

import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import { supabase } from './config/db.js'; // <<< IMPORT YOUR SUPABASE CLIENT HERE

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5001; // Ensure this matches your .env PORT

// Middleware
app.use(express.json());
app.use(cors());

// Basic route to check if the server is running
app.get('/', (req, res) => {
    res.send('API is running...');
});

// --- API Endpoints to Fetch Data using Supabase ---

// Get all stories with their covers
app.get('/api/stories', async (req, res) => {
    try {
        // Fetch stories
        const { data: stories, error: storiesError } = await supabase
            .from('Stories') // Your table name in Supabase
            .select(`
                id,
                user_id,
                story_title,
                story_synopsis,
                story_category,
                likes,
                comments,
                views,
                bookmarks,
                StoryCovers(image_url) // Fetch related cover image using join (requires foreign key in Supabase)
            `);

        if (storiesError) throw storiesError;

        // Flatten the response if StoryCovers returns an array for a single cover
        const formattedStories = stories.map(story => ({
            ...story,
            cover_image_url: story.StoryCovers.length > 0 ? story.StoryCovers[0].image_url : null
        }));

        res.json(formattedStories);
    } catch (error) {
        console.error('Error fetching stories:', error);
        res.status(500).json({ message: 'Error fetching stories', error: error.message });
    }
});

// Get a single story by ID with its chapter metadata
app.get('/api/stories/:storyId', async (req, res) => {
    const { storyId } = req.params;
    try {
        // Fetch story details
        const { data: story, error: storyError } = await supabase
            .from('Stories')
            .select(`
                *, // Select all columns from Stories
                StoryCovers(image_url), // Get related cover
                Chapters(
                    chapter_id:id, // Rename id to chapter_id for consistency with old response
                    chapter_number,
                    chapter_title
                ) // Get related chapters (metadata only)
            `)
            .eq('id', storyId)
            .single(); // Use .single() as we expect only one story

        if (storyError && storyError.code === 'PGRST116') { // No rows found
            return res.status(404).json({ message: 'Story not found' });
        }
        if (storyError) throw storyError;

        // Format the response, especially for the cover and chapters
        const formattedStory = {
            ...story,
            cover_image_url: story.StoryCovers ? story.StoryCovers.image_url : null,
            // Ensure chapters are correctly structured
            chapters: story.Chapters.map(chapter => ({
                chapter_id: chapter.chapter_id,
                chapter_number: chapter.chapter_number,
                chapter_title: chapter.chapter_title
            }))
        };
        // Remove the nested Supabase objects if they exist
        delete formattedStory.StoryCovers;
        // delete formattedStory.Chapters; // We've already mapped them

        res.json(formattedStory);

    } catch (error) {
        console.error('Error fetching story by ID:', error);
        res.status(500).json({ message: 'Error fetching story details', error: error.message });
    }
});

// Get the content of a single chapter
app.get('/api/chapters/:chapterId/content', async (req, res) => {
    const { chapterId } = req.params;
    try {
        const { data: chapterContent, error: chapterContentError } = await supabase
            .from('ChapterContent')
            .select('content')
            .eq('chapter_id', chapterId)
            .single();

        if (chapterContentError && chapterContentError.code === 'PGRST116') {
            return res.status(404).json({ message: 'Chapter content not found.' });
        }
        if (chapterContentError) throw chapterContentError;

        res.json({ content: chapterContent.content });

    } catch (error) {
        console.error('Error fetching chapter content for chapter ID:', chapterId, error);
        res.status(500).json({ message: 'Error fetching chapter content.', error: error.message });
    }
});

// --- Update Counts using Supabase (Example for Likes) ---
app.patch('/api/stories/:storyId/like', async (req, res) => {
    const { storyId } = req.params;
    const { action } = req.body; // 'increment' or 'decrement'

    try {
        let incrementBy = 0;
        if (action === 'increment') {
            incrementBy = 1;
        } else if (action === 'decrement') {
            incrementBy = -1;
        } else {
            return res.status(400).json({ message: 'Invalid action for like. Must be "increment" or "decrement".' });
        }

        // Use a function to update the count to prevent race conditions
        const { data, error } = await supabase.rpc('increment_likes', {
            story_id_param: storyId,
            increment_by_param: incrementBy
        });

        if (error) throw error;

        res.json({ newLikes: data }); // Supabase RPC often returns a single value directly

    } catch (error) {
        console.error('Error updating likes for story ID:', storyId, error);
        res.status(500).json({ message: 'Error updating likes.', error: error.message });
    }
});

// To implement 'increment_likes' you'd need a Supabase SQL Function (RPC)
// Example SQL for Supabase Function (run this in Supabase SQL Editor):
/*
CREATE OR REPLACE FUNCTION increment_likes(story_id_param uuid, increment_by_param int)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER -- crucial for RPC to bypass RLS with service_role_key
AS $$
DECLARE
    new_likes_count int;
BEGIN
    UPDATE "Stories"
    SET likes = GREATEST(0, likes + increment_by_param)
    WHERE id = story_id_param
    RETURNING likes INTO new_likes_count;

    RETURN new_likes_count;
END;
$$;
*/


// ... (add similar PATCH endpoints for views, bookmarks, comments using Supabase functions or direct updates)

// Start the server
app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
});