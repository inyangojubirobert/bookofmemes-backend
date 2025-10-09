router.get("/feeds/personalized", async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: "Missing userId" });

  try {
    let personalizedFeeds = [];

    // -------------------------
    // A. Feedback on your items
    // -------------------------
    const { data: itemComments } = await supabase
      .from("comments")
      .select(`
        id,
        content,
        item_id,
        item_type,
        item_title,
        user_id,
        profiles:user_id(full_name, avatar_url),
        author:author_id
      `)
      .eq("author_id", userId)
      .order("created_at", { ascending: false });

    itemComments.forEach(comment => {
      personalizedFeeds.push({
        type: "item_comment",
        actorName: comment.profiles.full_name,
        comment: comment.content,
        itemType: comment.item_type,
        itemTitle: comment.item_title,
        itemId: comment.item_id,
        redirectUrl: `/item/${comment.item_id}`,
      });
    });

    // -------------------------
    // B. Replies to user's comments
    // -------------------------
    const { data: userComments } = await supabase
      .from("comments")
      .select("*")
      .eq("user_id", userId);

    const commentIds = userComments.map(c => c.id);

    if (commentIds.length > 0) {
      const { data: replies } = await supabase
        .from("comments")
        .select(`
          id,
          content,
          parent_id,
          user_id,
          profiles:user_id(full_name, avatar_url),
          item_id,
          item_type,
          item_title
        `)
        .in("parent_id", commentIds)
        .order("created_at", { ascending: false });

      replies.forEach(reply => {
        const parentComment = userComments.find(c => c.id === reply.parent_id);
        personalizedFeeds.push({
          type: "reply",
          actorName: reply.profiles.full_name,
          originalComment: parentComment?.content,
          replyContent: reply.content,
          itemType: reply.item_type,
          itemTitle: reply.item_title,
          itemId: reply.item_id,
          redirectUrl: `/item/${reply.item_id}#comment-${reply.id}`,
        });
      });
    }

    // -------------------------
    // C. General top comments
    // -------------------------
    const { data: topComments } = await supabase
      .from("comments")
      .select(`
        id,
        content,
        user_id,
        item_id,
        item_type,
        item_title,
        profiles:user_id(full_name, avatar_url),
        author:author_id
      `)
      .not("user_id", "eq", userId)
      .order("likes", { ascending: false })
      .limit(10);

    topComments.forEach(comment => {
      personalizedFeeds.push({
        type: "top_comment",
        actorName: comment.profiles.full_name,
        comment: comment.content,
        itemType: comment.item_type,
        itemTitle: comment.item_title,
        itemId: comment.item_id,
        redirectUrl: `/item/${comment.item_id}`,
      });
    });

    res.json(personalizedFeeds);
  } catch (err) {
    console.error("❌ Personalized feed error:", err.message);
    res.status(500).json({ error: "Failed to fetch personalized feed" });
  }
});
