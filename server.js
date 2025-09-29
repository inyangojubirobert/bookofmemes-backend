import express from "express";
import cors from "cors";
import { supabase } from "./config/db.js";

const app = express();
app.use(express.json());
app.use(cors());

// --------------------
// Helper: Check if item exists
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
// Fetch stories
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


// Fetch story + chapters
app.get("/api/stories/:id/chapters", async (req, res) => {
  const { id } = req.params;

  try {
    // Fetch story metadata including author_id
    const { data: story, error: storyError } = await supabase
      .from("stories")
      .select("id, story_title, author_id")
      .eq("id", id)
      .single();

    if (storyError || !story) throw storyError || new Error("Story not found");

    // Fetch chapters
    const { data: chapters, error: chaptersError } = await supabase
      .from("chapters")
      .select("*")
      .eq("story_id", id)
      .order("chapter_number", { ascending: true });

    if (chaptersError) throw chaptersError;

    res.json({ story, chapters });
  } catch (err) {
    console.error("Error fetching story + chapters:", err);
    res.status(500).json({ error: "Failed to fetch story + chapters" });
  }
});


// --------------------
// Fetch comments for an item
// --------------------
app.get("/api/comments", async (req, res) => {
  const { itemId } = req.query;

  if (!itemId) return res.status(400).json({ error: "Missing itemId" });

  try {
    // Fetch all comments with user profile info
    const { data: comments, error } = await supabase
      .from("comments")
      .select(`
        id,
        content,
        created_at,
        user_id,
        author_id,
        parent_id,
        item_id,
        item_type,
        likes,
        dislikes,
        profiles (
          full_name,
          avatar_url
        )
      `)
      .eq("item_id", itemId)
      .order("created_at", { ascending: true });

    if (error) throw error;

    // Add default avatar if missing
    const commentsWithDefaults = comments.map(c => ({
      ...c,
      profiles: {
        full_name: c.profiles?.full_name || "Unknown",
        avatar_url: c.profiles?.avatar_url || "https://via.placeholder.com/36",
      },
      replies: [],
    }));

    // Build threaded tree
    const buildThreadedTree = (flatComments) => {
      const map = {};
      const roots = [];

      flatComments.forEach(c => {
        map[c.id] = { ...c, replies: [] };
      });

      flatComments.forEach(c => {
        if (c.parent_id) {
          map[c.parent_id]?.replies.push(map[c.id]);
        } else {
          roots.push(map[c.id]);
        }
      });

      return roots;
    };

    const threadedComments = buildThreadedTree(commentsWithDefaults);

    res.json(threadedComments);
  } catch (err) {
    console.error("Server error fetching comments:", err);
    res.status(500).json({ error: "Failed to fetch comments" });
  }
});

// --------------------
// POST /api/comments
app.post("/api/comments", async (req, res) => {
  const { content, user_id, item_id, item_type, parent_id } = req.body;

  // Basic validation
  if (!content || !user_id || !item_id) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  // Check if the item exists (optional but good)
  const exists = await itemExists(item_id);
  if (!exists) return res.status(404).json({ error: "Item not found" });

  try {
  const payload = {
  content,
  user_id,
  author_id: user_id,
  item_id,
  item_type,       // use exactly what the client sends
  parent_id: parent_id || null,
};
    console.log("Posting comment payload:", payload);

    const { data, error } = await supabase
      .from("comments")
      .insert([payload])
      .select(`
        *,
        profiles:user_id (full_name, avatar_url)
      `);

    if (error) {
      console.error("Supabase insert error:", error);
      return res.status(500).json({
        error: "Failed to post comment",
        details: error.message,
      });
    }

    res.json(data[0]); // send back the new comment with profile info
  } catch (err) {
    console.error("Unexpected server error:", err);
    res.status(500).json({ error: "Unexpected server error", details: err.message });
  }
});

// --------------------
// Delete comment
// --------------------
app.delete("/api/comments/:id", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  const { data: { user }, error: userError } = await supabase.auth.getUser(token);
  if (userError || !user) return res.status(401).json({ error: "Unauthorized" });

  const { id } = req.params;
  const { item_type } = req.body;

  console.log("Delete request by:", user.id, "for comment:", id, "with type:", item_type);

  try {
    const { error } = await supabase
      .from("comments")
      .delete()
      .eq("id", id)
      .eq("item_type", item_type)
      .eq("author_id", user.id);

    if (error) throw error;

    res.json({ message: "Comment deleted successfully" });
  } catch (err) {
    console.error("Server error deleting comment:", err);
    res.status(500).json({ error: "Failed to delete comment" });
  }
});

// Add or update a vote (like/dislike)
app.post("/api/comments/:id/vote", async (req, res) => {
  const { id } = req.params; // comment_id
  const { user_id, vote_type } = req.body; // "like" or "dislike"

  if (!user_id || !vote_type) {
    return res.status(400).json({ error: "Missing user_id or vote_type" });
  }

  try {
    const { data, error } = await supabase
      .from("comment_votes")
      .upsert(
        { user_id, comment_id: id, vote_type },
        { onConflict: ["user_id", "comment_id"] }
      );

    if (error) throw error;

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove a vote (undo like/dislike)
app.delete("/api/comments/:id/vote", async (req, res) => {
  const { id } = req.params; // comment_id
  const { user_id } = req.body;

  if (!user_id) {
    return res.status(400).json({ error: "Missing user_id" });
  }

  try {
    const { error } = await supabase
      .from("comment_votes")
      .delete()
      .eq("comment_id", id)
      .eq("user_id", user_id);

    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    console.error("Server error fetching profile:", err);
    res.status(500).json({ error: "Failed to fetch profile" });
  }
});

// --------------------
const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
