// AI credits: one view of the user's credits for every studio, and top-ups.
//   GET  /api/ai/credits          plan credits left this month, top-up credits, packs, what things cost
//   POST /api/ai/credits/topup    { pack, request_id }  buy extra AI credits with wallet balance
//
// Top-up credits (migration 075) never expire and are used only after the
// month's plan credits. Prices: config/aiPlans.js TOPUP_PACKS (always dearer
// per credit than a subscription; checked by scripts/aiPlanEconomics.js).
import express from 'express';
import { supabase } from '../config/db.js';
import { authenticateToken } from '../auth.js';
import { creditStatus } from '../utils/aiCredits.js';
import { AI_PLANS, TOPUP_PACKS, ACTION_COSTS } from '../config/aiPlans.js';
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
  packs: Object.values(TOPUP_PACKS).map((p) => ({ id: p.id, credits: p.credits, price_usd: p.priceUsd, per_credit_usd: Number((p.priceUsd / p.credits).toFixed(4)) })),
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

export default router;
