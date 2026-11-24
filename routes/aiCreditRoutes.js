// AI credits: one view of the user's credits for every studio, and top-ups.
//   GET  /api/ai/credits          plan credits left this month, top-up credits, packs, what things cost
//   POST /api/ai/credits/topup    { pack, request_id }  buy extra AI credits with wallet balance
//   POST /api/ai/credits/topup/google-play  { product_id, purchase_token }  a pack bought through Google Play (089)
//
// Top-up credits (migration 075) never expire and are used only after the
// month's plan credits. Prices: config/aiPlans.js TOPUP_PACKS (always dearer
// per credit than a subscription; checked by scripts/aiPlanEconomics.js).
import express from 'express';
import { supabase } from '../config/db.js';
import { authenticateToken } from '../auth.js';
import { creditStatus } from '../utils/aiCredits.js';
import { AI_PLANS, TOPUP_PACKS, TOPUP_PACK_BY_PLAY_ID, ACTION_COSTS } from '../config/aiPlans.js';
import { createPlayAuthClient } from '../config/playAuth.js';
import { PLAY_PACKAGE_NAME } from '../config/playProducts.js';
import { newTitlePayment, payNewTitle, newTitleFeeText, NEW_TITLE_FEE_VIEW } from '../utils/titleFee.js';
import { hasCredits, chargeCredits, formatCredits } from '../utils/credits.js';

const router = express.Router();
const REQ_ID = /^[A-Za-z0-9_-]{8,80}$/;
const fail = (res, status, error, extra = {}) => res.status(status).json({ success: false, error, ...extra });

const view = (status) => ({
  plan: { id: status.plan.id, name: status.plan.name, monthly_credits: status.limit, premium_models: status.plan.premiumModels, video: status.plan.premiumModels },
  used_this_month: status.used,
  monthly_left: Math.max(0, status.limit - status.used),
  topup: status.topup || 0,
  in_use: status.held || 0,
  remaining: status.remaining,
  resets_at: status.resetsAt,
  packs: Object.values(TOPUP_PACKS).map((p) => ({ id: p.id, credits: p.credits, price_usd: p.priceUsd, per_credit_usd: Number((p.priceUsd / p.credits).toFixed(4)), google_play_product_id: p.googlePlayProductId || null, clips: Math.floor(p.credits / ACTION_COSTS.video.premium) })),
  plans: Object.values(AI_PLANS).map((p) => ({ id: p.id, name: p.name, price_usd: p.priceUsd, monthly_credits: p.monthlyCredits })),
  costs: Object.fromEntries(Object.entries(ACTION_COSTS).map(([k, v]) => [k, status.plan.premiumModels ? v.premium : v.fast])),
});

router.get('/', authenticateToken, async (req, res) => {
  try { res.json({ success: true, data: view(await creditStatus(req.user.id)) }); }
  catch (err) { console.error('[ai credits] view:', err.message); fail(res, 500, 'Could not load your AI credits'); }
});

// The $1 new-title fee for Add Content (the Studios charge it themselves):
// wallet credits when they cover it, otherwise AI credits (utils/titleFee.js).
//   GET  /api/ai/credits/new-title   how it would be paid now: { paid_with: 'wallet' | 'ai_credits' | null }
//   POST /api/ai/credits/new-title   { description, request_id }  takes it
router.get('/new-title', authenticateToken, async (req, res) => {
  try { res.json({ success: true, data: { ...NEW_TITLE_FEE_VIEW, paid_with: await newTitlePayment(req.user.id) } }); }
  catch (err) { console.error('[title fee] check:', err.message); fail(res, 500, 'Could not check your credits'); }
});

router.post('/new-title', authenticateToken, async (req, res) => {
  const description = String(req.body?.description || 'New title').slice(0, 200);
  const rid = REQ_ID.test(String(req.body?.request_id || '')) ? `${req.user.id}:${req.body.request_id}` : null;
  try {
    const paidWith = await payNewTitle(req, req.user.id, description, rid);
    if (!paidWith) return fail(res, 402, `Posting a new title costs ${newTitleFeeText()}. Nothing was charged.`, { code: 'needs_wallet_credits' });
    res.json({ success: true, data: { paid_with: paidWith, ...NEW_TITLE_FEE_VIEW } });
  } catch (err) {
    console.error('[title fee] pay:', err.message);
    fail(res, 500, 'Could not take the title fee. Nothing was charged.');
  }
});

router.post('/topup', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const pack = TOPUP_PACKS[req.body?.pack];
  const requestId = String(req.body?.request_id || '');
  if (!pack) return fail(res, 400, 'Pick a top-up pack');
  if (!REQ_ID.test(requestId)) return fail(res, 400, 'Missing request id. Please update the app.');
  const rid = `topup:${userId}:${requestId}`;

  // Everything that could stop the grant is checked BEFORE the wallet is charged.
  const { data: done } = await supabase.from('ai_credit_topups').select('id').eq('request_id', rid).maybeSingle()
    .then((r) => r, () => ({ data: null }));
  if (done) return res.json({ success: true, data: view(await creditStatus(userId)), replayed: true });
  const probe = await supabase.rpc('ai_topup_balance', { p_user_id: userId });
  if (probe.error) return fail(res, 503, 'Top-ups are not switched on yet. Please try again later.');
  if (!(await hasCredits(userId, pack.priceUsd))) {
    return fail(res, 402, `This top-up costs ${formatCredits(pack.priceUsd)} from your wallet. Add credits to your wallet first.`, { code: 'needs_wallet_credits' });
  }

  let charged = false;
  try {
    charged = await chargeCredits(req, pack.priceUsd, `Bascardo AI credits: ${pack.credits}`);
  } catch (err) {
    console.error('[ai credits] charge failed:', err.message);
  }
  if (!charged) return fail(res, 402, `This top-up costs ${formatCredits(pack.priceUsd)} from your wallet. Nothing was charged.`, { code: 'needs_wallet_credits' });

  const { data: granted, error } = await supabase.rpc('grant_ai_topup', { p_user_id: userId, p_pack: pack.id, p_credits: pack.credits, p_price: pack.priceUsd, p_request_id: rid });
  if (error || granted === false) {
    // Charged but not granted: shout in the logs so it can be put right by hand.
    console.error(`[ai credits] TOPUP CHARGED BUT NOT GRANTED user=${userId} pack=${pack.id} rid=${rid}:`, error?.message || 'duplicate');
    if (error) return fail(res, 500, 'Your wallet was charged but the credits could not be added. Contact support (Profile → Message admin) and we will fix it.');
  }
  res.json({ success: true, data: view(await creditStatus(userId)), added: pack.credits });
});

// ── A pack bought through Google Play ────────────────────────────────────────
// The app finishes (consumes) the purchase only after this succeeds, so an interrupted purchase
// is sent again on the next app start; the same token is granted once (grant_ai_topup_play).
let playClient = null;
async function playRequest(path) {
  playClient = playClient || await createPlayAuthClient();
  const r = await playClient.request({ url: `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PLAY_PACKAGE_NAME}${path}`, method: 'GET' });
  return r.data;
}

router.post('/topup/google-play', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const productId = String(req.body?.product_id || '').trim();
  const token = String(req.body?.purchase_token || '').trim();
  const pack = TOPUP_PACK_BY_PLAY_ID[productId];
  if (!pack) return fail(res, 400, 'Unknown credit pack');
  if (!token || token.length > 4096) return fail(res, 400, 'A Google Play purchase is required');
  let purchase;
  try {
    purchase = await playRequest(`/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(token)}`);
  } catch (err) {
    const status = err.response?.status;
    console.error('[ai credits] Play lookup failed:', status, err.message);
    return fail(res, [400, 404, 410].includes(status) ? 400 : 502, 'Could not confirm this purchase with Google Play');
  }
  const state = Number(purchase?.purchaseState);
  if (state === 2) return res.status(202).json({ success: false, pending: true, error: 'Payment is pending at Google Play' });
  if (state !== 0) return fail(res, 400, 'This purchase was cancelled');
  if (purchase.obfuscatedExternalAccountId !== userId) return fail(res, 409, 'This purchase is not linked to your account');
  if (purchase.quantity && Number(purchase.quantity) !== 1) return fail(res, 400, 'Multi-quantity purchases are not supported');

  const { data: result, error } = await supabase.rpc('grant_ai_topup_play', {
    p_user_id: userId, p_pack: pack.id, p_credits: pack.credits, p_price: pack.priceUsd, p_token: token, p_order_id: purchase.orderId || null,
  });
  if (error) {
    console.error(`[ai credits] PLAY TOPUP PAID BUT NOT GRANTED user=${userId} pack=${pack.id}:`, error.message);
    return fail(res, /grant_ai_topup_play|PGRST202/.test(error.message) ? 503 : 500, 'Your purchase is safe: the credits will be added when you open the app again.');
  }
  if (result === 'other_user') return fail(res, 409, 'This purchase belongs to another account');
  res.json({ success: true, data: view(await creditStatus(userId)), added: result === 'granted' ? pack.credits : 0, already_granted: result === 'already' });
});

/** The refund sweep (routes/billingRoutes.js): a refunded pack takes its credits back. */
export async function revokeVoidedAiTopup(purchaseToken) {
  const { error } = await supabase.rpc('reverse_ai_topup_play', { p_token: purchaseToken });
  if (error && !/reverse_ai_topup_play|PGRST202/.test(error.message)) throw error;
}

export default router;
