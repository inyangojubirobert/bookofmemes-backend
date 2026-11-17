// Bascardo AI plans: Free / Pro / Business as Google Play subscriptions
// (migration 059, config/aiPlans.js). Mounted at /api/subscriptions.
import express from 'express';
import { authenticateToken } from '../auth.js';
import { supabase } from '../config/db.js';
import { AI_PLANS, AI_PLAN_ORDER, planFromGoogleProductId, publicPlan } from '../config/aiPlans.js';
import { PLAY_PACKAGE_NAME } from '../config/playProducts.js';
import { getAiPlan } from '../utils/isPremium.js';
import {
  verifyPlaySubscription, syncPlaySubscription, acknowledgePlaySubscription,
  findSubscriptionOwner, verifyPubSubPush,
} from '../utils/playSubscriptions.js';

const router = express.Router();

router.get('/plans', (_req, res) => {
  res.json({ success: true, data: { plans: AI_PLAN_ORDER.map((id) => publicPlan(AI_PLANS[id])), package_name: PLAY_PACKAGE_NAME } });
});

// The signed-in user's plan in force and their Play subscriptions.
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const plan = await getAiPlan(req.user.id);
    const { data: rows, error } = await supabase.from('play_subscriptions')
      .select('product_id, plan, status, current_period_end, pending_product_id, auto_renewing, observed_at')
      .eq('user_id', req.user.id).is('replaced_by_reference', null)
      .order('observed_at', { ascending: false }).limit(10);
    if (error) throw error;
    res.json({ success: true, data: { plan: publicPlan(plan), subscription: plan.subscription, subscriptions: rows || [] } });
  } catch (err) {
    console.error('[subscriptions] me failed:', err.message);
    res.status(500).json({ success: false, error: 'Could not load your plan' });
  }
});

// The app sends every subscription purchase (new, upgrade, downgrade, restore)
// here; the server checks it with Google, records it and acknowledges it.
router.post('/google-play', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const purchaseToken = String(req.body?.purchase_token || '').trim();
  const productId = String(req.body?.product_id || '').trim();
  if (!purchaseToken || purchaseToken.length > 4096 || !planFromGoogleProductId(productId)) {
    return res.status(400).json({ success: false, error: 'A valid Google Play subscription purchase is required.' });
  }
  try {
    const v = await verifyPlaySubscription(purchaseToken);
    if (!v.productIds.includes(productId)) return res.status(400).json({ success: false, error: 'Google Play product mismatch.' });
    if (v.externalAccountId && v.externalAccountId !== userId) {
      return res.status(409).json({ success: false, error: 'This Google Play subscription belongs to another Book of Memes account.' });
    }
    const effective = await syncPlaySubscription(userId, purchaseToken, v);
    if (v.active && v.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_PENDING') await acknowledgePlaySubscription(v.productId, purchaseToken);
    const plan = AI_PLANS[effective?.plan] || AI_PLANS.free;
    const until = v.currentPeriodEnd ? new Date(v.currentPeriodEnd).toLocaleDateString('en-GB', { timeZone: 'UTC' }) : null;
    res.json({
      success: true,
      data: {
        plan: publicPlan(plan),
        status: v.status,
        current_period_end: effective?.current_period_end || null,
        pending_product_id: v.pendingProductId,
        message: v.pendingProductId && v.active
          ? `Plan change scheduled. ${plan.name} continues until ${until}.`
          : v.active ? `${plan.name} is now active.`
            : v.status === 'pending' ? 'Google Play is still processing the payment. Your plan starts when it completes.'
              : 'Purchase checked. Your plan has been refreshed.',
      },
    });
  } catch (err) {
    console.error('[subscriptions] google-play verify failed:', err.response?.data?.error?.message || err.message);
    const owned = ['payment_already_claimed', 'payment_account_mismatch'].includes(err.message);
    const missing = ['42P01', 'PGRST202', 'PGRST205'].includes(err.code) || /get_ai_plan|sync_play_subscription|play_subscriptions/.test(err.message);
    const notConfigured = /service account not configured|ENOENT/.test(err.message);
    res.status(owned ? 409 : missing || notConfigured ? 503 : 502).json({
      success: false,
      error: owned ? 'This purchase belongs to another Book of Memes account.'
        : missing ? 'Subscriptions are being set up. Please try again later.'
          : notConfigured ? 'Google Play verification is not configured yet.'
            : 'Could not verify this Google Play subscription. Try again shortly.',
    });
  }
});

// Google Play real-time developer notifications (Pub/Sub push). Renewals,
// cancellations, holds, refunds and plan changes arrive here even when the
// app is closed. A non-2xx answer makes Pub/Sub retry.
router.post('/google-play/notification', async (req, res) => {
  if (!(await verifyPubSubPush(req.headers.authorization))) return res.status(401).json({ error: 'Invalid Pub/Sub identity' });
  try {
    const encoded = req.body?.message?.data;
    if (!encoded) return res.status(400).json({ error: 'Missing message data' });
    const n = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    if (n.packageName !== PLAY_PACKAGE_NAME) return res.status(400).json({ error: 'Package mismatch' });
    const token = n?.subscriptionNotification?.purchaseToken;
    if (!token) return res.status(204).end(); // test or one-time-product notification
    const v = await verifyPlaySubscription(token);
    const owner = await findSubscriptionOwner(token, v);
    if (!owner) return res.status(503).json({ error: 'Purchase not linked to an account yet; retry' });
    await syncPlaySubscription(owner, token, v);
    if (v.active && v.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_PENDING') await acknowledgePlaySubscription(v.productId, token);
    res.status(204).end();
  } catch (err) {
    if (err.message === 'unknown_google_play_product') return res.status(204).end();
    console.error('[subscriptions] RTDN failed:', err.message);
    res.status(500).json({ error: 'Notification processing failed' });
  }
});

export default router;
