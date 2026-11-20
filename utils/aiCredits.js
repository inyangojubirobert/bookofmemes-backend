// The monthly AI credit pool (config/aiPlans.js). Usage is kept in
// ai_usage_monthly under feature 'ai_credits', reset each calendar month (UTC).
import { monthlyUsage, recordMonthlyUsage } from './monthlyQuota.js';
import { supabase } from '../config/db.js';
import { getAiPlan } from './isPremium.js';
import { creditsFor } from '../config/aiPlans.js';

const FEATURE = 'ai_credits';

export function resetsAt(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

/** { plan, limit, used, held, remaining, resetsAt } for this month. "held" = reserved by steps still running. */
export async function creditStatus(userId, plan = null) {
  const p = plan || await getAiPlan(userId);
  const [used, held] = await Promise.all([monthlyUsage(userId, FEATURE), heldCredits(userId)]);
  return { plan: p, limit: p.monthlyCredits, used, held, remaining: Math.max(0, p.monthlyCredits - used - held), resetsAt: resetsAt() };
}

// ── Reservations (migration 073) ────────────────────────────────────────────
// reserve before the provider call, commit when the result is saved, release
// on failure. Until 073 is run the RPCs don't exist; these then fall back to
// the old check-then-spend so nothing breaks.
let reservationsLive = null; // null = not yet known
const missingFn = (err) => /function .*(reserve|commit|release|held)_ai_credits|could not find the function|PGRST202/i.test(String(err?.message || err?.code || ''));

async function heldCredits(userId) {
  if (reservationsLive === false) return 0;
  const { data, error } = await supabase.rpc('held_ai_credits', { p_user_id: userId });
  if (error) { if (missingFn(error)) reservationsLive = false; return 0; }
  reservationsLive = true;
  return Number(data) || 0;
}

/**
 * Atomically holds `credits` from the user's pool. Returns a reservation
 * { id, credits, legacy } or null when the pool can't cover it.
 */
export async function reserveCredits(userId, plan, credits, requestId = null, ttlMinutes = 15) {
  if (!(credits > 0)) return { id: null, credits: 0, legacy: false };
  if (reservationsLive !== false) {
    const { data, error } = await supabase.rpc('reserve_ai_credits', {
      p_user_id: userId, p_limit: plan.monthlyCredits, p_credits: credits, p_request_id: requestId, p_ttl_minutes: ttlMinutes,
    });
    if (!error) { reservationsLive = true; return data ? { id: data, credits, legacy: false } : null; }
    if (!missingFn(error)) throw error;
    reservationsLive = false;
  }
  const status = await creditStatus(userId, plan);
  return status.remaining >= credits ? { id: null, credits, legacy: true } : null;
}

/** Spends a reservation once (or, before 073, records the spend directly). */
export async function commitCredits(userId, reservation, credits = null) {
  if (!reservation || !(reservation.credits > 0)) return;
  if (reservation.legacy || !reservation.id) { await spendCredits(userId, credits ?? reservation.credits); return; }
  const { error } = await supabase.rpc('commit_ai_credits', { p_reservation_id: reservation.id, p_credits: credits });
  if (error) console.error(`[ai credits] commit ${reservation.id} failed:`, error.message);
}

export async function releaseCredits(reservation) {
  if (!reservation?.id || reservation.legacy) return;
  const { error } = await supabase.rpc('release_ai_credits', { p_reservation_id: reservation.id });
  if (error) console.error(`[ai credits] release ${reservation.id} failed:`, error.message);
}

// Called after a generation succeeded: a bookkeeping failure must not take the
// result away from the user, so it is logged instead of thrown.
export async function spendCredits(userId, n) {
  if (!(n > 0)) return null;
  try {
    return await recordMonthlyUsage(userId, FEATURE, n, 'credits');
  } catch (err) {
    console.error(`[ai credits] could not record ${n} credits for ${userId}:`, err.message);
    return null;
  }
}

/** The shape every quota endpoint returns, so the app can show the pool. */
export function creditsView(status, action, opts = {}) {
  const cost = creditsFor(action, { premium: status.plan.premiumModels, ...opts });
  return {
    plan: status.plan.id,
    planName: status.plan.name,
    premium: status.plan.premiumModels,
    credits: { limit: status.limit, used: status.used, remaining: status.remaining, resetsAt: status.resetsAt },
    creditCost: cost,
    // How many more of this action the pool covers (kept for older app screens).
    remaining: Math.floor(status.remaining / cost),
  };
}

export function outOfCreditsMessage(status, cost, extra = '') {
  return `This needs ${cost} AI credit${cost === 1 ? '' : 's'} and you have ${status.remaining} of your ${status.limit} ${status.plan.name} credits left this month.${extra}`;
}
