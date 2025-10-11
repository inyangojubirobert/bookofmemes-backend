// backend/routes/comments.js
import express from "express";
import { supabase } from "../config/db.js"; // relative to backend folder

const router = express.Router();

// Helper: Check if item exists
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
// GET Comments
// --------------------
router.get("/", async (req, res) => {
  const { itemId } = req.query;

  try {
    let query = supabase
      .from("comments")
      .select(`
        id, content, created_at, user_id, author_id,
        parent_id, item_id, item_type, likes, dislikes,
        profiles:user_id(full_name, avatar_url)
      `)
      .order("created_at", { ascending: true });

    if (itemId) query = query.eq("item_id", itemId);

    const { data: comments, error } = await query;
    if (error) throw error;

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

    // Fetch votes
    const commentIds = commentsWithDefaults.map(c => c.id);
    const { data: votes, error: votesError } = await supabase
      .from("comment_votes")
      .select("user_id, comment_id, vote_type, profiles(full_name, avatar_url)")
      .in("comment_id", commentIds);

    if (votesError) throw votesError;

    // Attach votes
    commentsWithDefaults.forEach(comment => {
      votes.filter(v => v.comment_id === comment.id).forEach(v => {
        if (v.vote_type === "like") {
          comment.liked_users.push({
            user_id: v.user_id,
            full_name: v.profiles?.full_name || "Unknown",
            avatar_url: v.profiles?.avatar_url || "https://via.placeholder.com/36",
          });
        } else if (v.vote_type === "dislike") {
          comment.disliked_users.push({
            user_id: v.user_id,
            full_name: v.profiles?.full_name || "Unknown",
            avatar_url: v.profiles?.avatar_url || "https://via.placeholder.com/36",
          });
        }
      });
    });

    // Thread replies
    const map = {};
    const roots = [];
    commentsWithDefaults.forEach(c => map[c.id] = { ...c, replies: [] });
    commentsWithDefaults.forEach(c => {
      if (c.parent_id) map[c.parent_id]?.replies.push(map[c.id]);
      else roots.push(map[c.id]);
    });

    res.json(roots);
  } catch (err) {
    console.error("Error fetching comments:", err);
    res.status(500).json({ error: "Failed to fetch comments" });
  }
});

// --------------------
// POST Comment
// --------------------
router.post("/", async (req, res) => {
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
    console.error("Error posting comment:", err);
    res.status(500).json({ error: "Failed to post comment", details: err.message });
  }
});

export default router;
