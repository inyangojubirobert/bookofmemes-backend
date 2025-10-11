// routes/feeds.js
import express from "express";
import { supabase } from "../config/db.js";

const router = express.Router();

// --------------------
// Interactions Feed
// --------------------
router.get("/interactions/:userId", async (req, res) => {
  const { userId } = req.params;
  const { type } = req.query; // "feeds" or "mentions"

  if (!userId) return res.status(400).json({ error: "Missing userId" });

  try {
    let query = supabase.from("comments").select(`
      id,
      content,
      item_id,
      item_type,
      author_id,
      parent_id,
      created_at,
      user_id,
      profiles(full_name)
    `);

    if (type === "mentions") {
      query = query.neq("author_id", userId).eq("user_id", userId).limit(10);
    } else {
      query = query.eq("user_id", userId).order("created_at", { ascending: false });
    }

    const { data, error } = await query;
    if (error) throw error;

    const result = (data || []).map(item => ({
      id: item.id,
      type: item.parent_id ? "reply" : "item_comment",
      authorName: item.profiles?.full_name || "Anonymous",
      itemTitle: item.item_type || "Unknown",
      itemId: item.item_id,
      comment: item.content,
      originalComment: item.original_comment || "",
    }));

    res.json(result);
  } catch (err) {
    console.error("Error fetching interactions:", err);
    res.status(500).json({ error: "Failed to fetch interactions" });
  }
});

export default router;
