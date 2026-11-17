// Google Play subscriptions for Bascardo AI plans (ported from One Dream's
// lib/aiPayments.js). Every state comes from Google's subscriptionsv2 API,
// never from the app.
import crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { supabase } from '../config/db.js';
import { createPlayAuthClient } from '../config/playAuth.js';
import { PLAY_PACKAGE_NAME } from '../config/playProducts.js';
import { AI_PLANS, planFromGoogleProductId } from '../config/aiPlans.js';

const API = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(PLAY_PACKAGE_NAME)}`;
const ACTIVE_STATES = new Set(['SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD', 'SUBSCRIPTION_STATE_CANCELED']);
const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export const tokenRef = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

let client = null;
async function play(path, method = 'GET', data) {
  client = client || await createPlayAuthClient();
  const r = await client.request({ url: `${API}${path}`, method, data });
  return r.data;
}

/** Reads one purchase token from Google and turns it into our state. */
export async function verifyPlaySubscription(purchaseToken) {
  const token = String(purchaseToken || '');
  if (!token || token.length > 4096) throw new Error('invalid_purchase_token');
  const observedAt = new Date().toISOString();
  const payload = await play(`/purchases/subscriptionsv2/tokens/${encodeURIComponent(token)}`);
  return parsePlaySubscription(payload, observedAt);
}

export function parsePlaySubscription(payload, observedAt = new Date().toISOString()) {
  const items = (payload.lineItems || []).filter((i) => planFromGoogleProductId(i.productId));
  if (!items.length) throw new Error('unknown_google_play_product');
  // A deferred downgrade has two line items in no fixed order: the paid one
  // keeps its expiry, the future one has none. Prefer live, then higher plan.
  const rank = (i) => AI_PLANS[planFromGoogleProductId(i.productId)].priceUsd;
  const live = (i) => new Date(i.expiryTime || 0).getTime() > Date.now();
  const item = [...items].sort((a, b) => Number(live(b)) - Number(live(a))
    || (live(a) && live(b) ? rank(b) - rank(a) : 0)
    || new Date(b.expiryTime || 0) - new Date(a.expiryTime || 0))[0];
  const end = item.expiryTime || null;
  const active = ACTIVE_STATES.has(payload.subscriptionState) && !!end && new Date(end).getTime() > Date.now();
  const status = active
    ? (payload.subscriptionState === 'SUBSCRIPTION_STATE_CANCELED' ? 'cancelled' : 'active')
    : payload.subscriptionState === 'SUBSCRIPTION_STATE_PENDING' ? 'pending'
      : payload.subscriptionState === 'SUBSCRIPTION_STATE_ON_HOLD' ? 'past_due' : 'expired';
  return {
    productId: item.productId,
    productIds: items.map((i) => i.productId),
    planId: planFromGoogleProductId(item.productId),
    status,
    active,
    currentPeriodStart: payload.startTime || null,
    currentPeriodEnd: end,
    acknowledgementState: payload.acknowledgementState,
    externalAccountId: payload.externalAccountIdentifiers?.obfuscatedExternalAccountId || null,
    linkedPurchaseToken: payload.linkedPurchaseToken || null,
    retireLinked: !!(payload.startTime && !['SUBSCRIPTION_STATE_PENDING', 'SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED'].includes(payload.subscriptionState)),
    pendingProductId: item.deferredItemReplacement?.productId || null,
    autoRenewing: item.autoRenewingPlan?.autoRenewEnabled ?? null,
    observedAt,
  };
}

export async function acknowledgePlaySubscription(productId, purchaseToken) {
  await play(`/purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`, 'POST', {});
}

/** Stores the verified state for this user and returns their plan in force. */
export async function syncPlaySubscription(userId, purchaseToken, v) {
  if (v.externalAccountId && v.externalAccountId !== userId) throw new Error('payment_account_mismatch');
  const { data, error } = await supabase.rpc('sync_play_subscription', {
    p_input: {
      user_id: userId,
      provider_reference: tokenRef(purchaseToken),
      product_id: v.productId,
      plan: v.planId,
      status: v.status,
      current_period_start: v.currentPeriodStart,
      current_period_end: v.currentPeriodEnd,
      linked_reference: v.linkedPurchaseToken ? tokenRef(v.linkedPurchaseToken) : null,
      retire_linked: v.retireLinked,
      pending_product_id: v.pendingProductId,
      auto_renewing: v.autoRenewing,
      observed_at: v.observedAt,
    },
  });
  if (error) throw new Error(error.message);
  return data;
}

/** Owner of a token seen in a notification: our records, or the account id the app gave Google. */
export async function findSubscriptionOwner(purchaseToken, v) {
  const owners = new Set();
  for (const token of [purchaseToken, v.linkedPurchaseToken].filter(Boolean)) {
    const { data, error } = await supabase.from('play_subscriptions').select('user_id').eq('provider_reference', tokenRef(token)).maybeSingle();
    if (error) throw new Error(error.message);
    if (data) owners.add(data.user_id);
  }
  if (v.externalAccountId) {
    if (!UUID.test(v.externalAccountId)) throw new Error('payment_account_mismatch');
    owners.add(v.externalAccountId);
  }
  if (owners.size > 1) throw new Error('payment_account_mismatch');
  return [...owners][0] || null;
}

/** Real-time developer notifications arrive as Pub/Sub pushes signed by Google (OIDC). */
export async function verifyPubSubPush(authorizationHeader) {
  const audience = process.env.GOOGLE_PLAY_PUBSUB_AUDIENCE;
  const expectedEmail = process.env.GOOGLE_PLAY_PUBSUB_SERVICE_ACCOUNT_EMAIL;
  const token = String(authorizationHeader || '').replace(/^Bearer\s+/i, '');
  if (!audience || !expectedEmail || !token) return false;
  try {
    const ticket = await new OAuth2Client().verifyIdToken({ idToken: token, audience });
    const p = ticket.getPayload();
    return !!(p?.email_verified && p.email === expectedEmail);
  } catch {
    return false;
  }
}
