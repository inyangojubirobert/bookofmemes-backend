// routes/comments.js
import express from "express";
import { supabase } from "../config/db.js";

const router = express.Router();

// 🟢 Get all comments for an item
router.get("/", async (req, res) => {
  const { itemId } = req.query;
  if (!itemId) return res.status(400).json({ error: "Missing itemId" });

  try {
    const { data, error } = await supabase
      .from("comments")
      .select(`
        id,
        content,
        user_id,
        item_id,
        item_type,
        parent_id,
        created_at,
        likes,
        dislikes,
        profiles:user_id(full_name, avatar_url)
      `)
      .eq("item_id", itemId)
      .order("created_at", { ascending: true });

    if (error) throw error;

    // Nest replies under parent comments
    const commentMap = {};
    const topLevel = [];

    data.forEach((comment) => {
      comment.replies = [];
      commentMap[comment.id] = comment;
    });

    data.forEach((comment) => {
      if (comment.parent_id) {
        commentMap[comment.parent_id]?.replies.push(comment);
      } else {
        topLevel.push(comment);
      }
    });

    res.json(topLevel);
  } catch (err) {
    console.error("Error fetching comments:", err.message);
    res.status(500).json({ error: "Failed to fetch comments" });
  }
});

// 🟢 Post a new comment
router.post("/", async (req, res) => {
  const { content, user_id, author_id, item_id, item_type, parent_id } = req.body;

  if (!content || !user_id || !item_id || !item_type)
    return res.status(400).json({ error: "Missing required fields" });

  try {
    const { data, error } = await supabase
      .from("comments")
      .insert([
        { content, user_id, author_id, item_id, item_type, parent_id: parent_id || null },
      ])
      .select(`
        id,
        content,
        user_id,
        item_id,
        item_type,
        created_at,
        profiles:user_id(full_name, avatar_url)
      `)
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error("Error posting comment:", err.message);
    res.status(500).json({ error: "Failed to post comment" });
  }
});

// 🟢 Vote on a comment
router.post("/:id/vote", async (req, res) => {
  const { id } = req.params;
  const { vote_type } = req.body; // "like" or "dislike"

  try {
    const { data: commentData, error: fetchError } = await supabase
      .from("comments")
      .select("likes, dislikes")
      .eq("id", id)
      .single();

    if (fetchError) throw fetchError;

    const updates =
      vote_type === "like"
        ? { likes: commentData.likes + 1 }
        : { dislikes: commentData.dislikes + 1 };

    const { data, error: updateError } = await supabase
      .from("comments")
      .update(updates)
      .eq("id", id)
      .select()
      .single();

    if (updateError) throw updateError;

    res.json(data);
  } catch (err) {
    console.error("Error voting:", err.message);
    res.status(500).json({ error: "Failed to vote" });
  }
});

// 🟢 Delete a comment
router.delete("/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const { error } = await supabase.from("comments").delete().eq("id", id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error("Error deleting comment:", err.message);
    res.status(500).json({ error: "Failed to delete comment" });
  }
});

export default router;
