// The monthly AI credit pool (config/aiPlans.js). Usage is kept in
// ai_usage_monthly under feature 'ai_credits', reset each calendar month (UTC).
import { monthlyUsage, recordMonthlyUsage } from './monthlyQuota.js';
import { getAiPlan } from './isPremium.js';
import { creditsFor } from '../config/aiPlans.js';

const FEATURE = 'ai_credits';

export function resetsAt(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

/** { plan, limit, used, remaining, resetsAt } for this month. */
export async function creditStatus(userId, plan = null) {
  const p = plan || await getAiPlan(userId);
  const used = await monthlyUsage(userId, FEATURE);
  return { plan: p, limit: p.monthlyCredits, used, remaining: Math.max(0, p.monthlyCredits - used), resetsAt: resetsAt() };
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
