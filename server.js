import express from "express";
import cors from "cors";
import { supabase } from "./config/db.js";

const app = express();
app.use(express.json());
app.use(cors());

// --------------------
// Check if item exists in universal_items view
// --------------------
async function itemExists(itemId) {
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
}

// --------------------
// Fetch stories (for CommentModal)
// --------------------
app.get("/api/stories", async (req, res) => {
  try { 
    const { data, error } = await supabase
      .from("stories")
      .select("id, story_title, author_id");

    if (error) throw error;

    res.json(data || []);
  } catch (err) {
    console.error("Error fetching stories:", err);
    res.status(500).json({ error: "Failed to fetch stories" });
  }
});

// --------------------
// Fetch comments for any item type
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
    console.error("Server error fetching comments:", err);
    res.status(500).json({ error: "Failed to fetch comments" });
  }
});

// --------------------
// Add a new comment (universal)
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
    console.error("Server error posting comment:", err);
    res.status(500).json({ error: "Failed to post comment" });
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

    res.json({ success: true });
  } catch (err) {
    console.error("Server error deleting comment:", err);
    res.status(500).json({ error: "Failed to delete comment" });
  }
});

// --------------------
// Fetch profile by ID (author info)
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
    console.error("Server error fetching profile:", err);
    res.status(500).json({ error: "Failed to fetch profile" });
  }
});

// --------------------
const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
// --------------------
// Fetch chapters for a story
// --------------------
app.get("/api/stories/:id/chapters", async (req, res) => {
  const { id } = req.params;

  try {
    // Fetch the story with author profile
    const { data: story, error: storyError } = await supabase
      .from("stories")
      .select("id, story_title, author_id, profiles(full_name, avatar_url)")
      .eq("id", id)
      .single();

    if (storyError) throw storyError;
    if (!story) return res.status(404).json({ error: "Story not found" });

    // Normalize field names for frontend
    const normalizedStory = {
      id: story.id,
      title: story.story_title,   // ✅ map story_title → title
      author_id: story.author_id,
      profiles: story.profiles || null,
    };

    // Fetch chapters
    const { data: chapters, error: chaptersError } = await supabase
      .from("chapters")
      .select("id, chapter_number, chapter_title, chapter_content, story_id")
      .eq("story_id", id)
      .order("chapter_number", { ascending: true });

    if (chaptersError) throw chaptersError;

    // Return normalized story + chapters
    res.json({ story: normalizedStory, chapters });
  } catch (err) {
    return handleError(res, err, "Failed to fetch chapters");
  }
});
