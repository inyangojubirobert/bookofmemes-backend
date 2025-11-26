// routes/bookmarks.js
import express from "express";
import { supabase } from "../config/db.js";

const router = express.Router();

/**
 * GET /api/bookmarks
 * Returns enriched bookmarks directly from the user_bookmarks view.
 * RLS ensures users only see their own bookmarks, so no user_id param is needed.
 */
router.get("/", async (req, res) => {
  try {
    // Base query
    let query = supabase
      .from("user_bookmarks")
      .select("*")
      .order("created_at", { ascending: false });

    // Optional filters
    if (req.query.item_type) {
      query = query.eq("item_type", req.query.item_type);
    }
    if (req.query.search) {
      const search = `%${req.query.search}%`;
      query = query.ilike("title", search);
    }

    const { data, error } = await query;

    if (error) {
      console.error("Supabase error:", error);
      return res.status(500).json({ error: error.message });
    }

    res.json(data || []);
  } catch (err) {
    console.error("GET /api/bookmarks error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

export default router;
