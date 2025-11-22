import express from "express";
import { supabase } from "../../src/config/supabaseClient.js";

const router = express.Router();

// GET /api/bookmarks?user_id=... - get all bookmarked items for user
router.get("/", async (req, res) => {
  const { user_id, item_type } = req.query;

  if (!user_id) {
    return res.status(400).json({ error: "Missing user_id" });
  }
  let query = supabase.from("bookmarks").select("*").eq("user_id", user_id);
  if (item_type) query = query.eq("item_type", item_type);

  const { data, error } = await query.order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/bookmarks - add bookmark
router.post("/", async (req, res) => {
  const { user_id, item_id, item_type } = req.body;
  if (!user_id || !item_id || !item_type) {
    return res.status(400).json({ error: "Missing user_id, item_id, or item_type" });
  }
  const { data, error } = await supabase
    .from("bookmarks")
    .upsert([{ user_id, item_id, item_type }], { onConflict: 'user_id,item_id,item_type' })
    .select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data[0]);
});

// DELETE /api/bookmarks - remove bookmark
router.delete("/", async (req, res) => {
  const { user_id, item_id, item_type } = req.body;
  if (!user_id || !item_id || !item_type) {
    return res.status(400).json({ error: "Missing user_id, item_id, or item_type" });
  }
  const { error } = await supabase
    .from("bookmarks")
    .delete()
    .eq("user_id", user_id)
    .eq("item_id", item_id)
    .eq("item_type", item_type);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: "Bookmark removed" });
});

// GET /api/bookmarks/users?item_id=....&item_type=.... - who bookmarked a given item
router.get("/users", async (req, res) => {
  const { item_id, item_type } = req.query;
  if (!item_id || !item_type) {
    return res.status(400).json({ error: "Missing item_id or item_type" });
  }
  const { data, error } = await supabase
    .from("bookmarks")
    .select("user_id, created_at")
    .eq("item_id", item_id)
    .eq("item_type", item_type)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

export default router;