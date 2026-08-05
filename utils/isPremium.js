import { supabase } from '../config/db.js';

// Shared across routes that gate a feature behind an active subscription
// (rewardDistributorRoutes.js, aiRoutes.js). Trusts status = 'active' alone,
// matching the existing convention -- does not additionally check
// expires_at, so a lapsed subscription must be flipped to 'expired'/
// 'cancelled' elsewhere for this to stay accurate.
export async function isPremium(userId) {
  if (!userId) return false;
  const { data } = await supabase
    .from('subscriptions')
    .select('id')
    .eq('user_id', userId)
    .eq('status', 'active')
    .single();
  return !!data;
}
