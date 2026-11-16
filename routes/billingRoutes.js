// Google Play Billing: checks each purchase with Google, then credits the wallet.
//
// Env (see Backend/config/playAuth.js for the service account key):
//   GOOGLE_PLAY_SERVICE_ACCOUNT_FILE or GOOGLE_PLAY_SERVICE_ACCOUNT_JSON
//   GOOGLE_PLAY_PACKAGE_NAME          optional, defaults to the app's package
//   BILLING_SWEEP_SECRET              optional, guards the manual sweep endpoint
import express from 'express';
import { createPlayAuthClient, isPlayAuthConfigured } from '../config/playAuth.js';
import { supabase } from '../config/db.js';
import { authenticateToken } from '../auth.js';
import { PLAY_CREDIT_PRODUCTS, PLAY_PRODUCT_BY_ID, PLAY_PACKAGE_NAME } from '../config/playProducts.js';

const router = express.Router();
const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';

let authClient = null;
async function getAuthClient() {
  if (authClient) return authClient;
  authClient = await createPlayAuthClient();
  return authClient;
}

async function playRequest(path, method = 'GET') {
  const client = await getAuthClient();
  const res = await client.request({ url: `${API}/${PLAY_PACKAGE_NAME}${path}`, method });
  return res.data;
}

// GET /api/billing/products — the product IDs the app should load from Play, and
// how many credits each one gives.
router.get('/products', (_req, res) => {
  res.json({ success: true, data: PLAY_CREDIT_PRODUCTS });
});

// POST /api/billing/google/verify  { productId, purchaseToken }
// Called by the app after Play reports a purchase. The app only finishes
// (consumes) the purchase after this returns success, so a failed call here
// leaves the purchase pending and it's retried on the next app start.
router.post('/google/verify', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { productId, purchaseToken } = req.body || {};
    const product = PLAY_PRODUCT_BY_ID[productId];
    if (!product) return res.status(400).json({ success: false, error: 'Unknown product' });
    if (!purchaseToken) return res.status(400).json({ success: false, error: 'Missing purchase token' });

    let purchase;
    try {
      purchase = await playRequest(
        `/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}`
      );
    } catch (err) {
      const status = err.response?.status;
      console.error('[billing] Play lookup failed:', status, err.message);
      return res.status(status === 404 || status === 400 ? 400 : 502)
        .json({ success: false, error: 'Could not confirm this purchase with Google Play' });
    }

    // purchaseState: 0 purchased, 1 canceled, 2 pending
    if (purchase.purchaseState === 2) {
      return res.status(202).json({ success: false, pending: true, error: 'Payment is still pending' });
    }
    if (purchase.purchaseState !== 0) {
      return res.status(400).json({ success: false, error: 'Purchase was cancelled' });
    }
    // The app passes the user id as obfuscatedAccountId at purchase time, so a
    // token bought on one account can't be redeemed on another.
    if (purchase.obfuscatedExternalAccountId && purchase.obfuscatedExternalAccountId !== userId) {
      return res.status(403).json({ success: false, error: 'Purchase belongs to another account' });
    }

    const { data, error } = await supabase.rpc('credit_play_purchase', {
      p_user_id: userId,
      p_product_id: productId,
      p_purchase_token: purchaseToken,
      p_order_id: purchase.orderId || null,
      p_credits: product.credits,
      p_raw: purchase,
    });
    if (error) throw error;
    if (!data?.success) return res.status(400).json({ success: false, error: data?.error || 'Credit failed' });

    res.json({ success: true, data });
  } catch (error) {
    console.error('[billing] verify error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Refunds and chargebacks: Google lists them as voided purchases for 30 days.
// Each one found is reversed (idempotent, so overlapping windows are fine).
export async function runVoidedPurchaseSweep() {
  const startTime = Date.now() - 30 * 24 * 60 * 60 * 1000;
  let token;
  let reversed = 0;
  do {
    const qs = new URLSearchParams({ startTime: String(startTime), maxResults: '1000' });
    if (token) qs.set('token', token);
    const page = await playRequest(`/purchases/voidedpurchases?${qs}`);
    for (const v of page.voidedPurchases || []) {
      const { data, error } = await supabase.rpc('reverse_play_purchase', { p_purchase_token: v.purchaseToken });
      if (error) console.error('[billing sweep] reverse failed:', error.message);
      else if (data?.success && !data.already_reversed) reversed += 1;
    }
    token = page.tokenPagination?.nextPageToken;
  } while (token);
  return { reversed };
}

export function startVoidedPurchaseSweepTimer(intervalMs = 6 * 60 * 60 * 1000) {
  if (!isPlayAuthConfigured()) {
    console.warn('[billing sweep] Google Play service account not configured; refund sweep disabled');
    return;
  }
  const sweep = () => runVoidedPurchaseSweep()
    .then(({ reversed }) => { if (reversed) console.log(`[billing sweep] reversed ${reversed} refunded purchase(s)`); })
    .catch((err) => console.error('[billing sweep] failed:', err.message));
  sweep();
  setInterval(sweep, intervalMs);
}

// POST /api/billing/sweep-voided — manual trigger (x-sweep-secret header)
router.post('/sweep-voided', async (req, res) => {
  if (!process.env.BILLING_SWEEP_SECRET || req.headers['x-sweep-secret'] !== process.env.BILLING_SWEEP_SECRET) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  try {
    res.json({ success: true, data: await runVoidedPurchaseSweep() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
