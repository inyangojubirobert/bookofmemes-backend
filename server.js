

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { supabase } from "./config/db.js";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 5001;



// 1. JSON parser
app.use(express.json());

// 2. CORS
app.use(cors({
  origin: "*", // or restrict to your frontend domain
}));

// ...existing code...



// GET /api/users/:id/following - get users this user is following
app.get("/api/users/:id/followers", async (req, res) => {
  const { id } = req.params;
  try {
    const { data, error } = await supabase
      .from("follows")
      .select("follower_id, profiles:follower_id(full_name, avatar_url)")
      .eq("following_id", id);
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error("Fetch followers error:", err);
    res.status(500).json({ error: "Failed to fetch followers" });
  }
});
app.get("/api/users/:id/following", async (req, res) => {
  const { id } = req.params;
  try {
    const { data, error } = await supabase
      .from("follows")
      .select("following_id, profiles:following_id(full_name, avatar_url)")
      .eq("follower_id", id);
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error("Fetch following error:", err);
    res.status(500).json({ error: "Failed to fetch following" });
  }
});
// POST /api/follow - follow a user
app.post("/api/follow", async (req, res) => {
  const { follower_id, following_id } = req.body;

  if (!follower_id || !following_id) {
    return res.status(400).json({ error: "Missing follower_id or following_id" });
  }

  try {
    const { data, error } = await supabase
      .from("follows")
      .insert([{ follower_id, following_id }])
      .select();

    if (error) throw error;
    res.json({ message: "Followed successfully", data });
  } catch (err) {
    console.error("Follow error:", err);
    res.status(500).json({ error: "Failed to follow user" });
  }
});

// DELETE /api/follow - unfollow a user
app.delete("/api/follow", async (req, res) => {
  const { follower_id, following_id } = req.body;

  if (!follower_id || !following_id) {
    return res.status(400).json({ error: "Missing follower_id or following_id" });
  }

  try {
    const { error } = await supabase
      .from("follows")
      .delete()
      .eq("follower_id", follower_id)
      .eq("following_id", following_id);

    if (error) throw error;
    res.json({ message: "Unfollowed successfully" });
  } catch (err) {
    console.error("Unfollow error:", err);
    res.status(500).json({ error: "Failed to unfollow user" });
  }
});

app.get("/api/users/:id/posts/count", async (req, res) => {
  const { id } = req.params;
  try {
    // Count stories
    const { data: stories, error: storiesError } = await supabase
      .from("stories")
      .select("id", { count: "exact" })
      .eq("author_id", id);

    // Count memes
    const { data: memes, error: memesError } = await supabase
      .from("memes")
      .select("id", { count: "exact" })
      .eq("author_id", id);

    // Count puzzles
    const { data: puzzles, error: puzzlesError } = await supabase
      .from("puzzles")
      .select("id", { count: "exact" })
      .eq("author_id", id);

    // Count kids_collections
    const { data: kidsCollections, error: kidsError } = await supabase
      .from("kids_collections")
      .select("id", { count: "exact" })
      .eq("author_id", id);

    // Throw if any query failed
    if (storiesError || memesError || puzzlesError || kidsError)
      throw storiesError || memesError || puzzlesError || kidsError;

    const totalPosts =
      (stories?.length || 0) +
      (memes?.length || 0) +
      (puzzles?.length || 0) +
      (kidsCollections?.length || 0);

    res.json({ postsCount: totalPosts });
  } catch (err) {
    console.error("Error counting posts:", err);
    res.status(500).json({ error: "Failed to count posts" });
  }
});

app.get("/api/users/:id", async (req, res) => {
  const { id } = req.params;

  try {
    // Fetch basic profile
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("id, full_name, username, bio, avatar_url")
      .eq("id", id)
      .single();

    if (profileError && profileError.code !== "PGRST116") throw profileError;
    if (!profile) return res.status(404).json({ error: "User profile not found" });

    // Count posts (using head: true for performance)
    const [stories, memes, puzzles, kids] = await Promise.all([
      supabase.from("stories").select("id", { count: "exact", head: true }).eq("author_id", id),
      supabase.from("memes").select("id", { count: "exact", head: true }).eq("author_id", id),
      supabase.from("puzzles").select("id", { count: "exact", head: true }).eq("author_id", id),
      supabase.from("kids_collections").select("id", { count: "exact", head: true }).eq("author_id", id),
    ]);

    const totalPosts =
      (stories.count || 0) +
      (memes.count || 0) +
      (puzzles.count || 0) +
      (kids.count || 0);

    // Followers / Following counts
    const followersRes = await supabase
      .from("follows")
      .select("id", { count: "exact", head: true })
      .eq("following_id", id);

    const followingRes = await supabase
      .from("follows")
      .select("id", { count: "exact", head: true })
      .eq("follower_id", id);

    return res.json({
      ...profile,
      postsCount: totalPosts,
      followersCount: followersRes.count || 0,
      followingCount: followingRes.count || 0,
    });
  } catch (err) {
    console.error("Fetch user error:", err);
    return res.status(500).json({ error: "Failed to fetch user" });
  }
});


// GET /api/follow/status?follower=xxx&following=yyy
app.get("/api/follow/status", async (req, res) => {
  const { follower, following } = req.query;

  if (!follower || !following) {
    return res.status(400).json({ error: "Missing follower or following" });
  }

  try {
    const { data, error } = await supabase
      .from("follows")
      .select("id")
      .eq("follower_id", follower)
      .eq("following_id", following)
      .single();

    if (error && error.code !== "PGRST116") throw error;

    res.json({ isFollowing: !!data });
  } catch (err) {
    console.error("Follow status error:", err);
    res.status(500).json({ error: "Failed to check follow status" });
  }
});




// --------------------
// Mount Routers
// --------------------
import walletTransactionsRouter from "./routes/walletTransactions.js";
app.use("/api/wallet-transactions", walletTransactionsRouter);
app.get("/api/stories", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("stories")
      .select("id, title, author_id");

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error("Error fetching stories:", err);
    res.status(500).json({ error: "Failed to fetch stories" });
  }
});
// --------------------
// Feeds API
// --------------------
// server.js (already partly done)



// --------------------
// Mentions API
// --------------------
// server.js (or better: create routes/feeds.js)

app.get("/api/stories/:id/chapters", async (req, res) => {
  const { id } = req.params;

  try {
    const { data: story, error: storyError } = await supabase
      .from("stories")
      .select("id, title, author_id")
      .eq("id", id)
      .single();

    if (storyError || !story) throw storyError || new Error("Story not found");

    const { data: chapters, error: chaptersError } = await supabase
      .from("chapters")
      .select("*")
      .eq("story_id", id)
      .order("chapter_number", { ascending: true });

    if (chaptersError) throw chaptersError;

    res.json({ story, chapters });
  } catch (err) {
    console.error("Error fetching story + chapters:", err);
    res.status(500).json({ error: "Failed to fetch story + chapters" });
  }
});

// --------------------
// Comments API
// --------------------
app.get("/api/comments", async (req, res) => {
  const { itemId, authorId, excludeSelf, limit, minLikes } = req.query; // optional filters

  try {
    // Build base query
    let query = supabase
      .from("comments")
      .select(`
        id, content, created_at, user_id, author_id,
        parent_id, item_id, item_type, likes, dislikes,
        profiles:user_id(full_name, avatar_url)
      `)
      .order("created_at", { ascending: false });

    // Apply item filter if itemId is provided
    if (itemId) query = query.eq("item_id", itemId);

    // Apply author filter to return comments addressed to an author's items
    if (authorId) query = query.eq("author_id", authorId);

    // Optionally exclude self-comments (author commenting on own item)
    if (authorId && (excludeSelf === "true" || excludeSelf === "1")) {
      query = query.neq("user_id", authorId);
    }

    // Optional minLikes
    if (typeof minLikes !== 'undefined') {
      const ml = Number(minLikes);
      if (!Number.isNaN(ml)) {
        query = query.gte("likes", ml);
      }
    }

    // Optional limit
    if (limit) {
      const n = Number(limit);
      if (!Number.isNaN(n) && n > 0) query = query.limit(n);
    }

    const { data: comments, error } = await query;
    if (error) throw error;

    // Add defaults and placeholders
    const commentsWithDefaults = comments.map(c => ({
      ...c,
      profiles: {
        full_name: c.profiles?.full_name || "Unknown",
        avatar_url: c.profiles?.avatar_url || "https://via.placeholder.com/36",
      },
      replies: [],
      liked_users: [],
      disliked_users: [],
    }));

    // Fetch votes for all comments
    const commentIds = commentsWithDefaults.map(c => c.id);
    const { data: votes, error: votesError } = await supabase
      .from("comment_votes")
      .select("user_id, comment_id, vote_type, profiles(full_name, avatar_url)")
      .in("comment_id", commentIds);

    if (votesError) throw votesError;

    // Attach votes to comments
    commentsWithDefaults.forEach(comment => {
      votes.filter(v => v.comment_id === comment.id).forEach(v => {
        if (v.vote_type === "like") {
          comment.liked_users.push({
            user_id: v.user_id,
            full_name: v.profiles?.full_name || "Unknown",
            avatar_url: v.profiles?.avatar_url || "https://via.placeholder.com/36"
          });
        } else if (v.vote_type === "dislike") {
          comment.disliked_users.push({
            user_id: v.user_id,
            full_name: v.profiles?.full_name || "Unknown",
            avatar_url: v.profiles?.avatar_url || "https://via.placeholder.com/36"
          });
        }
      });
    });

    // Build threaded structure
    const map = {};
    const roots = [];
    commentsWithDefaults.forEach(c => map[c.id] = { ...c, replies: [] });
    commentsWithDefaults.forEach(c => {
      if (c.parent_id) map[c.parent_id]?.replies.push(map[c.id]);
      else roots.push(map[c.id]);
    });

    res.json(roots);
  } catch (err) {
    console.error("Server error fetching comments:", err);
    res.status(500).json({ error: "Failed to fetch comments" });
  }
});


app.post("/api/comments", async (req, res) => {
  const { content, user_id, item_id, item_type, parent_id } = req.body;
  if (!content || !user_id || !item_id) return res.status(400).json({ error: "Missing required fields" });

  // Helper: check if item exists in any content table
  async function itemExists(itemId) {
    // Try stories, memes, puzzles, kids_collections
    const tables = ["stories", "memes", "puzzles", "kids_collections"];
    for (const table of tables) {
      const { data, error } = await supabase.from(table).select("id").eq("id", itemId).maybeSingle();
      if (data && data.id) return true;
    }
    return false;
  }

  // Helper: get the owner/author of the item
  async function getItemOwnerId(itemId) {
    const tables = ["stories", "memes", "puzzles", "kids_collections"];
    for (const table of tables) {
      const { data, error } = await supabase.from(table).select("author_id").eq("id", itemId).maybeSingle();
      if (data && data.author_id) return data.author_id;
    }
    return null;
  }

  const exists = await itemExists(item_id);
  if (!exists) return res.status(404).json({ error: "Item not found" });

  try {
    // Identify the item's owner to properly address the comment to the author
    const ownerId = await getItemOwnerId(item_id);
    if (!ownerId) return res.status(400).json({ error: "Could not resolve item owner" });

    // If this is a reply, parent_id must exist in comments
    if (parent_id) {
      const { data: parentComment, error: parentError } = await supabase
        .from("comments")
        .select("id")
        .eq("id", parent_id)
        .maybeSingle();
      if (!parentComment || parentError) {
        return res.status(400).json({ error: "Parent comment not found" });
      }
    }

    const payload = { content, user_id, author_id: ownerId, item_id, item_type, parent_id: parent_id || null };
    const { data, error } = await supabase
      .from("comments")
      .insert([payload])
      .select(`*, profiles:user_id(full_name, avatar_url)`);

    if (error) throw error;
    res.json(data[0]);
  } catch (err) {
    console.error("Server error posting comment:", err);
    res.status(500).json({ error: "Failed to post comment", details: err.message });
  }
});

app.delete("/api/comments/:id", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  const { data: { user }, error: userError } = await supabase.auth.getUser(token);
  if (userError || !user) return res.status(401).json({ error: "Unauthorized" });

  const { id } = req.params;
  const { item_type } = req.body;

  try {
    const { error } = await supabase
      .from("comments")
      .delete()
      .eq("id", id)
      .eq("item_type", item_type)
      .eq("author_id", user.id);

    if (error) throw error;
    res.json({ message: "Comment deleted successfully" });
  } catch (err) {
    console.error("Server error deleting comment:", err);
    res.status(500).json({ error: "Failed to delete comment" });
  }
});

// Votes
app.post("/api/comments/:id/vote", async (req, res) => {
  const { id } = req.params;
  const { user_id, vote_type } = req.body;
  if (!user_id || !vote_type) return res.status(400).json({ error: "Missing user_id or vote_type" });

  try {
    const { error } = await supabase
      .from("comment_votes")
      .upsert({ user_id, comment_id: id, vote_type }, { onConflict: ["user_id", "comment_id"] });
    if (error) throw error;

    const { data: counts, error: countErr } = await supabase
      .from("comments")
      .select("id, likes, dislikes")
      .eq("id", id)
      .single();
    if (countErr) throw countErr;

    const { data: vote } = await supabase
      .from("comment_votes")
      .select("vote_type")
      .eq("comment_id", id)
      .eq("user_id", user_id)
      .single();

    res.json({ ...counts, current_user_vote: vote?.vote_type || null });
  } catch (err) {
    console.error("Vote error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/comments/:id/vote", async (req, res) => {
  const { id } = req.params;
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: "Missing user_id" });

  try {
    const { error } = await supabase
      .from("comment_votes")
      .delete()
      .eq("comment_id", id)
      .eq("user_id", user_id);
    if (error) throw error;

    const { data: counts, error: countErr } = await supabase
      .from("comments")
      .select("id, likes, dislikes")
      .eq("id", id)
      .single();
    if (countErr) throw countErr;

    res.json({ ...counts, current_user_vote: null });
  } catch (err) {
    console.error("Vote deletion error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Profiles
app.get("/api/profiles/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("full_name, avatar_url")
      .eq("id", id)
      .single();

    if (error) return res.status(404).json({ error: "Profile not found" });
    res.json(data);
  } catch (err) {
    console.error("Server error fetching profile:", err);
    res.status(500).json({ error: "Failed to fetch profile" });
  }
});
// --------------------
// Get all content for a user
// --------------------
// --------------------
// Get all content for a user (optimized with main covers)
// --------------------
app.get("/api/users/:userId/content", async (req, res) => {
  const { userId } = req.params;

  try {
    // 1. Fetch all item types
    const { data: itemTypes, error: utError } = await supabase
      .from("universal_items")
      .select("item_type");

    if (utError) throw utError;

    const allContent = [];

    // 2. Loop through each item type dynamically

    for (const item of itemTypes) {
      const table = item.item_type;
      // Fetch all items of this type for the user
      const { data: items, error: itemsError } = await supabase
        .from(table)
        .select("*")
        .eq("author_id", userId);

      if (itemsError) {
        console.warn(`Skipping ${table} due to fetch error:`, itemsError.message);
        continue;
      }

      if (!items || items.length === 0) continue;

      // Collect all item IDs for this table
      const itemIds = items.map(i => i.id);

      // Fetch all main covers for these items in ONE query
      const { data: covers, error: coversError } = await supabase
        .from("content_covers")
        .select("item_id, image_url")
        .in("item_id", itemIds)
        .eq("item_type", table)
        .eq("is_main_cover", true);

      if (coversError) {
        console.warn(`Failed to fetch covers for ${table}:`, coversError.message);
      }

      // Map covers by item_id for quick lookup
      const coverMap = {};
      covers?.forEach(c => {
        coverMap[c.item_id] = c;
      });

      // Attach main cover to each item
      items.forEach(itemRow => {
        itemRow.content_covers = coverMap[itemRow.id] || null;
        itemRow.item_type = table; // attach the type for frontend
      });

      allContent.push(...items);
    }

    res.json(allContent);
  } catch (err) {
    console.error("Error fetching user content:", err);
    res.status(500).json({ error: "Failed to fetch user content" });
  }
});




// --------------------





// --------------------
// Start server
// --------------------
// --------------------
// Check Supabase connection
// --------------------


app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
