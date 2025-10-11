router.get("/interactions/:userId", async (req, res) => {
  const { userId } = req.params;
  const { type } = req.query;

  if (!userId) return res.status(400).json({ error: "Missing userId" });

  try {
    // Fetch comments directly
    const { data, error } = await supabase
      .from("comments")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (error) throw error;

    // Optionally fetch profile names separately
    const userIds = [...new Set(data.map(d => d.author_id))];
    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, full_name")
      .in("id", userIds);

    const profileMap = Object.fromEntries(profiles.map(p => [p.id, p.full_name]));

    const result = data.map(item => ({
      id: item.id,
      type: item.parent_id ? "reply" : "item_comment",
      authorName: profileMap[item.author_id] || "Anonymous",
      itemTitle: item.item_type || "Unknown",
      itemId: item.item_id,
      comment: item.content,
    }));

    res.json(result);
  } catch (err) {
    console.error("Error fetching interactions:", err);
    res.status(500).json({ error: err.message });
  }
});
export default router;
