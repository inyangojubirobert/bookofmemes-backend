import express from "express";
import cors from "cors";
import { supabase } from "./config/db.js";

const app = express();
app.use(express.json());
app.use(cors());

// --------------------
// Helper: error handler
// --------------------
function handleError(res, err, msg = "Server error") {
  console.error(msg, err);
  return res.status(500).json({ error: msg });
}

// --------------------
// Helper: check if item exists
// --------------------
async function itemExists(itemId) {
  try {
    const { data, error } = await supabase
      .from("universal_items")
      .select("id")
      .eq("id", itemId)
      .single();

    if (error && error.code !== "PGRST116") {
      console.error("Error checking item existence:", error);
      return false;
    }

    return !!data;
  } catch (err) {
    console.error("Unexpected error in itemExists:", err);
    return false;
  }
}

// --------------------
// Fetch all stories
// --------------------
app.get("/api/stories", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("stories")
      .select("id, story_title, author_id");

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    return handleError(res, err, "Failed to fetch stories");
  }
});

// --------------------
// Fetch comments
// --------------------
app.get("/api/comments", async (req, res) => {
  const { itemId } = req.query;
  if (!itemId) return res.status(400).json({ error: "Missing itemId" });

  const exists = await itemExists(itemId);
  if (!exists) return res.status(404).json({ error: "Item not found" });

  try {
    const { data: comments, error } = await supabase
      .from("comments")
      .select(`
        id,
        content,
        created_at,
        user_id,
        parent_id,
        item_id,
        item_type,
        profiles:user_id (full_name, avatar_url)
      `)
      .eq("item_id", itemId)
      .order("created_at", { ascending: true });

    if (error) throw error;
    res.json(comments || []);
  } catch (err) {
    return handleError(res, err, "Failed to fetch comments");
  }
});

// --------------------
// Post new comment
// --------------------
app.post("/api/comments", async (req, res) => {
  const { content, user_id, item_id, item_type, parent_id } = req.body;
  if (!content || !user_id || !item_id)
    return res.status(400).json({ error: "Missing required fields" });

  const exists = await itemExists(item_id);
  if (!exists) return res.status(404).json({ error: "Item not found" });

  try {
    const { data, error } = await supabase
      .from("comments")
      .insert([
        {
          content,
          user_id,
          author_id: user_id,
          item_id,
          item_type: item_type || "unknown",
          parent_id: parent_id || null,
        },
      ])
      .select();

    if (error) throw error;
    res.json(data[0]);
  } catch (err) {
    return handleError(res, err, "Failed to post comment");
  }
});

// --------------------
// Delete comment
// --------------------
app.delete("/api/comments/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const { data, error } = await supabase
      .from("comments")
      .delete()
      .eq("id", id)
      .select();

    if (error) throw error;
    if (!data || data.length === 0)
      return res.status(404).json({ error: "Comment not found" });

    res.json({ success: true });
  } catch (err) {
    return handleError(res, err, "Failed to delete comment");
  }
});

// --------------------
// Fetch profile by ID
// --------------------
app.get("/api/profiles/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("full_name, avatar_url")
      .eq("id", id)
      .single();

    if (error) return res.status(404).json({ error: "Profile not found" });
    res.json(data);
  } catch (err) {
    return handleError(res, err, "Failed to fetch profile");
  }
});

// --------------------
// Fetch chapters for a story
// --------------------
app.get("/api/stories/:id/chapters", async (req, res) => {
  const { id } = req.params;
  console.log("Fetching chapters for storyId:", id);

  try {
    // Fetch story with author profile
    const { data: story, error: storyError } = await supabase
      .from("stories")
      .select("id, story_title, author_id, profiles(full_name, avatar_url)")
      .eq("id", id)
      .single();

    if (storyError) {
      console.error("Story fetch error:", storyError);
      return res.status(500).json({ error: "Story fetch failed" });
    }
    if (!story) return res.status(404).json({ error: "Story not found" });

    const normalizedStory = {
      id: story.id,
      title: story.story_title, // frontend-friendly
      author_id: story.author_id,
      profiles: story.profiles || null,
    };

    // Fetch chapters
    const { data: chapters, error: chaptersError } = await supabase
      .from("chapters")
      .select("id, chapter_number, chapter_title, chapter_content, story_id")
      .eq("story_id", id)
      .order("chapter_number", { ascending: true });

    if (chaptersError) {
      console.error("Chapters fetch error:", chaptersError);
      return res.status(500).json({ error: "Chapters fetch failed" });
    }

    res.json({ story: normalizedStory, chapters });
  } catch (err) {
    return handleError(res, err, "Failed to fetch chapters");
  }
});

// --------------------
// Start server
// --------------------
const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
