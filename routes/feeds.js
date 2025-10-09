// routes/feeds.js
import express from "express";
import { supabase } from "../config/db.js";

const router = express.Router();

// Personalized feed
router.get("/user", async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: "Missing userId" });

  try {
    // 1️⃣ Comments on items authored by the user
    const { data: authoredComments, error: authoredErr } = await supabase
      .from("comments")
      .select(`
        id,
        content,
        item_id,
        item_type,
        author_id,
        profiles:user_id(full_name),
        item:item_id(title)
      `)
      .eq("item_author_id", userId)
      .order("created_at", { ascending: false });

    if (authoredErr) throw authoredErr;

    // 2️⃣ Replies to comments made by this user
    const { data: replies, error: replyErr } = await supabase
      .from("comments")
      .select(`
        id,
        content,
        parent_id,
        item_id,
        item_type,
        user_id,
        profiles:user_id(full_name),
        item:item_id(title)
      `)
      .in("parent_id", authoredComments.map(c => c.id))
      .order("created_at", { ascending: false });

    if (replyErr) throw replyErr;

    // 3️⃣ Top comments (optional) for users with no activity
    const { data: topComments } = await supabase
      .from("comments")
      .select(`
        id,
        content,
        item_id,
        item_type,
        user_id,
        profiles:user_id(full_name),
        item:item_id(title)
      `)
      .order("likes", { ascending: false })
      .limit(10);

    // 4️⃣ Combine feeds with type labels
    const feeds = [
      ...authoredComments.map(c => ({
        id: c.id,
        type: "item_comment",
        actorName: c.profiles.full_name,
        itemTitle: c.item?.title || c.item_type,
        itemId: c.item_id,
        content: c.content,
      })),
      ...replies.map(r => {
        const originalComment = authoredComments.find(c => c.id === r.parent_id)?.content;
        return {
          id: r.id,
          type: "reply",
          actorName: r.profiles.full_name,
          originalComment,
          itemTitle: r.item?.title || r.item_type,
          itemId: r.item_id,
          content: r.content,
        };
      }),
      // Only include top comments if the user has no authored items or replies
      ...(authoredComments.length + replies.length === 0
        ? topComments.map(c => ({
            id: c.id,
            type: "top_comment",
            actorName: c.profiles.full_name,
            comment: c.content,
            itemTitle: c.item?.title || c.item_type,
            itemId: c.item_id,
          }))
        : []),
    ];

    res.json(feeds);
  } catch (err) {
    console.error("❌ Personalized feed error:", err);
    res.status(500).json({ error: "Failed to fetch feeds" });
  }
});

export default router;
