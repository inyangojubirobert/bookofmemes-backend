// routes/bookmarks.js
import express from "express";
import { supabase } from "../config/db.js";

const router = express.Router();

/**
 * GET /api/bookmarks?user_id=...
 * Returns enriched bookmarks with item details (title, author, cover, item_type).
 */
router.get("/", async (req, res) => {
  const { user_id } = req.query;
  if (!user_id) {
    return res.status(400).json({ error: "Missing user_id" });
  }

  try {
    // Fetch all bookmarks for this user
    const { data: bookmarks, error } = await supabase
      .from("bookmarks")
      .select("*")
      .eq("user_id", user_id)
      .order("created_at", { ascending: false });

    if (error) throw error;

    // Enrich bookmarks by joining with item tables
    const enriched = [];
    for (const bm of bookmarks) {
      let itemDetails = null;
      let author = null;
      let cover = null;

      if (bm.item_type === "stories") {
        const { data: story } = await supabase
          .from("stories")
          .select("id, title, author_id")
          .eq("id", bm.item_id)
          .single();
        itemDetails = story;
        if (story?.author_id) {
          const { data: profile } = await supabase
            .from("profiles")
            .select("full_name, avatar_url")
            .eq("id", story.author_id)
            .single();
          author = profile;
        }
        const { data: coverRow } = await supabase
          .from("content_covers")
          .select("image_url")
          .eq("item_id", bm.item_id)
          .eq("item_type", "stories")
          .eq("is_main_cover", true)
          .single();
        cover = coverRow?.image_url || null;
      }

      if (bm.item_type === "memes") {
        const { data: meme } = await supabase
          .from("memes")
          .select("id, title, author_id")
          .eq("id", bm.item_id)
          .single();
        itemDetails = meme;
        if (meme?.author_id) {
          const { data: profile } = await supabase
            .from("profiles")
            .select("full_name, avatar_url")
            .eq("id", meme.author_id)
            .single();
          author = profile;
        }
        const { data: coverRow } = await supabase
          .from("content_covers")
          .select("image_url")
          .eq("item_id", bm.item_id)
          .eq("item_type", "memes")
          .eq("is_main_cover", true)
          .single();
        cover = coverRow?.image_url || null;
      }

      if (bm.item_type === "puzzles") {
        const { data: puzzle } = await supabase
          .from("puzzles")
          .select("id, title, author_id")
          .eq("id", bm.item_id)
          .single();
        itemDetails = puzzle;
        if (puzzle?.author_id) {
          const { data: profile } = await supabase
            .from("profiles")
            .select("full_name, avatar_url")
            .eq("id", puzzle.author_id)
            .single();
          author = profile;
        }
        const { data: coverRow } = await supabase
          .from("content_covers")
          .select("image_url")
          .eq("item_id", bm.item_id)
          .eq("item_type", "puzzles")
          .eq("is_main_cover", true)
          .single();
        cover = coverRow?.image_url || null;
      }

      if (bm.item_type === "kids_collections") {
        const { data: kid } = await supabase
          .from("kids_collections")
          .select("id, title, author_id")
          .eq("id", bm.item_id)
          .single();
        itemDetails = kid;
        if (kid?.author_id) {
          const { data: profile } = await supabase
            .from("profiles")
            .select("full_name, avatar_url")
            .eq("id", kid.author_id)
            .single();
          author = profile;
        }
        const { data: coverRow } = await supabase
          .from("content_covers")
          .select("image_url")
          .eq("item_id", bm.item_id)
          .eq("item_type", "kids_collections")
          .eq("is_main_cover", true)
          .single();
        cover = coverRow?.image_url || null;
      }

      enriched.push({
        bookmark_id: bm.id,
        item_id: bm.item_id,
        item_type: bm.item_type,
        created_at: bm.created_at,
        title: itemDetails?.title || "Untitled",
        author_name: author?.full_name || "Unknown Author",
        author_avatar: author?.avatar_url || null,
        cover_image_url: cover,
      });
    }

    res.json(enriched);
  } catch (err) {
    console.error("GET /api/bookmarks error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

export default router;
