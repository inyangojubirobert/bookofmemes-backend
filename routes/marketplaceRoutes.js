import express from 'express';
import { supabase } from '../config/db.js';
import { authenticateToken } from '../auth.js';
import { ITEM_TYPES, CONTENT_TYPES } from '../config/itemTypes.js';

const router = express.Router();

// Non-money reads/writes (listings CRUD, browsing, bid placement/withdrawal) live here
// as plain Supabase calls under the RLS policies from migration 029. Anything that
// moves money or transfers ownership (place bid's fund lock, accept bid, buy-now) calls
// the atomic Postgres functions from migration 030 via supabase.rpc() instead of doing
// it as several separate calls here -- see that file's header comment for why.

function isContentType(type) {
  return CONTENT_TYPES.includes(type);
}

async function fetchItemMeta(itemType, itemId) {
  const cfg = ITEM_TYPES[itemType];
  if (!cfg) return null;
  const { data } = await supabase.from(cfg.table).select(cfg.select).eq('id', itemId).maybeSingle();
  return data || null;
}

// Batch-resolve display metadata (title/cover/author) for a list of listings, grouped
// by item_type so each content table is queried once with .in(), not once per listing.
async function attachItemMeta(listings) {
  const byType = {};
  for (const l of listings) (byType[l.item_type] ||= []).push(l.item_id);

  const metaById = {};
  await Promise.all(
    Object.entries(byType).map(async ([type, ids]) => {
      const cfg = ITEM_TYPES[type];
      if (!cfg) return;
      const { data } = await supabase.from(cfg.table).select(cfg.select).in('id', ids);
      for (const row of data || []) metaById[`${type}:${row.id}`] = row;
    })
  );

  return listings.map((l) => ({ ...l, item: metaById[`${l.item_type}:${l.item_id}`] || null }));
}

async function attachHighestBid(listings) {
  const ids = listings.map((l) => l.id);
  if (!ids.length) return listings;
  const { data: bids } = await supabase
    .from('marketplace_bids')
    .select('listing_id, amount')
    .eq('status', 'active')
    .in('listing_id', ids);

  const highest = {};
  for (const b of bids || []) {
    if (!highest[b.listing_id] || b.amount > highest[b.listing_id]) highest[b.listing_id] = b.amount;
  }
  return listings.map((l) => ({ ...l, highestBid: highest[l.id] ?? null }));
}

// Current owner = most recent ownership_history.to_user_id for this item, or the
// content row's author_id if it has never changed hands. See 029's header comment.
async function getCurrentOwner(itemType, itemId, authorId) {
  const { data } = await supabase
    .from('marketplace_ownership_history')
    .select('to_user_id')
    .eq('item_type', itemType)
    .eq('item_id', itemId)
    .order('transferred_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.to_user_id || authorId;
}

/**
 * @route   POST /api/marketplace/listings
 * @desc    List an owned item for sale
 * @access  Private
 */
router.post('/listings', authenticateToken, async (req, res) => {
  try {
    const sellerId = req.user.id;
    const { itemType, itemId, askingPrice, buyNowPrice, reservePrice, minimumIncrement, royaltyPct, expiresAt, listingType } = req.body;

    if (!itemType || !itemId || !askingPrice) {
      return res.status(400).json({ success: false, error: 'Missing required fields: itemType, itemId, askingPrice' });
    }
    if (!isContentType(itemType)) {
      return res.status(400).json({ success: false, error: `Invalid itemType: ${itemType}` });
    }

    // Delegates to the same create_marketplace_listing RPC the mobile app calls
    // directly (Backend/migrations/031, fee logic added in 032) -- this used to
    // duplicate that logic as a plain INSERT here, which meant this route never
    // charged the listing fee. One implementation now, not two that can drift.
    const { data, error } = await supabase.rpc('create_marketplace_listing', {
      p_item_type: itemType,
      p_item_id: itemId,
      p_seller_id: sellerId,
      p_asking_price: askingPrice,
      p_buy_now_price: buyNowPrice || null,
      p_reserve_price: reservePrice || null,
      p_minimum_increment: minimumIncrement || 10,
      p_royalty_pct: royaltyPct ?? 5.0,
      p_expires_at: expiresAt || null,
      p_listing_type: listingType || null,
    });

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ success: false, error: 'This item already has an active listing' });
      }
      return res.status(400).json({ success: false, error: error.message });
    }

    const listing = Array.isArray(data) ? data[0] : data;
    res.status(201).json({ success: true, data: listing, message: 'Listing created' });
  } catch (error) {
    console.error('Error creating listing:', error);
    res.status(500).json({ success: false, error: error.message, message: 'Failed to create listing' });
  }
});

/**
 * @route   GET /api/marketplace/listings
 * @desc    Browse active listings, optionally filtered by itemType
 * @access  Public
 */
router.get('/listings', async (req, res) => {
  try {
    const { itemType, page = 1, limit = 20 } = req.query;
    const from = (page - 1) * limit;
    const to = from + Number(limit) - 1;

    let query = supabase
      .from('marketplace_listings')
      .select('*')
      .eq('status', 'active')
      .order('listed_at', { ascending: false })
      .range(from, to);

    if (itemType) query = query.eq('item_type', itemType);

    const { data, error } = await query;
    if (error) throw error;

    const withMeta = await attachItemMeta(data || []);
    const withBids = await attachHighestBid(withMeta);

    res.json({ success: true, data: withBids, message: 'Listings fetched' });
  } catch (error) {
    console.error('Error fetching listings:', error);
    res.status(500).json({ success: false, error: error.message, message: 'Failed to fetch listings' });
  }
});

/**
 * @route   GET /api/marketplace/listings/:id
 * @desc    Listing detail: item metadata, active bids (bid history), ownership provenance
 * @access  Public
 */
router.get('/listings/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: listing, error } = await supabase.from('marketplace_listings').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!listing) return res.status(404).json({ success: false, error: 'Listing not found' });

    const item = await fetchItemMeta(listing.item_type, listing.item_id);

    const { data: bids } = await supabase
      .from('marketplace_bids')
      .select('id, bidder_id, amount, status, created_at, expires_at, bidder:bidder_id(full_name, avatar_url)')
      .eq('listing_id', id)
      .eq('status', 'active')
      .order('amount', { ascending: false });

    const { data: ownershipHistory } = await supabase
      .from('marketplace_ownership_history')
      .select('*, from_profile:from_user_id(full_name, avatar_url), to_profile:to_user_id(full_name, avatar_url)')
      .eq('item_type', listing.item_type)
      .eq('item_id', listing.item_id)
      .order('transferred_at', { ascending: false });

    res.json({
      success: true,
      data: { listing, item, bids: bids || [], ownershipHistory: ownershipHistory || [] },
      message: 'Listing fetched',
    });
  } catch (error) {
    console.error('Error fetching listing:', error);
    res.status(500).json({ success: false, error: error.message, message: 'Failed to fetch listing' });
  }
});

/**
 * @route   PUT /api/marketplace/listings/:id/cancel
 * @desc    Cancel an active listing (rejects+refunds any open bids via DB trigger)
 * @access  Private
 */
router.put('/listings/:id/cancel', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from('marketplace_listings')
      .update({ status: 'cancelled', updated_at: new Date() })
      .eq('id', id)
      .eq('seller_id', req.user.id)
      .eq('status', 'active')
      .select()
      .single();

    if (error || !data) {
      return res.status(404).json({ success: false, error: 'Active listing not found for this seller' });
    }

    res.json({ success: true, data, message: 'Listing cancelled' });
  } catch (error) {
    console.error('Error cancelling listing:', error);
    res.status(500).json({ success: false, error: error.message, message: 'Failed to cancel listing' });
  }
});

/**
 * @route   POST /api/marketplace/bids
 * @desc    Place a bid (locks funds via wallet_holds through the place_marketplace_bid RPC)
 * @access  Private
 */
router.post('/bids', authenticateToken, async (req, res) => {
  try {
    const bidderId = req.user.id;
    const { listingId, amount, durationHours = 24 } = req.body;

    if (!listingId || !amount) {
      return res.status(400).json({ success: false, error: 'Missing required fields: listingId, amount' });
    }
    const clampedHours = Math.min(Math.max(Number(durationHours), 1), 336); // 1h .. 14d
    const expiresAt = new Date(Date.now() + clampedHours * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase.rpc('place_marketplace_bid', {
      p_listing_id: listingId,
      p_bidder_id: bidderId,
      p_amount: amount,
      p_expires_at: expiresAt,
    });

    if (error) return res.status(400).json({ success: false, error: error.message });

    const bid = Array.isArray(data) ? data[0] : data;
    res.status(201).json({ success: true, data: bid, message: 'Bid placed' });
  } catch (error) {
    console.error('Error placing bid:', error);
    res.status(500).json({ success: false, error: error.message, message: 'Failed to place bid' });
  }
});

/**
 * @route   PUT /api/marketplace/bids/:id/withdraw
 * @desc    Withdraw an active bid (releases the held funds via DB trigger)
 * @access  Private
 */
router.put('/bids/:id/withdraw', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from('marketplace_bids')
      .update({ status: 'withdrawn', decided_at: new Date() })
      .eq('id', id)
      .eq('bidder_id', req.user.id)
      .eq('status', 'active')
      .select()
      .single();

    if (error || !data) {
      return res.status(404).json({ success: false, error: 'Active bid not found for this user' });
    }

    res.json({ success: true, data, message: 'Bid withdrawn' });
  } catch (error) {
    console.error('Error withdrawing bid:', error);
    res.status(500).json({ success: false, error: error.message, message: 'Failed to withdraw bid' });
  }
});

/**
 * @route   POST /api/marketplace/listings/:id/accept-bid
 * @desc    Seller accepts a bid: settles funds, pays creator royalty, transfers ownership
 * @access  Private
 */
router.post('/listings/:id/accept-bid', authenticateToken, async (req, res) => {
  try {
    const { bidId } = req.body;
    if (!bidId) return res.status(400).json({ success: false, error: 'Missing required field: bidId' });

    const { data, error } = await supabase.rpc('accept_marketplace_bid', {
      p_bid_id: bidId,
      p_seller_id: req.user.id,
    });

    if (error) return res.status(400).json({ success: false, error: error.message });

    const history = Array.isArray(data) ? data[0] : data;
    res.json({ success: true, data: history, message: 'Bid accepted -- ownership transferred' });
  } catch (error) {
    console.error('Error accepting bid:', error);
    res.status(500).json({ success: false, error: error.message, message: 'Failed to accept bid' });
  }
});

/**
 * @route   POST /api/marketplace/listings/:id/buy-now
 * @desc    Buyer purchases instantly at the listing's buy_now_price
 * @access  Private
 */
router.post('/listings/:id/buy-now', authenticateToken, async (req, res) => {
  try {
    const { data, error } = await supabase.rpc('accept_marketplace_buy_now', {
      p_listing_id: req.params.id,
      p_buyer_id: req.user.id,
    });

    if (error) return res.status(400).json({ success: false, error: error.message });

    const history = Array.isArray(data) ? data[0] : data;
    res.json({ success: true, data: history, message: 'Purchased -- ownership transferred' });
  } catch (error) {
    console.error('Error processing buy-now:', error);
    res.status(500).json({ success: false, error: error.message, message: 'Failed to complete purchase' });
  }
});

/**
 * @route   GET /api/marketplace/my/listings
 * @access  Private
 */
router.get('/my/listings', authenticateToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('marketplace_listings')
      .select('*')
      .eq('seller_id', req.user.id)
      .order('created_at', { ascending: false });
    if (error) throw error;

    const withMeta = await attachItemMeta(data || []);
    res.json({ success: true, data: withMeta, message: 'Your listings fetched' });
  } catch (error) {
    console.error('Error fetching your listings:', error);
    res.status(500).json({ success: false, error: error.message, message: 'Failed to fetch your listings' });
  }
});

/**
 * @route   GET /api/marketplace/my/bids
 * @access  Private
 */
router.get('/my/bids', authenticateToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('marketplace_bids')
      .select('*, listing:listing_id(*)')
      .eq('bidder_id', req.user.id)
      .order('created_at', { ascending: false });
    if (error) throw error;

    res.json({ success: true, data: data || [], message: 'Your bids fetched' });
  } catch (error) {
    console.error('Error fetching your bids:', error);
    res.status(500).json({ success: false, error: error.message, message: 'Failed to fetch your bids' });
  }
});

/**
 * @route   GET /api/marketplace/items/:itemType/:itemId/ownership
 * @desc    Provenance trail for an item, independent of whether it's currently listed
 * @access  Public
 */
router.get('/items/:itemType/:itemId/ownership', async (req, res) => {
  try {
    const { itemType, itemId } = req.params;
    if (!isContentType(itemType)) return res.status(400).json({ success: false, error: `Invalid itemType: ${itemType}` });

    const item = await fetchItemMeta(itemType, itemId);
    if (!item) return res.status(404).json({ success: false, error: 'Item not found' });

    const { data: history } = await supabase
      .from('marketplace_ownership_history')
      .select('*, from_profile:from_user_id(full_name, avatar_url), to_profile:to_user_id(full_name, avatar_url)')
      .eq('item_type', itemType)
      .eq('item_id', itemId)
      .order('transferred_at', { ascending: false });

    const currentOwner = await getCurrentOwner(itemType, itemId, item.author_id);

    res.json({ success: true, data: { currentOwner, creatorId: item.author_id, history: history || [] }, message: 'Ownership history fetched' });
  } catch (error) {
    console.error('Error fetching ownership history:', error);
    res.status(500).json({ success: false, error: error.message, message: 'Failed to fetch ownership history' });
  }
});

// Expires past-due listings/bids (DB triggers cascade the resulting hold releases
// and bid rejections -- see 030's header comment). Shared by the HTTP route below
// (for an external scheduler, or manual curl testing) and the in-app timer started
// from server.js (startMarketplaceSweepTimer) -- same logic, two ways to trigger it.
export async function runMarketplaceSweep() {
  const nowIso = new Date().toISOString();

  const { data: expiredListings, error: listingsError } = await supabase
    .from('marketplace_listings')
    .update({ status: 'expired', updated_at: new Date() })
    .eq('status', 'active')
    .not('expires_at', 'is', null)
    .lt('expires_at', nowIso)
    .select('id');
  if (listingsError) throw listingsError;

  const { data: expiredBids, error: bidsError } = await supabase
    .from('marketplace_bids')
    .update({ status: 'expired', decided_at: new Date() })
    .eq('status', 'active')
    .lt('expires_at', nowIso)
    .select('id');
  if (bidsError) throw bidsError;

  // Featured upgrades fall back to normal placement once they expire -- same
  // sweep, no separate "daily job" needed.
  const { data: unfeatured, error: featuredError } = await supabase
    .from('marketplace_listings')
    .update({ featured: false, updated_at: new Date() })
    .eq('featured', true)
    .lt('featured_until', nowIso)
    .select('id');
  if (featuredError) throw featuredError;

  return {
    expiredListings: expiredListings?.length || 0,
    expiredBids: expiredBids?.length || 0,
    unfeatured: unfeatured?.length || 0,
  };
}

// Starts the in-app sweep timer. Only runs while this server process is alive --
// fine here since Backend/server.js is a long-running Express process, not
// serverless. Call once from server.js after the app starts listening.
export function startMarketplaceSweepTimer(intervalMs = 15 * 60 * 1000) {
  const sweep = () => {
    runMarketplaceSweep()
      .then(({ expiredListings, expiredBids, unfeatured }) => {
        if (expiredListings || expiredBids || unfeatured) {
          console.log(`[marketplace sweep] expired ${expiredListings} listing(s), ${expiredBids} bid(s), unfeatured ${unfeatured}`);
        }
      })
      .catch((err) => console.error('[marketplace sweep] failed:', err.message));
  };
  sweep(); // run once at startup, then on the interval
  setInterval(sweep, intervalMs);
}

// Releases agent cashout orders a matched agent never confirmed within their
// 24h window (Backend/migrations/045_agent_cashout_fulfillment.sql). Same
// two-ways-to-trigger shape as runMarketplaceSweep, but the actual release
// logic lives in the sweep_expired_agent_orders() Postgres function since it
// has to atomically touch wallet_holds/trade_escrow/agents/cashout_requests
// per order -- not a good fit for chained .update() calls from here.
export async function runAgentCashoutSweep() {
  const { data, error } = await supabase.rpc('sweep_expired_agent_orders');
  if (error) throw error;
  return { releasedOrders: data || 0 };
}

export function startAgentCashoutSweepTimer(intervalMs = 15 * 60 * 1000) {
  const sweep = () => {
    runAgentCashoutSweep()
      .then(({ releasedOrders }) => {
        if (releasedOrders) {
          console.log(`[agent cashout sweep] released ${releasedOrders} expired order(s)`);
        }
      })
      .catch((err) => console.error('[agent cashout sweep] failed:', err.message));
  };
  sweep();
  setInterval(sweep, intervalMs);
}

/**
 * @route   POST /api/marketplace/sweep-expired
 * @desc    Maintenance: same sweep as the in-app timer, exposed over HTTP for manual
 *          testing (curl) or an external scheduler if you ever move off a persistent
 *          server. Guarded by a shared secret rather than a user session.
 * @access  Cron / manual only
 */
router.post('/sweep-expired', async (req, res) => {
  try {
    if (!process.env.MARKETPLACE_SWEEP_SECRET || req.headers['x-sweep-secret'] !== process.env.MARKETPLACE_SWEEP_SECRET) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const result = await runMarketplaceSweep();
    res.json({ success: true, data: result, message: 'Sweep complete' });
  } catch (error) {
    console.error('Error sweeping expired marketplace rows:', error);
    res.status(500).json({ success: false, error: error.message, message: 'Sweep failed' });
  }
});

export default router;
