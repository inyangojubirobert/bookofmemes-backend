/**
 * Bascardo daily activity reward routes.
 *
 * Premium users only. Max 10 BASC per user per day (5 activities × 2 BASC).
 * Activities are 5 items picked daily from universal_items.
 * Each activity can only be claimed once per day per user.
 *
 * Public routes (user auth):
 *   GET  /api/rewards/today          — today's 5 activities + user's progress
 *   POST /api/rewards/activity        — claim one activity reward
 *
 * Internal routes (DISTRIBUTOR_SECRET):
 *   POST /api/rewards/monthly         — subscription bonus (300 BASC)
 *   POST /api/rewards/referral        — referral bonus (50 BASC)
 *   GET  /api/rewards/pool            — pool health stats
 */
import express from 'express';
import { ethers } from 'ethers';
import { supabase } from '../config/db.js';
import { authenticateToken } from '../auth.js';
import { isPremium } from '../utils/isPremium.js';

const router = express.Router();

// ─── All universal_item_types available for rewards ───────────────────────────
const ALL_ACTIVITY_TYPES = [
  { type: 'stories',          label: 'Read 3 Stories',          icon: 'book-outline' },
  { type: 'memes',            label: 'Engage with 5 Memes',      icon: 'image-outline' },
  { type: 'puzzles',          label: 'Complete a Puzzle',         icon: 'grid-outline' },
  { type: 'kids_collections', label: 'Explore Kids Content',      icon: 'happy-outline' },
  { type: 'music_box',        label: 'Listen in Music Box',       icon: 'musical-notes-outline' },
  { type: 'tv_box',           label: 'Watch in TV Box',           icon: 'tv-outline' },
  { type: 'podcast_box',      label: 'Listen to a Podcast',       icon: 'mic-outline' },
];

const DAILY_ACTIVITY_COUNT = 5;
const BASC_PER_ACTIVITY    = 2;
const DAILY_CAP_BASC       = 10;

// ─── Pick today's 5 activities (deterministic per calendar date) ──────────────
function getTodaysActivities() {
  const today     = new Date().toISOString().slice(0, 10); // "2026-06-25"
  const dateSeed  = today.split('-').reduce((acc, n) => acc + Number(n), 0);
  const shuffled  = [...ALL_ACTIVITY_TYPES].sort((a, b) => {
    const ha = simpleHash(a.type + dateSeed);
    const hb = simpleHash(b.type + dateSeed);
    return ha - hb;
  });
  return shuffled.slice(0, DAILY_ACTIVITY_COUNT);
}

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

// ─── Contract helpers ─────────────────────────────────────────────────────────
const REWARDS_ABI = [
  "function distributeActivityReward(address user, string calldata activityType) external",
  "function distributeMonthlyReward(address user) external",
  "function distributeReferralReward(address user) external",
  "function todayStatus(address user) view returns (uint256,uint256,uint256,uint256)",
  "function poolStats() view returns (uint256,uint256,uint256,uint256)",
];

function getSigner() {
  const rpc = process.env.BSC_RPC_URL || "https://bsc-dataseed1.binance.org";
  const provider = new ethers.JsonRpcProvider(rpc);
  const key = process.env.DISTRIBUTOR_PRIVATE_KEY;
  if (!key) throw new Error("DISTRIBUTOR_PRIVATE_KEY not set in .env");
  return new ethers.Wallet(key, provider);
}

function getContract() {
  const address = process.env.REWARDS_CONTRACT_ADDRESS;
  if (!address) throw new Error("REWARDS_CONTRACT_ADDRESS not set in .env");
  return new ethers.Contract(address, REWARDS_ABI, getSigner());
}

function requireSecret(req, res, next) {
  const secret = req.headers['x-distributor-secret'];
  if (!secret || secret !== process.env.DISTRIBUTOR_SECRET) {
    return res.status(401).json({ success: false, error: "Unauthorised" });
  }
  next();
}

// ─── GET /api/rewards/today ───────────────────────────────────────────────────
// Returns today's 5 activities + user's progress. Requires user auth.
router.get('/today', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // Check premium
    const premium = await isPremium(userId);
    if (!premium) {
      return res.json({
        success: true,
        data: {
          isPremium: false,
          message: 'Upgrade to Premium to earn daily BASC rewards',
          activities: [],
        },
      });
    }

    const todayDate   = new Date().toISOString().slice(0, 10);
    const todayTasks  = getTodaysActivities();

    // Which activities has this user already claimed today?
    const { data: claims } = await supabase
      .from('daily_reward_claims')
      .select('activity_type')
      .eq('user_id', userId)
      .eq('claim_date', todayDate);

    const claimed = new Set((claims || []).map(c => c.activity_type));

    const activities = todayTasks.map(a => ({
      ...a,
      reward:    BASC_PER_ACTIVITY,
      completed: claimed.has(a.type),
    }));

    const completedCount = activities.filter(a => a.completed).length;

    res.json({
      success: true,
      data: {
        isPremium:          true,
        date:               todayDate,
        activities,
        completedCount,
        totalCount:         DAILY_ACTIVITY_COUNT,
        bascEarnedToday:    completedCount * BASC_PER_ACTIVITY,
        bascRemainingToday: (DAILY_ACTIVITY_COUNT - completedCount) * BASC_PER_ACTIVITY,
        dailyCap:           DAILY_CAP_BASC,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/rewards/activity ───────────────────────────────────────────────
// Claim reward for completing one of today's activities. Requires user auth.
router.post('/activity', authenticateToken, async (req, res) => {
  const { walletAddress, activityType } = req.body;
  const userId = req.user.id;

  if (!walletAddress || !ethers.isAddress(walletAddress)) {
    return res.status(400).json({ success: false, error: 'Invalid wallet address' });
  }
  if (!activityType) {
    return res.status(400).json({ success: false, error: 'activityType is required' });
  }

  try {
    // 1. Premium check
    const premium = await isPremium(userId);
    if (!premium) {
      return res.status(403).json({ success: false, error: 'Premium subscription required' });
    }

    // 2. Must be one of today's activities
    const todayTasks = getTodaysActivities();
    const isToday    = todayTasks.some(a => a.type === activityType);
    if (!isToday) {
      return res.status(400).json({ success: false, error: `${activityType} is not a reward activity today` });
    }

    // 3. Not already claimed today
    const todayDate = new Date().toISOString().slice(0, 10);
    const { data: existing } = await supabase
      .from('daily_reward_claims')
      .select('id')
      .eq('user_id', userId)
      .eq('activity_type', activityType)
      .eq('claim_date', todayDate)
      .single();

    if (existing) {
      return res.status(200).json({ success: false, reason: 'already_claimed_today' });
    }

    // 4. Send on-chain reward (contract also enforces daily cap)
    const contract = getContract();
    const tx       = await contract.distributeActivityReward(walletAddress, activityType);
    await tx.wait();

    // 5. Record in Supabase
    await supabase.from('daily_reward_claims').insert({
      user_id:       userId,
      activity_type: activityType,
      claim_date:    todayDate,
      basc_earned:   BASC_PER_ACTIVITY,
      tx_hash:       tx.hash,
    });

    res.json({
      success:      true,
      txHash:       tx.hash,
      activityType,
      bascEarned:   BASC_PER_ACTIVITY,
      message:      `+${BASC_PER_ACTIVITY} BASC earned for ${activityType}`,
    });
  } catch (err) {
    const capHit = err.message?.includes('Daily cap reached');
    res.status(capHit ? 200 : 500).json({
      success: false,
      reason:  capHit ? 'daily_cap_reached' : err.message,
    });
  }
});

// ─── Internal routes (DISTRIBUTOR_SECRET) ─────────────────────────────────────

router.post('/monthly', requireSecret, async (req, res) => {
  const { walletAddress } = req.body;
  if (!walletAddress || !ethers.isAddress(walletAddress)) {
    return res.status(400).json({ success: false, error: 'Invalid wallet address' });
  }
  try {
    const tx = await getContract().distributeMonthlyReward(walletAddress);
    await tx.wait();
    res.json({ success: true, txHash: tx.hash, reward: '300 BASC' });
  } catch (err) {
    const cooldown = err.message?.includes('wait 30 days');
    res.status(cooldown ? 200 : 500).json({ success: false, reason: cooldown ? 'cooldown_active' : err.message });
  }
});

router.post('/referral', requireSecret, async (req, res) => {
  const { walletAddress } = req.body;
  if (!walletAddress || !ethers.isAddress(walletAddress)) {
    return res.status(400).json({ success: false, error: 'Invalid wallet address' });
  }
  try {
    const tx = await getContract().distributeReferralReward(walletAddress);
    await tx.wait();
    res.json({ success: true, txHash: tx.hash, reward: '50 BASC' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/pool', requireSecret, async (_req, res) => {
  try {
    const [allocated, distributed, remaining, percentUsed] = await getContract().poolStats();
    res.json({
      success: true,
      data: {
        allocated:    ethers.formatUnits(allocated, 18)   + ' BASC',
        distributed:  ethers.formatUnits(distributed, 18) + ' BASC',
        remaining:    ethers.formatUnits(remaining, 18)   + ' BASC',
        percentUsed:  Number(percentUsed) + '%',
        poolExhausted: remaining === 0n,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
