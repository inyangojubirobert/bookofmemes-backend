// routes/feeds.js
import express from "express";
import { supabase } from "../config/db.js";

const router = express.Router();

// 🔹 Public feed
router.get("/", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("comments")
      .select(`
        id,
        content,
        user_id,
        item_id,
        item_type,
        created_at,
        profiles:user_id(full_name, avatar_url)
      `)
      .order("created_at", { ascending: false })
     

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error("❌ Public feed error:", err.message);
    res.status(500).json({ error: "Failed to fetch feeds" });
  }
});

// 🔹 Personalized feed
router.get("/user", async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: "Missing userId" });

  try {
    const { data: authorComments, error: authorErr } = await supabase
      .from("comments")
      .select("*, profiles(full_name), item_id, item_type")
      .eq("author_id", userId)
      .order("created_at", { ascending: false });

    if (authorErr) throw authorErr;

    const { data: replies, error: replyErr } = await supabase
      .from("comments")
      .select("*, profiles(full_name), item_id, item_type")
      .in("parent_id", authorComments.map((c) => c.id))
      .order("created_at", { ascending: false });

    if (replyErr) throw replyErr;

    const feeds = [...authorComments, ...replies];
    return res.json(feeds);
  } catch (error) {
    console.error("❌ Personalized feed error:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
