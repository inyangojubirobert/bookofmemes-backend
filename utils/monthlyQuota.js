import { supabase } from '../config/db.js';

// Backs the monthly free-tier caps for images/video/voice (migrations/021).
// Unlike aiRoutes.js's in-memory daily text-generation counter, this is
// durable in Postgres -- a monthly cap that silently reset to zero on every
// deploy would defeat the entire point of capping the expensive features.

function currentPeriodStart() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

export async function monthlyUsage(userId, feature) {
  const { data, error } = await supabase
    .from('ai_usage_monthly')
    .select('amount')
    .eq('user_id', userId)
    .eq('feature', feature)
    .eq('period_start', currentPeriodStart())
    .maybeSingle();
  if (error) throw error;
  return data?.amount || 0;
}

// unit is denormalized onto each row (migrations/024) so a raw SQL query can
// group by unit without having to already know which feature names count
// generations vs seconds -- 'image'/'video' stay the default 'generations'.
export async function recordMonthlyUsage(userId, feature, amount = 1, unit = 'generations') {
  const { data, error } = await supabase.rpc('increment_ai_usage', {
    p_user_id: userId,
    p_feature: feature,
    p_period_start: currentPeriodStart(),
    p_amount: amount,
    p_unit: unit,
  });
  if (error) throw error;
  return data;
}
