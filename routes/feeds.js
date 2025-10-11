// backend/routes/feeds.js
import express from "express";
import { supabase } from "../config/db.js";

const router = express.Router();

// --------------------
// 1. Get all feeds for a user
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

// --------------------
// 2. Optionally: Fetch feeds by specific item
// --------------------
router.get("/item/:itemId", async (req, res) => {
  const { itemId } = req.params;
  if (!itemId) return res.status(400).json({ error: "Missing itemId" });

  try {
    const { data, error } = await supabase
      .from("feeds")
      .select("id, image_url, caption, author_id, created_at, profiles(full_name)")
      .eq("id", itemId)
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Feed not found" });

    res.json({
      id: data.id,
      image_url: data.image_url,
      caption: data.caption,
      author_name: data.profiles?.full_name || "Unknown",
      created_at: data.created_at,
    });
  } catch (err) {
    console.error("Error fetching feed:", err);
    res.status(500).json({ error: "Failed to fetch feed" });
  }
});

// --------------------
// 3. Fetch mentions for a user
// --------------------
router.get("/mentions/:userId", async (req, res) => {
  const { userId } = req.params;
  if (!userId) return res.json([]);

  try {
    const { data, error } = await supabase
      .from("mentions")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error("Error fetching mentions:", err);
    res.status(500).json({ error: "Failed to fetch mentions" });
  }
});

// --------------------
// 4. Fetch combined feed (stories + feeds)
// --------------------
router.get("/combined/:userId", async (req, res) => {
  const { userId } = req.params;
  if (!userId) return res.status(400).json({ error: "Missing userId" });

  try {
    const { data: stories, error: storiesErr } = await supabase
      .from("stories")
      .select("id, story_title, author_id")
      .order("created_at", { ascending: false });

    if (storiesErr) throw storiesErr;

    const { data: feeds, error: feedsErr } = await supabase
      .from("feeds")
      .select("id, caption, image_url, author_id, created_at")
      .order("created_at", { ascending: false });

    if (feedsErr) throw feedsErr;

    res.json({
      stories: stories || [],
      feeds: feeds || [],
    });
  } catch (err) {
    console.error("Error fetching combined feed:", err);
    res.status(500).json({ error: "Failed to fetch combined feed" });
  }
});

export default router;
