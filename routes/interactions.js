// Backend/routes/interactions.js
import express from "express";
import { supabase } from "../../src/config/supabaseClient.js";

const router = express.Router();

/**
 * GET /api/interactions
 * Query params: user_id, item_id, item_type, interaction_type
 * Returns matching interaction rows (most recent first).
 */
router.get("/", async (req, res) => {
  const { user_id, item_id, item_type, interaction_type } = req.query;

  try {
    let query = supabase.from("interactions").select("*");
    if (user_id) query = query.eq("user_id", user_id);
    if (item_id) query = query.eq("item_id", item_id);
    if (item_type) query = query.eq("item_type", item_type);
    if (interaction_type) query = query.eq("interaction_type", interaction_type);

    const { data, error } = await query.order("created_at", { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error("GET /api/interactions error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

/**
 * POST /api/interactions
 * Body: { user_id, item_id, item_type, interaction_type }
 * Upserts an interaction (ensures uniqueness per user+item+type+interaction_type).
 */
router.post("/", async (req, res) => {
  const { user_id, item_id, item_type, interaction_type } = req.body;
  if (!user_id || !item_id || !item_type || !interaction_type) {
    return res.status(400).json({ error: "Missing user_id, item_id, item_type, or interaction_type" });
  }

  try {
    // Use upsert to avoid duplicates (unique constraint defined in DB)
    const { data, error } = await supabase
      .from("interactions")
      .upsert(
        [{ user_id, item_id, item_type, interaction_type }],
        { onConflict: ["user_id", "item_id", "item_type", "interaction_type"] }
      )
      .select();

    if (error) throw error;
    res.json(Array.isArray(data) && data[0] ? data[0] : data);
  } catch (err) {
    console.error("POST /api/interactions error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

/**
 * DELETE /api/interactions
 * Body: { user_id, item_id, item_type, interaction_type }
 * Deletes a specific interaction.
 */
router.delete("/", async (req, res) => {
  const { user_id, item_id, item_type, interaction_type } = req.body;
  if (!user_id || !item_id || !item_type || !interaction_type) {
    return res.status(400).json({ error: "Missing user_id, item_id, item_type, or interaction_type" });
  }

  try {
    const { error } = await supabase
      .from("interactions")
      .delete()
      .eq("user_id", user_id)
      .eq("item_id", item_id)
      .eq("item_type", item_type)
      .eq("interaction_type", interaction_type);

    if (error) throw error;
    res.json({ message: "Interaction removed" });
  } catch (err) {
    console.error("DELETE /api/interactions error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

/**
 * GET /api/interactions/counts?item_id=...&item_type=...
 * Returns an object { like: n, comment: n, view: n, bookmark: n, share: n }
 */
router.get("/counts", async (req, res) => {
  const { item_id, item_type } = req.query;
  if (!item_id || !item_type) {
    return res.status(400).json({ error: "Missing item_id or item_type" });
  }

  try {
    // Group counts by interaction_type
    const { data, error } = await supabase
      .from("interactions")
      .select("interaction_type", { count: "exact" })
      .eq("item_id", item_id)
      .eq("item_type", item_type)
      .group("interaction_type");

    if (error) throw error;

    // Normalize to expected keys
    const counts = { like: 0, comment: 0, view: 0, bookmark: 0, share: 0 };
    if (Array.isArray(data)) {
      data.forEach((row) => {
        // Depending on Supabase/PostgREST output shape, row will have interaction_type and count
        // Some setups return { interaction_type: 'like', count: '3' } or { interaction_type: 'like', count: 3 }
        const k = row.interaction_type;
        const v = Number(row.count ?? row.count_exact ?? 0);
        if (k) counts[k] = Number.isFinite(v) ? v : counts[k];
      });
    }
    res.json(counts);
  } catch (err) {
    console.error("GET /api/interactions/counts error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

/**
 * GET /api/interactions/users?item_id=...&item_type=...&interaction_type=...
 * Returns list of users who performed a given interaction on an item.
 */
router.get("/users", async (req, res) => {
  const { item_id, item_type, interaction_type } = req.query;
  if (!item_id || !item_type || !interaction_type) {
    return res.status(400).json({ error: "Missing item_id, item_type, or interaction_type" });
  }

  try {
    const { data, error } = await supabase
      .from("interactions")
      .select("user_id, created_at")
      .eq("item_id", item_id)
      .eq("item_type", item_type)
      .eq("interaction_type", interaction_type)
      .order("created_at", { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error("GET /api/interactions/users error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

export default router;
