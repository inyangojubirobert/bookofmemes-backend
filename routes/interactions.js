import express from "express";
import { supabase } from "../../src/config/supabaseClient.js";

const router = express.Router();

// GET /api/interactions?user_id=...&item_type=...&interaction_type=...&item_id=...
router.get("/", async (req, res) => {
  const { user_id, item_id, item_type, interaction_type } = req.query;

  let query = supabase.from("interactions").select("*");
  if (user_id) query = query.eq("user_id", user_id);
  if (item_id) query = query.eq("item_id", item_id);
  if (item_type) query = query.eq("item_type", item_type);
  if (interaction_type) query = query.eq("interaction_type", interaction_type);

  const { data, error } = await query.order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/interactions - add or upsert an interaction
router.post("/", async (req, res) => {
  const { user_id, item_id, item_type, interaction_type } = req.body;
  if (!user_id || !item_id || !item_type || !interaction_type) {
    return res.status(400).json({ error: "Missing user_id, item_id, item_type, or interaction_type" });
  }
  const { data, error } = await supabase
    .from("interactions")
    .upsert([{ user_id, item_id, item_type, interaction_type }], { onConflict: 'user_id,item_id,item_type,interaction_type' })
    .select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data[0]);
});

// DELETE /api/interactions - remove an interaction
router.delete("/", async (req, res) => {
  const { user_id, item_id, item_type, interaction_type } = req.body;
  if (!user_id || !item_id || !item_type || !interaction_type) {
    return res.status(400).json({ error: "Missing user_id, item_id, item_type, or interaction_type" });
  }
  const { error } = await supabase
    .from("interactions")
    .delete()
    .eq("user_id", user_id)
    .eq("item_id", item_id)
    .eq("item_type", item_type)
    .eq("interaction_type", interaction_type);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: "Interaction removed" });
});

// GET /api/interactions/users?item_id=...&item_type=...&interaction_type=...
router.get("/users", async (req, res) => {
  const { item_id, item_type, interaction_type } = req.query;
  if (!item_id || !item_type || !interaction_type) {
    return res.status(400).json({ error: "Missing item_id, item_type, or interaction_type" });
  }
  const { data, error } = await supabase
    .from("interactions")
    .select("user_id, created_at")
    .eq("item_id", item_id)
    .eq("item_type", item_type)
    .eq("interaction_type", interaction_type)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

export default router;