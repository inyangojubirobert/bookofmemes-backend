// routes/feeds.js
import express from "express";
import { supabase } from "../config/db.js";

const router = express.Router();

//
// --------------------
// GLOBAL FEED: /feeds
// --------------------
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
        profiles:user_id(full_name),
        universal_items(title, author_id)
      `)
      .order("created_at", { ascending: false })
      .limit(20);

    if (error) throw error;

    // Collect all author IDs for reference resolution
    const authorIds = [
      ...new Set(data.map(c => c.universal_items?.author_id).filter(Boolean)),
    ];

    let authorProfiles = {};
    if (authorIds.length > 0) {
      const { data: authors, error: profileErr } = await supabase
        .from("profiles")
        .select("id, full_name")
        .in("id", authorIds);
      if (profileErr) throw profileErr;

      authors?.forEach(a => {
        authorProfiles[a.id] = a.full_name;
      });
    }

    const feeds = data.map(c => ({
      id: c.id,
      actorName: c.profiles?.full_name || "Anonymous",
      authorName: authorProfiles[c.universal_items?.author_id] || "Unknown Author",
      itemTitle: c.universal_items?.title || c.item_type,
      itemId: c.item_id,
      type: c.parent_id ? "reply" : "item_comment",
      comment: c.content,
      created_at: c.created_at,
    }));

    res.json(feeds);
  } catch (err) {
    console.error("❌ Error fetching feeds:", err);
    res.status(500).json({ error: "Failed to fetch feeds" });
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
        profiles:user_id(full_name),
        universal_items(title, author_id)
      `)
      .eq("universal_items.author_id", userId)
      .order("created_at", { ascending: false });

    if (commentErr) throw commentErr;

    // 2️⃣ Replies to comments made by this user
    const userCommentIds = itemComments.map(c => c.id);
    const { data: replies, error: replyErr } = await supabase
      .from("comments")
      .select(`
        id,
        content,
        parent_id,
        item_id,
        item_type,
        created_at,
        profiles:user_id(full_name),
        universal_items(title)
      `)
      .in("parent_id", userCommentIds)
      .order("created_at", { ascending: false });

    if (replyErr) throw replyErr;

    // 3️⃣ Top comments if user has no interactions
    const { data: topComments, error: topErr } = await supabase
      .from("comments")
      .select(`
        id,
        content,
        item_id,
        item_type,
        user_id,
        profiles:user_id(full_name),
        universal_items(title)
      `)
      .order("likes", { ascending: false })
      .limit(10);

    if (topErr) throw topErr;

    // 4️⃣ Merge logic for personalized feed
    const feeds = [
      ...itemComments.map(c => ({
        id: c.id,
        type: "item_comment",
        actorName: c.profiles?.full_name || "Anonymous",
        itemTitle: c.universal_items?.title || c.item_type,
        itemId: c.item_id,
        content: c.content,
      })),
      ...replies.map(r => {
        const parent = itemComments.find(c => c.id === r.parent_id);
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
      ...(itemComments.length + replies.length === 0
        ? topComments.map(c => ({
            id: c.id,
            type: "top_comment",
            actorName: c.profiles?.full_name || "Anonymous",
            comment: c.content,
            itemTitle: c.universal_items?.title || c.item_type,
            itemId: c.item_id,
          }))
        : []),
    ];

    res.json(feeds);
  } catch (err) {
    console.error("❌ Personalized feed error:", err);
    res.status(500).json({ error: "Failed to fetch personalized feeds" });
  }
});

export default router;
