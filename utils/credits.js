// In-app credits (wallets.wallet_balance, USD-valued, bought only through
// Google Play Billing). Every paid AI feature and new-title posting charges
// credits through consume_app_balance(), which spends spend-vouchers first,
// then the wallet, atomically and scoped to auth.uid().
import { supabase } from '../config/db.js';
import { userScopedClient, tokenFromRequest } from './supabaseUserClient.js';

// Prices in credits ($). Same real-money amounts the old BASC token prices
// had (100 BASC = $1).
export const CREDIT_PRICES = {
  writeOverage: 0.02,      // per AI writing request past the free daily cap
  imageHd: 0.15,           // per HD image
  // HD video uses Seedance 2.0: ~$0.80 for 5 s, up to ~$2 from a start image
  // (Runware examples, 2026-11-17), and Google keeps up to 30% of credit sales.
  videoHd: 1.5,            // per HD video
  videoHdWithReference: 3.0, // per HD video animated from a start image
  voiceHdPerMinute: 0.1,   // per started minute of HD narration
  newTitle: 1.0,           // posting a new title (charged in the app, see AddContent.js)
};

export const formatCredits = (amount) => `$${Number(amount).toFixed(2)}`;

// For ai_generation_history.cost_tokens (integer): stored in cents so the
// numbers stay on the same scale as the old BASC values (100 = $1).
export const creditsToLogUnits = (amount) => Math.round(Number(amount) * 100);

// Quick pre-check before paying a provider. The charge itself re-checks
// atomically, so this only avoids generating something the user can't pay for.
export async function hasCredits(userId, amount) {
  const { data: wallet } = await supabase.from('wallets').select('id, wallet_balance').eq('user_id', userId).single();
  if (!wallet) return false;
  if (Number(wallet.wallet_balance || 0) >= amount) return true;
  const { data: vouchers } = await supabase
    .from('spend_vouchers')
    .select('remaining_amount')
    .eq('recipient_wallet_id', wallet.id)
    .eq('status', 'active')
    .gt('expires_at', new Date().toISOString());
  const voucherTotal = (vouchers || []).reduce((s, v) => s + Number(v.remaining_amount || 0), 0);
  return Number(wallet.wallet_balance || 0) + voucherTotal >= amount;
}

// Charges the requesting user. Returns true when the charge went through.
export async function chargeCredits(req, amount, description) {
  const { data, error } = await userScopedClient(tokenFromRequest(req)).rpc('consume_app_balance', {
    p_amount: amount,
    p_description: description,
  });
  if (error) throw error;
  return !!data?.success;
}
