import express from 'express';
import { supabase } from '../config/db.js';

// What's left of the original credit-based marketplace API (migrations 029/030):
// only the deadline sweep. Listings, bids, acceptance and Buy Now are now cash
// based and live in routes/marketRoutes.js (migrations 055/057); the old
// endpoints here had no callers in the app and their database functions are
// switched off, so they were removed on 2026-11-18.

const router = express.Router();

// Runs the marketplace deadlines (24h reminders, ending auctions, the owner's
// decision window, automatic winners, expiring featured listings). pg_cron
// also runs it every 5 minutes; this keeps it going if cron isn't set up.
export async function runMarketplaceSweep() {
  const { data, error } = await supabase.rpc('process_marketplace_deadlines');
  if (error) throw error;
  return data || {};
}

// Starts the in-app sweep timer. Only runs while this server process is alive --
// fine here since Backend/server.js is a long-running Express process, not
// serverless. Call once from server.js after the app starts listening.
export function startMarketplaceSweepTimer(intervalMs = 15 * 60 * 1000) {
  const sweep = () => {
    runMarketplaceSweep()
      .then((r) => {
        const changed = Object.entries(r).filter(([, n]) => Number(n) > 0);
        if (changed.length) console.log(`[marketplace sweep] ${changed.map(([k, n]) => `${k} ${n}`).join(', ')}`);
      })
      .catch((err) => console.error('[marketplace sweep] failed:', err.message));
  };
  sweep(); // run once at startup, then on the interval
  setInterval(sweep, intervalMs);
}

/**
 * @route   POST /api/marketplace/sweep-expired
 * @desc    Maintenance: same sweep as the in-app timer, exposed over HTTP for manual
 *          testing (curl) or an external scheduler. Guarded by a shared secret.
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
