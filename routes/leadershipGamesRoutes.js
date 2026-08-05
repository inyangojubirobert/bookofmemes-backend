import { supabase } from '../config/db.js';

// Leadership Games has no Express routes of its own -- every client action
// (join/leave waitlist, fetch today's questions, submit an answer) calls the
// SECURITY DEFINER Postgres functions from migration 016 directly via
// supabase.rpc() from src/services/leadershipGamesService.js, same pattern as
// MarketplaceService.js (see that file's header comment: the Express backend
// URL is unreachable from a local dev client, and these functions already
// check auth.uid() themselves).
//
// The one thing that has to run server-side is the sweep: settling circles
// whose 30 days are up and generating each active circle's daily question
// set. Same shape as runMarketplaceSweep/runAgentCashoutSweep in
// marketplaceRoutes.js -- a single Postgres function, invoked on an interval
// by this long-running server process.
export async function runLeadershipGamesSweep() {
  const { error } = await supabase.rpc('sweep_leadership_games');
  if (error) throw error;
}

export function startLeadershipGamesSweepTimer(intervalMs = 60 * 1000) {
  const sweep = () => {
    runLeadershipGamesSweep().catch((err) => console.error('[leadership games sweep] failed:', err.message));
  };
  sweep(); // run once at startup, then on the interval
  setInterval(sweep, intervalMs);
}
