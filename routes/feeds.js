// routes/feeds.js
import express from "express";
import { supabase } from "../config/db.js";

const router = express.Router();

// -----------------------------
// 🔹 Interactions Public Feed
// -----------------------------
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
      .order("created_at", { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error("❌ Public feed error:", err.message);
    res.status(500).json({ error: "Failed to fetch feeds" });
  }
});

// -----------------------------
// 🔹 Interactions Worthy Mentions
// Recommended comments/engagements from friends/followers
// -----------------------------
router.get("/mentions", async (req, res) => {
  const { userId } = req.query; // optional: if you want personalized mentions
  try {
    let query = supabase
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
      .order("created_at", { ascending: false });

    // Example: only include comments by friends/followers if userId provided
    if (userId) {
      const { data: friends, error: friendsErr } = await supabase
        .from("follows") // table storing followers/following
        .select("followed_id")
        .eq("follower_id", userId);

      if (friendsErr) throw friendsErr;

      const friendIds = friends.map(f => f.followed_id);
      query = query.in("user_id", friendIds);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json(data);
  } catch (err) {
    console.error("❌ Mentions fetch error:", err.message);
    res.status(500).json({ error: "Failed to fetch mentions" });
  }
});

// -----------------------------
// 🔹 Personalized Feed (Interactions)
// -----------------------------
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

// -----------------------------
// 🔹 Bid Sessions Public Feed
// -----------------------------
router.get("/bids", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("bids") // make sure this table exists
      .select(`
        id,
        title,
        description,
        user_id,
        created_at,
        profiles:user_id(full_name, avatar_url)
      `)
      .order("created_at", { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error("❌ Bid feeds error:", err.message);
    res.status(500).json({ error: "Failed to fetch bid feeds" });
  }
});

// -----------------------------
// 🔹 Bid Worthy Mentions
// Recommended bids/comments by friends/followers
// -----------------------------
router.get("/bids/mentions", async (req, res) => {
  const { userId } = req.query; // optional for personalized mentions
  try {
    let query = supabase
      .from("bids")
      .select(`
        id,
        title,
        description,
        user_id,
        created_at,
        profiles:user_id(full_name, avatar_url)
      `)
      .order("created_at", { ascending: false });

    if (userId) {
      const { data: friends, error: friendsErr } = await supabase
        .from("follows")
        .select("followed_id")
        .eq("follower_id", userId);

      if (friendsErr) throw friendsErr;

      const friendIds = friends.map(f => f.followed_id);
      query = query.in("user_id", friendIds);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json(data);
  } catch (err) {
    console.error("❌ Bid mentions error:", err.message);
    res.status(500).json({ error: "Failed to fetch bid mentions" });
  }
});

export default router;
