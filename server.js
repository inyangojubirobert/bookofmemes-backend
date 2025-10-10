// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { supabase } from "./config/db.js";
import feedsRouter from "./routes/feeds.js";
import commentsRouter from "./routes/comments.js"; // optional but recommended

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5001;

// --------------------
// Middleware
// --------------------
app.use(cors());
app.use(express.json());

// --------------------
// Mount Routers
// --------------------
app.use("/feeds", feedsRouter);
app.use("/api/comments", commentsRouter); // Keep your comments router if it exists

// --------------------
// Health check
// --------------------
app.get("/", (req, res) => {
  res.send("✅ BookOfMemes API running successfully");
});

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
// Stories
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
// Feeds API
// --------------------
app.get("/api/feeds", async (req, res) => {
  const { userId } = req.query;

  try {
    const { data, error } = await supabase
      .from("feeds") // replace with your actual feeds table
      .select("*")
      .order("created_at", { ascending: false });

    if (error) throw error;

    // Wrap existing logic but always return array
    res.json(Array.isArray(data) ? data : []);
  } catch (err) {
    console.error("Failed to fetch feeds:", err.message);
    res.json([]); // fail gracefully
  }
});

// --------------------
// Mentions API
// --------------------
app.get("/api/mentions", async (req, res) => {
  const { userId } = req.query;

  // Return empty array if no userId is provided
  if (!userId) return res.json([]);

  try {
    const { data, error } = await supabase
      .from("mentions") // replace with your actual mentions table
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false }); // optional ordering

    if (error) throw error;

    // Wrap existing logic but always return array
    res.json(Array.isArray(data) ? data : []);
  } catch (err) {
    console.error("Failed to fetch mentions:", err.message);
    res.json([]); // fail gracefully
  }
});


app.get("/api/stories/:id/chapters", async (req, res) => {
  const { id } = req.params;

  try {
    const { data: story, error: storyError } = await supabase
      .from("stories")
      .select("id, story_title, author_id")
      .eq("id", id)
      .single();

    if (storyError || !story) throw storyError || new Error("Story not found");

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
// Comments API
// --------------------
app.get("/api/comments", async (req, res) => {
  const { itemId } = req.query; // optional: filter by item

  try {
    // Build base query
    let query = supabase
      .from("comments")
      .select(`
        id, content, created_at, user_id, author_id,
        parent_id, item_id, item_type, likes, dislikes,
        profiles:user_id(full_name, avatar_url)
      `)
      .order("created_at", { ascending: true });

    // Apply item filter if itemId is provided
    if (itemId) query = query.eq("item_id", itemId);

    const { data: comments, error } = await query;
    if (error) throw error;

    // Add defaults and placeholders
    const commentsWithDefaults = comments.map(c => ({
      ...c,
      profiles: {
        full_name: c.profiles?.full_name || "Unknown",
        avatar_url: c.profiles?.avatar_url || "https://via.placeholder.com/36",
      },
      replies: [],
      liked_users: [],
      disliked_users: [],
    }));

    // Fetch votes for all comments
    const commentIds = commentsWithDefaults.map(c => c.id);
    const { data: votes, error: votesError } = await supabase
      .from("comment_votes")
      .select("user_id, comment_id, vote_type, profiles(full_name, avatar_url)")
      .in("comment_id", commentIds);

    if (votesError) throw votesError;

    // Attach votes to comments
    commentsWithDefaults.forEach(comment => {
      votes.filter(v => v.comment_id === comment.id).forEach(v => {
        if (v.vote_type === "like") {
          comment.liked_users.push({
            user_id: v.user_id,
            full_name: v.profiles?.full_name || "Unknown",
            avatar_url: v.profiles?.avatar_url || "https://via.placeholder.com/36"
          });
        } else if (v.vote_type === "dislike") {
          comment.disliked_users.push({
            user_id: v.user_id,
            full_name: v.profiles?.full_name || "Unknown",
            avatar_url: v.profiles?.avatar_url || "https://via.placeholder.com/36"
          });
        }
      });
    });

    // Build threaded structure
    const map = {};
    const roots = [];
    commentsWithDefaults.forEach(c => map[c.id] = { ...c, replies: [] });
    commentsWithDefaults.forEach(c => {
      if (c.parent_id) map[c.parent_id]?.replies.push(map[c.id]);
      else roots.push(map[c.id]);
    });

    res.json(roots);
  } catch (err) {
    console.error("Server error fetching comments:", err);
    res.status(500).json({ error: "Failed to fetch comments" });
  }
});


app.post("/api/comments", async (req, res) => {
  const { content, user_id, item_id, item_type, parent_id } = req.body;
  if (!content || !user_id || !item_id) return res.status(400).json({ error: "Missing required fields" });

  const exists = await itemExists(item_id);
  if (!exists) return res.status(404).json({ error: "Item not found" });

  try {
    const payload = { content, user_id, author_id: user_id, item_id, item_type, parent_id: parent_id || null };
    const { data, error } = await supabase
      .from("comments")
      .insert([payload])
      .select(`*, profiles:user_id(full_name, avatar_url)`);

    if (error) throw error;
    res.json(data[0]);
  } catch (err) {
    console.error("Server error posting comment:", err);
    res.status(500).json({ error: "Failed to post comment", details: err.message });
  }
});

app.delete("/api/comments/:id", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  const { data: { user }, error: userError } = await supabase.auth.getUser(token);
  if (userError || !user) return res.status(401).json({ error: "Unauthorized" });

  const { id } = req.params;
  const { item_type } = req.body;

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

// Votes
app.post("/api/comments/:id/vote", async (req, res) => {
  const { id } = req.params;
  const { user_id, vote_type } = req.body;
  if (!user_id || !vote_type) return res.status(400).json({ error: "Missing user_id or vote_type" });

  try {
    const { error } = await supabase
      .from("comment_votes")
      .upsert({ user_id, comment_id: id, vote_type }, { onConflict: ["user_id", "comment_id"] });
    if (error) throw error;

    const { data: counts, error: countErr } = await supabase
      .from("comments")
      .select("id, likes, dislikes")
      .eq("id", id)
      .single();
    if (countErr) throw countErr;

    const { data: vote } = await supabase
      .from("comment_votes")
      .select("vote_type")
      .eq("comment_id", id)
      .eq("user_id", user_id)
      .single();

    res.json({ ...counts, current_user_vote: vote?.vote_type || null });
  } catch (err) {
    console.error("Vote error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/comments/:id/vote", async (req, res) => {
  const { id } = req.params;
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: "Missing user_id" });

  try {
    const { error } = await supabase
      .from("comment_votes")
      .delete()
      .eq("comment_id", id)
      .eq("user_id", user_id);
    if (error) throw error;

    const { data: counts, error: countErr } = await supabase
      .from("comments")
      .select("id, likes, dislikes")
      .eq("id", id)
      .single();
    if (countErr) throw countErr;

    res.json({ ...counts, current_user_vote: null });
  } catch (err) {
    console.error("Vote deletion error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Profiles
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
// Start server
// --------------------
// --------------------
// Check Supabase connection
// --------------------
(async () => {
  try {
    const { data, error } = await supabase.from("profiles").select("id").limit(1);
    if (error) throw error;
    console.log("✅ Supabase connected successfully");
  } catch (err) {
    console.error("❌ Supabase connection failed:", err.message);
  }
})();

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
