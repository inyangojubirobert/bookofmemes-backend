


import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import crypto from "crypto";
import { supabase } from "./config/db.js";
import { ITEM_TYPES, ALL_TYPES, CONTENT_TYPES } from "./config/itemTypes.js";

import interactionsRouter from "./routes/interactions.js";
import bookmarksRouter from "./routes/bookmarks.js";
import depositRoutes from './routes/deposits.js';
import bankDetailsRoutes from "./routes/bankDetailsRoutes.js";
import cashoutRoutes from "./routes/cashoutRoutes.js";
import walletTransactionsRouter from "./routes/walletTransactions.js";
import walletRoutes from "./routes/walletRoutes.js";
import transferRoutes from "./routes/transferRoutes.js";
import tokenRoutes from "./routes/tokenRoutes.js";
import premiumRoutes from "./routes/premiumRoutes.js";
import rewardsRoutes from "./routes/rewardsRoutes.js";
import affiliateRoutes from "./routes/affiliateRoutes.js";
import currencyRoutes, { startExchangeRateRefreshTimer } from "./routes/currencyRoutes.js";
import aiRoutes from "./routes/aiRoutes.js";
import runwareRoutes from "./routes/runwareRoutes.js";
import voiceRoutes from "./routes/voiceRoutes.js";
import uploadRoutes from "./routes/uploadRoutes.js";
import bascardoRoutes from "./routes/bascardoRoutes.js";
import rewardDistributorRoutes from "./routes/rewardDistributorRoutes.js";
import walletApiV1 from "./routes/v1/walletApiRouter.js";
import marketplaceRoutes, { startMarketplaceSweepTimer, startAgentCashoutSweepTimer } from "./routes/marketplaceRoutes.js";
import { startLeadershipGamesSweepTimer } from "./routes/leadershipGamesRoutes.js";


dotenv.config();
const app = express();
const PORT = process.env.PORT || 5001;

// Paystack webhook — raw body REQUIRED for signature verification; must be before express.json()
app.post('/api/deposits/webhook/paystack', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const signature = req.headers['x-paystack-signature'];
    const hash = crypto
      .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
      .update(req.body)
      .digest('hex');

    if (hash !== signature) {
      return res.status(400).json({ error: 'Invalid signature' });
    }

    const event = JSON.parse(req.body);

    if (event.event === 'charge.success') {
      const { reference, status } = event.data;
      if (status !== 'success') return res.sendStatus(200);

      const { data: deposit } = await supabase
        .from('deposits').select('*').eq('reference', reference).single();

      if (!deposit || deposit.status === 'completed') return res.sendStatus(200);

      // wallet_balance (USD) is the one spendable ledger -- same fix as
      // Backend/routes/deposits.js's /verify handler. This webhook still called
      // credit_wallet_currency unconditionally, which is the same bug class that
      // stranded real money in wallet_currencies before (migration 035).
      if (deposit.currency === 'USD') {
        const { data: walletRow } = await supabase.from('wallets').select('wallet_balance').eq('id', deposit.wallet_id).single();
        await supabase.from('wallets').update({ wallet_balance: Number(walletRow?.wallet_balance || 0) + Number(deposit.amount) }).eq('id', deposit.wallet_id);
      } else {
        const { error: creditError } = await supabase.rpc('credit_wallet_currency', {
          p_wallet_id: deposit.wallet_id,
          p_currency: deposit.currency,
          p_amount: deposit.amount,
        });
        // Leave the deposit 'pending' on failure -- Paystack will retry this
        // webhook, which retries the credit, instead of the payment silently
        // being marked done with no money actually reaching the wallet.
        if (creditError) {
          console.error('credit_wallet_currency error:', creditError.message);
          return res.sendStatus(200);
        }
      }

      await supabase.from('deposits').update({
        status: 'completed',
        ...(deposit.currency === 'USD' ? { exchange_rate: 1.0, credited_usd_amount: deposit.amount } : {}),
      }).eq('id', deposit.id);

      await supabase.from('wallet_transactions').insert([{
        wallet_id: deposit.wallet_id,
        currency_code: deposit.currency,
        type: 'deposit',
        amount: deposit.amount,
        description: 'Deposit via bank transfer',
        metadata: { reference },
        status: 'completed',
      }]);

      await supabase.from('deposit_notifications').insert([{
        user_id: deposit.user_id,
        deposit_id: deposit.id,
        title: 'Deposit Successful',
        message: `Your deposit of ${deposit.amount} ${deposit.currency} was successful`,
      }]);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Paystack webhook error:', err);
    res.sendStatus(200); // always 200 so Paystack doesn't retry indefinitely
  }
});

// 1. JSON parser
app.use(express.json());

// 2. CORS

app.use(cors({
  origin: "*", // or restrict to your frontend domain
}));
// --------------------
// ROUTES
// --------------------

// Social
app.use("/api/interactions", interactionsRouter);
app.use("/api/bookmarks", bookmarksRouter);

// Payments & Wallet
app.use("/api/deposits", depositRoutes);
app.use("/api/cashout", cashoutRoutes);
app.use("/api/bank-details", bankDetailsRoutes);
app.use("/api/wallet-transactions", walletTransactionsRouter);
app.use("/api/wallet", walletRoutes);
app.use("/api/transfers", transferRoutes);
app.use("/api/tokens", tokenRoutes);
app.use("/api/premium", premiumRoutes);
app.use("/api/rewards", rewardsRoutes);
app.use("/api/affiliates", affiliateRoutes);
app.use("/api/currencies", currencyRoutes);

// Marketplace (list/bid/buy-now/ownership for stories, memes, puzzles,
// kids_collections, music_box, podcast_box, tv_box)
app.use("/api/marketplace", marketplaceRoutes);

// AI features
app.use("/api/ai", aiRoutes);
app.use("/api/ai/runware", runwareRoutes);
app.use("/api/ai/voice", voiceRoutes);

// Bascardo on-chain token (BSC)
app.use("/api/bascardo", bascardoRoutes);

// Bascardo on-chain reward distributor (internal — protected by DISTRIBUTOR_SECRET)
app.use("/api/rewards", rewardDistributorRoutes);

// ── Wallet Public API v1 (API-key authenticated, stable versioned routes) ──
app.use("/v1/wallet", walletApiV1);

// File uploads (Cloudinary)
app.use("/api/upload", uploadRoutes);


// ...existing code...
// POST /api/share - record a share event
app.post("/api/share", async (req, res) => {
  const { user_id, item_id, item_type, author_id } = req.body;
  if (!user_id || !item_id || !item_type) {
    return res.status(400).json({ error: "Missing user_id, item_id, or item_type" });
  }

  try {
    const { data, error } = await supabase
      .from("interactions")
      .upsert([{ user_id, item_id, item_type, interaction_type: "share", author_id }], {
        onConflict: ["user_id", "item_id", "item_type", "interaction_type"],
      })
      .select();

    if (error) throw error;
    res.json(data?.[0] || null);
  } catch (err) {
    console.error("POST /api/share error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});



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

// Sums a user's authored rows across every CONTENT_TYPES table in one pass.
async function countUserPosts(userId) {
  const results = await Promise.all(
    CONTENT_TYPES.map((t) =>
      supabase.from(ITEM_TYPES[t].table).select("id", { count: "exact", head: true }).eq("author_id", userId)
    )
  );
  const firstError = results.find((r) => r.error)?.error;
  if (firstError) throw firstError;
  return results.reduce((sum, r) => sum + (r.count || 0), 0);
}

app.get("/api/users/:id/posts/count", async (req, res) => {
  const { id } = req.params;
  try {
    const totalPosts = await countUserPosts(id);
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

    // Count posts across every content type
    const totalPosts = await countUserPosts(id);

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
// Search helper — splits query into words, matches each word against every field
// "love story" → title has "love" OR synopsis has "love" OR title has "story" OR synopsis has "story"
// --------------------
function buildWordSearch(raw, fields) {
  const words = raw.trim().split(/\s+/).filter(Boolean);
  return words.flatMap(w => fields.map(f => `${f}.ilike.%${w}%`)).join(",");
}

// --------------------
// Mount Routers
// --------------------

app.get("/api/stories", async (req, res) => {
  try {
    const { search, limit = 50, sort = 'views' } = req.query;
    let query = supabase
      .from("stories")
      .select("id, title, author_id, author_name, cover_image_url, story_synopsis, story_category, description, views_count, likes_count, bookmarks_count, is_published")
      .eq("is_published", true);

    if (search) query = query.or(buildWordSearch(search, ["title", "story_synopsis"]));
    if (sort === 'views') query = query.order("views_count", { ascending: false });
    else if (sort === 'likes') query = query.order("likes_count", { ascending: false });
    else query = query.order("created_at", { ascending: false });

    query = query.limit(Number(limit));

    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error("Error fetching stories:", err);
    res.status(500).json({ error: "Failed to fetch stories" });
  }
});

// Memes
app.get("/api/memes", async (req, res) => {
  try {
    const { search, limit = 40, sort = "views" } = req.query;
    let query = supabase
      .from("memes")
      .select("id, title, author_id, image_url, description, reads_count, likes_count, bookmarks_count, shares_count");
    if (search) query = query.or(buildWordSearch(search, ["title", "description"]));
    if (sort === "views") query = query.order("reads_count", { ascending: false });
    else if (sort === "likes") query = query.order("likes_count", { ascending: false });
    else query = query.order("created_at", { ascending: false });
    query = query.limit(Number(limit));
    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error("Error fetching memes:", err);
    res.status(500).json({ error: "Failed to fetch memes" });
  }
});

app.get("/api/memes/:id", async (req, res) => {
  try {
    const { data, error } = await supabase.from("memes").select("*").eq("id", req.params.id).single();
    if (error) return res.status(404).json({ error: "Meme not found" });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch meme" });
  }
});

// Puzzles
app.get("/api/puzzles", async (req, res) => {
  try {
    const { search, limit = 40, sort = "views" } = req.query;
    let query = supabase
      .from("puzzles")
      .select("id, title, author_id, description, reads_count, likes_count, bookmarks_count, shares_count");
    if (search) query = query.or(buildWordSearch(search, ["title", "description"]));
    if (sort === "views") query = query.order("reads_count", { ascending: false });
    else if (sort === "likes") query = query.order("likes_count", { ascending: false });
    else query = query.order("created_at", { ascending: false });
    query = query.limit(Number(limit));
    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error("Error fetching puzzles:", err);
    res.status(500).json({ error: "Failed to fetch puzzles" });
  }
});

app.get("/api/puzzles/:id", async (req, res) => {
  try {
    const { data, error } = await supabase.from("puzzles").select("*").eq("id", req.params.id).single();
    if (error) return res.status(404).json({ error: "Puzzle not found" });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch puzzle" });
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
      .select("id, title, author_id, views_count, likes_count, bookmarks_count")
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
    const tables = CONTENT_TYPES.map((t) => ITEM_TYPES[t].table);
    for (const table of tables) {
      const { data } = await supabase.from(table).select("id").eq("id", itemId).maybeSingle();
      if (data && data.id) return true;
    }
    return false;
  }

  // Helper: get the owner/author of the item
  async function getItemOwnerId(itemId) {
    const tables = CONTENT_TYPES.map((t) => ITEM_TYPES[t].table);
    for (const table of tables) {
      const { data } = await supabase.from(table).select("author_id").eq("id", itemId).maybeSingle();
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
    // This route runs on the service-role key, so it bypasses the comments
    // table's RLS policies entirely -- this check is the only thing standing
    // between a request and a delete. Two people may delete a comment: the
    // person who wrote it (user_id) and the owner of the content it's on
    // (author_id, moderation power over their own post).
    const { data: comment, error: fetchError } = await supabase
      .from("comments")
      .select("id, user_id, author_id, item_type")
      .eq("id", id)
      .maybeSingle();
    if (fetchError) throw fetchError;
    if (!comment) return res.status(404).json({ error: "Comment not found" });
    if (item_type && comment.item_type !== item_type) {
      return res.status(400).json({ error: "item_type mismatch" });
    }
    if (comment.user_id !== user.id && comment.author_id !== user.id) {
      return res.status(403).json({ error: "Not authorized to delete this comment" });
    }

    const { error } = await supabase.from("comments").delete().eq("id", id);
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
// Kids Collections API
// --------------------

// GET /api/kids-collections/:id - Get a single collection
app.get("/api/kids-collections/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const { data, error } = await supabase
      .from("kids_collections")
      .select("*")
      .eq("id", id)
      .single();

    if (error) {
      if (error.code === "PGRST116") {
        return res.status(404).json({ error: "Collection not found" });
      }
      throw error;
    }

    res.json(data);
  } catch (err) {
    console.error("Error fetching kids collection:", err);
    res.status(500).json({ error: "Failed to fetch collection" });
  }
});

// GET /api/kids-collections - Get all collections (with optional filters)
app.get("/api/kids-collections", async (req, res) => {
  try {
    const { search, limit, sort = "recent", author_id } = req.query;
    let query = supabase
      .from("kids_collections")
      .select("id, title, author_id, description, reads_count, likes_count, bookmarks_count, shares_count, type, created_at");

    if (author_id) query = query.eq("author_id", author_id);
    if (search) query = query.or(buildWordSearch(search, ["title", "description"]));
    if (sort === "views") query = query.order("reads_count", { ascending: false });
    else if (sort === "likes") query = query.order("likes_count", { ascending: false });
    else query = query.order("created_at", { ascending: false });
    if (limit) {
      const n = parseInt(limit);
      if (!isNaN(n) && n > 0) query = query.limit(n);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error("Error fetching kids collections:", err);
    res.status(500).json({ error: "Failed to fetch collections" });
  }
});
// Your existing profiles endpoint is fine, but ensure it returns:
app.get("/api/profiles/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("full_name, avatar_url, bio, username") // Add bio and username
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
// Fallback search — direct ilike when fn_search RPC is unavailable
// --------------------
async function fallbackSearch(q, types, limit) {
  const searchTypes = (types && types.length) ? types : ALL_TYPES;
  const words = q.trim().split(/\s+/).filter(Boolean);
  const results = [];
  const perType = Math.max(5, Math.ceil(limit / searchTypes.length));

  for (const type of searchTypes) {
    const cfg = ITEM_TYPES[type];
    if (!cfg) continue;
    const orFilter = words.flatMap(w => cfg.search.map(f => `${f}.ilike.%${w}%`)).join(",");
    const { data } = await supabase.from(cfg.table).select(cfg.select).or(orFilter).limit(perType);
    if (!data) continue;
    data.forEach(row => {
      results.push({
        item_id:       row.id,
        item_type:     type,
        author_id:     row.author_id,
        title:         row.title || row.username || row.full_name,
        description:   row.description || row.story_synopsis || row.bio,
        thumbnail_url: cfg.img ? row[cfg.img] : null,
        like_count:    cfg.like ? (row[cfg.like] || 0) : 0,
        view_count:    cfg.view ? (row[cfg.view] || 0) : 0,
        tags:          [],
        is_premium:    false,
        metadata:      type === "profile"
          ? { full_name: row.full_name, username: row.username, email: row.email }
          : { author_name: row.author_name || row.artist_name || row.host_name },
        rank:          1.0,
        created_at:    row.created_at,
      });
    });
  }
  return results;
}

// Universal Search — fn_search RPC with automatic fallback
app.get("/api/search", async (req, res) => {
  try {
    const { q, types, limit = 40, offset = 0 } = req.query;
    if (!q || !q.trim()) return res.json([]);

    const typesArray = types ? types.split(",").map(t => t.trim()).filter(Boolean) : null;

    const { data, error } = await supabase.rpc("fn_search", {
      query: q.trim(),
      types: typesArray,
      lmt:   Number(limit),
      ofst:  Number(offset),
    });

    if (error) {
      console.warn("fn_search RPC unavailable, using fallback:", error.message);
      const fallback = await fallbackSearch(q.trim(), typesArray, Number(limit));
      return res.json(fallback);
    }

    res.json(data || []);
  } catch (err) {
    console.error("Search error:", err);
    res.status(500).json({ error: err.message || "Search failed" });
  }
});

// Music Box
app.get("/api/music-box", async (req, res) => {
  try {
    const { limit = 40, sort = "views" } = req.query;
    let query = supabase
      .from("music_box")
      .select("id, title, author_id, description, cover_image_url, artist_name, album_name, genre, duration_seconds, play_count, like_count, tags, is_premium, created_at")
      .eq("is_published", true);
    if (sort === "views") query = query.order("play_count", { ascending: false });
    else if (sort === "likes") query = query.order("like_count", { ascending: false });
    else query = query.order("created_at", { ascending: false });
    query = query.limit(Number(limit));
    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error("Error fetching music:", err);
    res.status(500).json({ error: "Failed to fetch music" });
  }
});

// Podcast Box
app.get("/api/podcast-box", async (req, res) => {
  try {
    const { limit = 40, sort = "views" } = req.query;
    let query = supabase
      .from("podcast_box")
      .select("id, title, author_id, description, cover_image_url, host_name, episode_number, season_number, duration_seconds, play_count, like_count, tags, is_premium, created_at")
      .eq("is_published", true);
    if (sort === "views") query = query.order("play_count", { ascending: false });
    else if (sort === "likes") query = query.order("like_count", { ascending: false });
    else query = query.order("created_at", { ascending: false });
    query = query.limit(Number(limit));
    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error("Error fetching podcasts:", err);
    res.status(500).json({ error: "Failed to fetch podcasts" });
  }
});

// TV Box
app.get("/api/tv-box", async (req, res) => {
  try {
    const { limit = 40, sort = "views" } = req.query;
    let query = supabase
      .from("tv_box")
      .select("id, title, author_id, description, thumbnail_url, genre, episode_number, season_number, duration_seconds, view_count, like_count, tags, is_premium, created_at")
      .eq("is_published", true);
    if (sort === "views") query = query.order("view_count", { ascending: false });
    else if (sort === "likes") query = query.order("like_count", { ascending: false });
    else query = query.order("created_at", { ascending: false });
    query = query.limit(Number(limit));
    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error("Error fetching TV content:", err);
    res.status(500).json({ error: "Failed to fetch TV content" });
  }
});

// Single-item routes for music, podcast, TV
app.get("/api/music-box/:id", async (req, res) => {
  try {
    const { data, error } = await supabase.from("music_box").select("*").eq("id", req.params.id).single();
    if (error) return res.status(404).json({ error: "Track not found" });
    res.json(data);
  } catch (err) { res.status(500).json({ error: "Failed to fetch track" }); }
});

app.get("/api/podcast-box/:id", async (req, res) => {
  try {
    const { data, error } = await supabase.from("podcast_box").select("*").eq("id", req.params.id).single();
    if (error) return res.status(404).json({ error: "Episode not found" });
    res.json(data);
  } catch (err) { res.status(500).json({ error: "Failed to fetch episode" }); }
});

app.get("/api/tv-box/:id", async (req, res) => {
  try {
    const { data, error } = await supabase.from("tv_box").select("*").eq("id", req.params.id).single();
    if (error) return res.status(404).json({ error: "Video not found" });
    res.json(data);
  } catch (err) { res.status(500).json({ error: "Failed to fetch video" }); }
});

// Profiles list — for People browse tab
app.get("/api/profiles-list", async (req, res) => {
  try {
    const { limit = 40, search } = req.query;
    let query = supabase
      .from("profiles")
      .select("id, full_name, username, bio, avatar_url, created_at");
    if (search) query = query.or(buildWordSearch(search, ["username", "full_name", "bio"]));
    query = query.order("created_at", { ascending: false }).limit(Number(limit));
    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error("Error fetching profiles list:", err);
    res.status(500).json({ error: "Failed to fetch profiles" });
  }
});

// --------------------
// Start server
// --------------------
// --------------------
// Check Supabase connection
// --------------------


app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startMarketplaceSweepTimer();
  startExchangeRateRefreshTimer();
  startAgentCashoutSweepTimer();
  startLeadershipGamesSweepTimer();
});
