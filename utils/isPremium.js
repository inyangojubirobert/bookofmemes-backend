import { supabase } from '../config/db.js';
import { AI_PLANS } from '../config/aiPlans.js';

// The user's Bascardo AI plan (migration 059's get_ai_plan): the AI_PLANS entry
// plus the subscription behind it. Falls back to Free if the lookup fails, so
// an outage never hands out paid limits.
export async function getAiPlan(userId) {
  if (!userId) return { ...AI_PLANS.free, subscription: null };
  const { data, error } = await supabase.rpc('get_ai_plan', { p_user_id: userId });
  if (error) {
    // Before migration 059 is applied: honour the old credits Premium as Pro.
    console.error('[ai plan] lookup failed:', error.message);
    const { data: legacy } = await supabase.from('subscriptions').select('expires_at')
      .eq('user_id', userId).eq('status', 'active').gt('expires_at', new Date().toISOString())
      .order('expires_at', { ascending: false }).limit(1).maybeSingle();
    return legacy
      ? { ...AI_PLANS.pro, subscription: { plan: 'pro', status: 'cancelled', provider: 'credits', current_period_end: legacy.expires_at } }
      : { ...AI_PLANS.free, subscription: null };
  }
  const plan = AI_PLANS[data?.plan] || AI_PLANS.free;
  return { ...plan, subscription: plan.id === 'free' ? null : data };
}

// Pro or Business: premium models, no watermark.
export async function isPremium(userId) {
  return (await getAiPlan(userId)).premiumModels;
}
