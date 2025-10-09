// routes/feeds.js
import express from "express";
import { supabase } from "../config/db.js";

const router = express.Router();

//
// --------------------
// GLOBAL FEED: /feeds
// --------------------

// GET /feeds
router.get("/", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("comments")
      .select(`
        id,
        content,
        item_id,
        item_type,
        author_id,
        parent_id,
        created_at,
        user_id,
        profiles!inner(full_name),
        universal_items!inner(title, author_id)
      `)
      .order("created_at", { ascending: false })
      .limit(20);

    if (error) throw error;

    const feeds = Array.isArray(data)
      ? data.map((c) => ({
          id: c.id,
          actorName: c.profiles?.full_name || "Anonymous",
          authorName: c.universal_items?.author_id || "Unknown Author",
          itemTitle: c.universal_items?.title || c.item_type,
          itemId: c.item_id,
          type: c.parent_id ? "reply" : "item_comment",
          comment: c.content,
          created_at: c.created_at,
        }))
      : [];

    res.json(feeds);
  } catch (err) {
    console.error("❌ Error fetching feeds:", err);
    res.status(500).json({ error: "Failed to fetch feeds" });
  }
});

//
// --------------------
// MENTIONS: /feeds/mentions
// --------------------
router.get("/mentions", async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: "Missing userId" });

    const { data, error } = await supabase
      .from("comments")
      .select(`
        id,
        content,
        item_id,
        item_type,
        author_id,
        parent_id,
        created_at,
        profiles!inner(full_name),
        universal_items!inner(title)
      `)
      // Example: filter comments containing @userId
      .or(`content.ilike.%@${userId}%`)
      .order("created_at", { ascending: false })
      .limit(20);

    if (error) throw error;

    res.json(Array.isArray(data) ? data : []);
  } catch (err) {
    console.error("❌ Error fetching mentions:", err);
    res.status(500).json({ error: "Failed to fetch mentions" });
  }
});

//
// ------------------------------
// PERSONALIZED FEED: /feeds/user
// ------------------------------
router.get("/user", async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: "Missing userId" });

  try {
    // 1️⃣ Comments on items authored by this user
    const { data: itemComments, error: commentErr } = await supabase
      .from("comments")
      .select(`
        id,
        content,
        item_id,
        item_type,
        author_id,
        created_at,
        profiles!inner(full_name),
        universal_items!inner(title, author_id)
      `)
      .eq("universal_items.author_id", userId)
      .order("created_at", { ascending: false });

    if (commentErr) throw commentErr;

    const userCommentIds = Array.isArray(itemComments)
      ? itemComments.map((c) => c.id)
      : [];

    // 2️⃣ Replies to user's comments
    const { data: replies, error: replyErr } = userCommentIds.length
      ? await supabase
          .from("comments")
          .select(`
            id,
            content,
            parent_id,
            item_id,
            item_type,
            created_at,
            profiles!inner(full_name),
            universal_items!inner(title)
          `)
          .in("parent_id", userCommentIds)
          .order("created_at", { ascending: false })
      : { data: [], error: null };

    if (replyErr) throw replyErr;

    // 3️⃣ Top comments if no interactions
    const { data: topComments, error: topErr } =
      (itemComments?.length || 0) + (replies?.length || 0) === 0
        ? await supabase
            .from("comments")
            .select(`
              id,
              content,
              item_id,
              item_type,
              user_id,
              profiles!inner(full_name),
              universal_items!inner(title)
            `)
            .order("likes", { ascending: false })
            .limit(10)
        : { data: [], error: null };

    if (topErr) throw topErr;

    // Merge feeds
    const feeds = [
      ...(itemComments || []).map((c) => ({
        id: c.id,
        type: "item_comment",
        actorName: c.profiles?.full_name || "Anonymous",
        itemTitle: c.universal_items?.title || c.item_type,
        itemId: c.item_id,
        content: c.content,
      })),
      ...(replies || []).map((r) => {
        const parent = itemComments.find((c) => c.id === r.parent_id);
        return {
          id: r.id,
          type: "reply",
          actorName: r.profiles?.full_name || "Anonymous",
          originalComment: parent?.content || "Your comment",
          itemTitle: r.universal_items?.title || r.item_type,
          itemId: r.item_id,
          content: r.content,
        };
      }),
      ...(topComments || []).map((c) => ({
        id: c.id,
        type: "top_comment",
        actorName: c.profiles?.full_name || "Anonymous",
        comment: c.content,
        itemTitle: c.universal_items?.title || c.item_type,
        itemId: c.item_id,
      })),
    ];

    res.json(feeds);
  } catch (err) {
    console.error("❌ Personalized feed error:", err);
    res.status(500).json({ error: "Failed to fetch personalized feeds" });
  }
});

export default router;
