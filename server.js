import express from 'express';
import { supabase } from './config/db.js';
import cors from 'cors';

const app = express();
app.use(express.json());
app.use(cors());

app.get('/api/stories/:storyId/chapters', async (req, res) => {
  try {
    const { storyId } = req.params;

    // Fetch story with author_id
    const { data: storyData, error: storyError } = await supabase
      .from('stories')
      .select('id, author_id')
      .eq('id', storyId)
      .single();

    if (storyError && storyError.code !== 'PGRST116') {
      // Only proceed if story exists or error is not "no rows"
      return res.status(404).json({ success: false, error: 'Story not found' });
    }

    // Fetch chapters
    const { data: chaptersData, error: chaptersError } = await supabase
      .from('chapters')
      .select(`*, prev:prev_chapter_id (chapter_number), next:next_chapter_id (chapter_number), author_id`)
      .eq('story_id', storyId)
      .order('chapter_number', { ascending: true });

    if (chaptersError) throw chaptersError;

    // Determine authorId: story first, then first chapter fallback
    let authorId = storyData?.author_id || (chaptersData.length > 0 ? chaptersData[0].author_id : null);

    // Fetch username from users table
    let username = null;
    if (authorId) {
      const { data: userData, error: userError } = await supabase
        .from('users')
        .select('username')
        .eq('id', authorId)
        .single();

      if (!userError && userData) {
        username = userData.username;
      }
    }

    // Format chapters
    const chapters = chaptersData.map(chapter => ({
      ...chapter,
      prev_chapter_number: chapter.prev ? chapter.prev.chapter_number : null,
      next_chapter_number: chapter.next ? chapter.next.chapter_number : null
    }));

    res.json({
      success: true,
      story: {
        id: storyData?.id || (chaptersData.length > 0 ? chaptersData[0].story_id : null),
        authorId,
        username,
      },
      chapters
    });

  } catch (err) {
    console.error('Error fetching chapters:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch chapters' });
  }
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
