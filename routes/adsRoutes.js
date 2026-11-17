// Advertising, post boosts and campaigns (migration 058), on One Dream's model:
// packages bought as Google Play products (or with credits), one campaign per
// purchase, private media until approved, admin review for ads, boosts live at
// once, de-duplicated analytics, house ads filling empty slots.
//
//   GET    /api/ads/packages                 package catalogue
//   POST   /api/ads/purchase/google-play     { product_id, purchase_token } -> entitlement
//   POST   /api/ads/purchase/credits         { package_id } -> entitlement
//   GET    /api/ads/campaigns                my entitlements + campaigns (with stats)
//   POST   /api/ads/campaigns                create a draft from an available entitlement
//   PATCH  /api/ads/campaigns                edit (live ad -> back to review)
//   DELETE /api/ads/campaigns?id=            delete a draft/rejected campaign (package returned)
//   POST   /api/ads/campaigns/submit         { id }
//   GET    /api/ads/campaigns/analytics?id=&range=7d|30d|lifetime
//   POST   /api/ads/media/sign               { resource_type } -> signed private upload
//   GET/POST/DELETE /api/ads/media           my media library / register upload / remove
//   GET    /api/ads/serve?placement=&ads=&boosts=   public: what to show
//   POST   /api/ads/event                    { campaign_id, kind, placement }  (header x-ad-viewer)
//   Admin: GET /api/ads/admin/queue, POST /api/ads/admin/review, house ads under /api/ads/admin/house-ads
import express from 'express';
import crypto from 'crypto';
import { supabase } from '../config/db.js';
import { authenticateToken } from '../auth.js';
import { createPlayAuthClient } from '../config/playAuth.js';
import { PLAY_PACKAGE_NAME } from '../config/playProducts.js';
import { checkDestination } from '../utils/adDestinations.js';
import {
  adDeliveryUrl, adFolder, destroyAdAsset, getAdResource, publishAdAsset, signAdUpload, signHouseAdUpload,
  unpublishAdAsset, validateAdResource, HOUSE_FOLDER,
} from '../utils/cloudinaryAds.js';

const router = express.Router();
const PLACEMENTS = new Set(['home', 'explore', 'feed', 'search']);
const ITEM_TYPES = new Set(['stories', 'memes', 'puzzles', 'kids_collections', 'music_box', 'podcast_box', 'tv_box']);
const ITEM_IMAGE = { stories: 'cover_image_url', memes: 'image_url', puzzles: null, kids_collections: 'cover_image_url', music_box: 'cover_image_url', podcast_box: 'cover_image_url', tv_box: 'thumbnail_url' };
const FREQUENCY_CAP_PER_DAY = 6;
const FEATURED_PRIORITY = 50; // Bronze and up take the first slot
const clean = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const must = ({ data, error }) => { if (error) throw error; return data; };

const AD_ERRORS = {
  campaign_not_found: 'Campaign not found',
  campaign_not_submittable: 'This campaign cannot be submitted in its current state',
  entitlement_invalid: 'The package for this campaign is no longer valid',
  media_invalid: 'One of the selected creatives is not available',
  too_many_creatives: 'Too many creatives for this package',
  creative_required: 'Add at least one image or video',
  external_link_not_allowed: 'This package does not include external links',
  destination_unchecked: 'The destination link has not been verified yet',
  destination_stale: 'The destination link was last checked over 7 days ago - re-check it first',
  post_not_owned: 'Choose one of your own posts',
  campaign_not_pending: 'This campaign is not waiting for review',
  media_not_approved: 'Approve every creative before approving the campaign',
  placements_full: 'All placements for this package are full right now',
  campaign_not_suspendable: 'Only live or pending campaigns can be suspended',
  campaign_not_suspended: 'This campaign is not suspended',
  invalid_action: 'Unknown action',
  campaign_expired: 'This campaign has already ended',
  live_boost_locked: 'A live boost cannot be changed',
  extension_too_long: 'Compensation would exceed the package duration',
  campaign_not_started: 'This campaign has not started',
  note_required: 'A note is required',
  media_not_found: 'Media not found',
  insufficient_credits: 'Not enough credits. Buy credits in your Wallet first.',
  package_unavailable: 'This package is not available',
  account_being_deleted: 'This account is being deleted',
  admins_only: 'Admins only',
};
const adError = (error) => {
  const key = Object.keys(AD_ERRORS).find((code) => String(error?.message || '').includes(code));
  return key ? AD_ERRORS[key] : null;
};
function fail(res, err, fallback = 'Request failed') {
  const known = adError(err);
  if (known) return res.status(400).json({ success: false, error: known });
  console.error('[ads]', err?.message || err);
  return res.status(500).json({ success: false, error: fallback });
}

async function isAdmin(userId) {
  const { data } = await supabase.rpc('is_app_admin', { p_user_id: userId });
  return !!data;
}
async function requireAdmin(req, res, next) {
  if (!(await isAdmin(req.user.id))) return res.status(403).json({ success: false, error: 'Admins only' });
  next();
}

function snapshotOf(pkg) {
  return {
    id: pkg.id, kind: pkg.kind, name: pkg.name, price_usd: Number(pkg.price_usd), duration_hours: pkg.duration_hours,
    max_creatives: pkg.max_creatives, placements: pkg.placements, priority: pkg.priority, allow_external_link: pkg.allow_external_link,
  };
}

function mediaView(m) {
  let url = null; let poster = null;
  try {
    url = adDeliveryUrl(m);
    poster = m.resource_type === 'video' ? adDeliveryUrl(m, { poster: true, width: 720 }) : null;
  } catch { /* Cloudinary not configured */ }
  return {
    id: m.id, resource_type: m.resource_type, format: m.format, bytes: Number(m.bytes), width: m.width, height: m.height,
    duration_seconds: m.duration_seconds === null ? null : Number(m.duration_seconds), status: m.status,
    reject_reason: m.reject_reason, created_at: m.created_at, url, poster,
  };
}

const campaignState = (c, now = Date.now()) =>
  (c.status === 'active' && c.ends_at && new Date(c.ends_at).getTime() <= now ? 'completed' : c.status);

// Stable, non-reversible viewer key: the app's random install id, else IP + browser.
function viewerKey(req) {
  const supplied = String(req.headers['x-ad-viewer'] || '').slice(0, 128);
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
  const raw = supplied.length >= 16 ? `device:${supplied}` : `net:${ip}|${req.headers['user-agent'] || ''}`;
  return crypto.createHash('sha256').update(`${process.env.JWT_SECRET || 'bom-ads'}:${raw}`).digest('hex').slice(0, 40);
}

async function postOwner(itemType, itemId) {
  if (!ITEM_TYPES.has(itemType)) return null;
  const { data } = await supabase.rpc('ads_post_owner', { p_item_type: itemType, p_item_id: itemId });
  return data || null;
}

// ── Packages ───────────────────────────────────────────────────────────────
router.get('/packages', async (_req, res) => {
  try {
    const rows = must(await supabase.from('advertising_packages').select('*').eq('is_active', true).order('sort_order'));
    res.json({
      success: true,
      data: rows.map((p) => ({
        id: p.id, kind: p.kind, name: p.name, tagline: p.tagline, price_usd: Number(p.price_usd),
        duration_hours: p.duration_hours, max_creatives: p.max_creatives, placements: p.placements, priority: p.priority,
        allow_external_link: p.allow_external_link, benefits: Array.isArray(p.benefits) ? p.benefits : [], highlight: p.highlight,
        google_play_product_id: p.google_play_product_id, credits_purchasable: true,
      })),
    });
  } catch (err) { fail(res, err); }
});

// ── Purchases ──────────────────────────────────────────────────────────────
let playClient = null;
async function playRequest(path, method = 'GET') {
  playClient = playClient || await createPlayAuthClient();
  const r = await playClient.request({ url: `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PLAY_PACKAGE_NAME}${path}`, method });
  return r.data;
}

router.post('/purchase/google-play', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const productId = String(req.body?.product_id || '').trim();
    const token = String(req.body?.purchase_token || '').trim();
    if (!productId || !token || token.length > 4096) return res.status(400).json({ success: false, error: 'A Google Play purchase is required' });
    const pkg = must(await supabase.from('advertising_packages').select('*').eq('google_play_product_id', productId).eq('is_active', true).maybeSingle());
    if (!pkg) return res.status(400).json({ success: false, error: 'Unknown package' });

    const existing = must(await supabase.from('advertising_entitlements').select('id, user_id, status')
      .eq('provider', 'google_play').eq('provider_ref', token).maybeSingle());
    if (existing) {
      if (existing.user_id !== userId) return res.status(409).json({ success: false, error: 'This purchase belongs to another account' });
      return res.json({ success: true, data: { entitlement_id: existing.id, already_granted: true } });
    }

    let purchase;
    try {
      purchase = await playRequest(`/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(token)}`);
    } catch (err) {
      const status = err.response?.status;
      return res.status([400, 404, 410].includes(status) ? 400 : 502).json({ success: false, error: 'Could not confirm this purchase with Google Play' });
    }
    const state = Number(purchase?.purchaseState);
    if (state === 2) return res.status(202).json({ success: false, pending: true, error: 'Payment is pending at Google Play' });
    if (state !== 0) return res.status(400).json({ success: false, error: 'This purchase was cancelled' });
    if (purchase.obfuscatedExternalAccountId !== userId) return res.status(409).json({ success: false, error: 'This purchase is not linked to your account' });
    if (purchase.quantity && Number(purchase.quantity) !== 1) return res.status(400).json({ success: false, error: 'Multi-quantity purchases are not supported' });

    const { data: row, error } = await supabase.from('advertising_entitlements').insert({
      user_id: userId, package_id: pkg.id, package_snapshot: snapshotOf(pkg), provider: 'google_play', provider_ref: token,
      order_id: purchase.orderId || null, price_usd: pkg.price_usd, is_paid: true, status: 'available',
    }).select('id').single();
    if (error?.code === '23505') return res.json({ success: true, data: { already_granted: true } });
    if (error) throw error;
    // The app finishes (consumes) the purchase after this succeeds.
    res.json({ success: true, data: { entitlement_id: row.id } });
  } catch (err) { fail(res, err, 'Could not verify this purchase. Try again shortly.'); }
});

router.post('/purchase/credits', authenticateToken, async (req, res) => {
  try {
    const { data, error } = await supabase.rpc('ads_buy_with_credits', { p_user_id: req.user.id, p_package_id: String(req.body?.package_id || '') });
    if (error) throw error;
    res.json({ success: true, data: { entitlement_id: data.id } });
  } catch (err) { fail(res, err); }
});

// ── Campaigns ──────────────────────────────────────────────────────────────
async function loadPostMeta(itemType, itemId) {
  if (!ITEM_TYPES.has(itemType) || !itemId) return null;
  const img = ITEM_IMAGE[itemType];
  const { data } = await supabase.from(itemType).select(`id, title${img ? `, ${img}` : ''}`).eq('id', itemId).maybeSingle();
  return data ? { item_type: itemType, item_id: data.id, title: data.title || null, cover: img ? data[img] : null } : null;
}

router.get('/campaigns', authenticateToken, async (req, res) => {
  try {
    const uid = req.user.id;
    const [ents, camps] = await Promise.all([
      supabase.from('advertising_entitlements').select('id, package_id, package_snapshot, provider, price_usd, is_paid, status, revoke_reason, created_at')
        .eq('user_id', uid).order('created_at', { ascending: false }).limit(100),
      supabase.from('advertising_campaigns').select('*, advertising_campaign_media(position, advertising_media(*))')
        .eq('owner_id', uid).order('created_at', { ascending: false }).limit(50),
    ]);
    if (ents.error) throw ents.error;
    if (camps.error) throw camps.error;
    const campaigns = await Promise.all((camps.data || []).map(async (c) => {
      const [imp, clk, post] = await Promise.all([
        supabase.from('advertising_events').select('id', { count: 'exact', head: true }).eq('campaign_id', c.id).eq('kind', 'impression'),
        supabase.from('advertising_events').select('id', { count: 'exact', head: true }).eq('campaign_id', c.id).eq('kind', 'click'),
        c.destination_type === 'post' ? loadPostMeta(c.item_type, c.item_id) : null,
      ]);
      return {
        id: c.id, kind: c.kind, package_id: c.package_id, entitlement_id: c.entitlement_id, title: c.title, body: c.body,
        cta_label: c.cta_label, destination_type: c.destination_type, destination_url: c.destination_url,
        item_type: c.item_type, item_id: c.item_id, post, placements: c.placements, status: c.status, state: campaignState(c),
        starts_at: c.starts_at, ends_at: c.ends_at, submitted_at: c.submitted_at, review_note: c.review_note, created_at: c.created_at,
        media: (c.advertising_campaign_media || []).sort((a, b) => a.position - b.position)
          .map((r) => r.advertising_media && mediaView(r.advertising_media)).filter(Boolean),
        impressions: imp.count || 0, clicks: clk.count || 0,
      };
    }));
    res.json({
      success: true,
      data: {
        entitlements: (ents.data || []).map((e) => ({
          id: e.id, package_id: e.package_id, package: e.package_snapshot, status: e.status, provider: e.provider,
          price_usd: e.price_usd === null ? null : Number(e.price_usd), revoke_reason: e.revoke_reason, created_at: e.created_at,
        })),
        campaigns,
      },
    });
  } catch (err) { fail(res, err); }
});

/** Validates content against the purchased package terms. { fields } or { error }. */
async function buildFields(body, uid, snapshot, existing = null) {
  const fields = {};
  if (body.title !== undefined || !existing) {
    fields.title = clean(body.title, 80);
    if (fields.title.length < 2) return { error: 'Give your campaign a title' };
  }
  if (body.body !== undefined) fields.body = clean(body.body, 280) || null;
  if (body.cta_label !== undefined) fields.cta_label = clean(body.cta_label, 24) || null;

  const destinationType = body.destination_type ?? existing?.destination_type ?? (snapshot.kind === 'boost' ? 'post' : null);
  if (!['external', 'post', 'profile'].includes(destinationType)) return { error: 'Choose where the campaign leads' };
  if (snapshot.kind === 'boost' && destinationType !== 'post') return { error: 'A boost promotes one of your posts' };
  fields.destination_type = destinationType;

  if (destinationType === 'external') {
    if (!snapshot.allow_external_link) return { error: 'This package does not include external links' };
    const url = body.destination_url !== undefined ? body.destination_url : existing?.destination_url;
    if (body.destination_url !== undefined || !existing?.destination_checked_at || existing?.destination_type !== 'external') {
      const checked = await checkDestination(url);
      if (!checked.ok) return { error: checked.reason };
      Object.assign(fields, { destination_url: checked.url, destination_final_url: checked.finalUrl, destination_checked_at: new Date().toISOString() });
    }
  } else {
    Object.assign(fields, { destination_url: null, destination_final_url: null, destination_checked_at: null });
  }

  if (destinationType === 'post') {
    const itemType = body.item_type !== undefined ? body.item_type : existing?.item_type;
    const itemId = body.item_id !== undefined ? body.item_id : existing?.item_id;
    const owner = await postOwner(itemType, String(itemId || ''));
    if (!owner || owner !== uid) return { error: 'Choose one of your own posts' };
    Object.assign(fields, { item_type: itemType, item_id: itemId });
  } else {
    Object.assign(fields, { item_type: null, item_id: null });
  }
  return { fields };
}

async function setMedia(campaignId, mediaIds, uid, snapshot) {
  if (!Array.isArray(mediaIds)) return null;
  const ids = [...new Set(mediaIds.map(String))];
  const current = must(await supabase.from('advertising_campaign_media').select('media_id, position').eq('campaign_id', campaignId).order('position'));
  if ((current || []).map((r) => r.media_id).join(',') === ids.join(',')) return null; // unchanged: no re-review
  if (ids.length > snapshot.max_creatives) return `This package allows up to ${snapshot.max_creatives} creative${snapshot.max_creatives === 1 ? '' : 's'}`;
  if (ids.length) {
    const rows = must(await supabase.from('advertising_media').select('id').in('id', ids).eq('owner_id', uid).in('status', ['pending', 'approved']));
    if ((rows || []).length !== ids.length) return 'One of the selected creatives is not available';
  }
  must(await supabase.from('advertising_campaign_media').delete().eq('campaign_id', campaignId));
  if (ids.length) must(await supabase.from('advertising_campaign_media').insert(ids.map((media_id, position) => ({ campaign_id: campaignId, media_id, position }))));
  return null;
}

router.post('/campaigns', authenticateToken, async (req, res) => {
  const uid = req.user.id;
  try {
    // Claim the package atomically: one campaign per purchase.
    const { data: ent } = await supabase.from('advertising_entitlements')
      .update({ status: 'used', updated_at: new Date().toISOString() })
      .eq('id', String(req.body?.entitlement_id || '')).eq('user_id', uid).eq('status', 'available')
      .select('*').maybeSingle();
    if (!ent) return res.status(409).json({ success: false, error: 'Choose a package you have bought and not used yet' });
    const release = () => supabase.from('advertising_entitlements').update({ status: 'available' }).eq('id', ent.id).eq('status', 'used');
    const snapshot = ent.package_snapshot;
    const built = await buildFields(req.body || {}, uid, snapshot);
    if (built.error) { await release(); return res.status(400).json({ success: false, error: built.error }); }
    const { data: campaign, error } = await supabase.from('advertising_campaigns').insert({
      ...built.fields, owner_id: uid, kind: snapshot.kind, package_id: ent.package_id, entitlement_id: ent.id,
      placements: snapshot.placements, priority: snapshot.priority, status: 'draft',
    }).select('id').single();
    if (error) { await release(); throw error; }
    const mediaError = await setMedia(campaign.id, req.body?.media_ids || [], uid, snapshot);
    if (mediaError) {
      await supabase.from('advertising_campaigns').delete().eq('id', campaign.id);
      await release();
      return res.status(400).json({ success: false, error: mediaError });
    }
    res.status(201).json({ success: true, data: { id: campaign.id, status: 'draft' } });
  } catch (err) { fail(res, err); }
});

// The Add Content advert wizard: one call creates the campaign from the paid
// package, keeps the wizard's objective / audience / schedule / format with it,
// attaches the uploaded creatives and submits it for review.
// Internal ads (no link) lead to the advertiser's profile; external ads to
// their checked https link.
const CTA_TEXT = {
  learn_more: 'Learn more', shop_now: 'Shop now', sign_up: 'Sign up', book_now: 'Book now', get_offer: 'Get offer',
  watch_more: 'Watch more', contact_us: 'Contact us', play_game: 'Play', send_message: 'Send message',
  download: 'Download', install_now: 'Install', subscribe: 'Subscribe', apply_now: 'Apply now', get_quote: 'Get quote',
  order_now: 'Order now', buy_now: 'Buy now', listen_now: 'Listen now', see_menu: 'See menu',
};
router.post('/campaigns/from-wizard', authenticateToken, async (req, res) => {
  const uid = req.user.id;
  const payload = req.body?.payload || {};
  const ad = payload.ad || {};
  try {
    const { data: ent } = await supabase.from('advertising_entitlements')
      .update({ status: 'used', updated_at: new Date().toISOString() })
      .eq('id', String(req.body?.entitlement_id || '')).eq('user_id', uid).eq('status', 'available')
      .select('*').maybeSingle();
    if (!ent) return res.status(409).json({ success: false, error: 'Pay for a package first' });
    const release = () => supabase.from('advertising_entitlements').update({ status: 'available' }).eq('id', ent.id).eq('status', 'used');
    const snapshot = ent.package_snapshot;
    if (snapshot.kind !== 'ad') { await release(); return res.status(400).json({ success: false, error: 'Choose an ad package' }); }

    const link = clean(ad.destination_url, 2048);
    const built = await buildFields({
      title: ad.headline || payload.campaign?.name,
      body: [ad.primary_text, ad.description].filter(Boolean).join('\n').slice(0, 280),
      cta_label: CTA_TEXT[ad.cta_type] || (link ? 'Visit' : 'View'),
      destination_type: link ? 'external' : 'profile',
      destination_url: link || undefined,
    }, uid, snapshot);
    if (built.error) { await release(); return res.status(400).json({ success: false, error: built.error }); }

    const { data: campaign, error } = await supabase.from('advertising_campaigns').insert({
      ...built.fields, owner_id: uid, kind: 'ad', package_id: ent.package_id, entitlement_id: ent.id,
      placements: snapshot.placements, priority: snapshot.priority, status: 'draft',
      objective: clean(payload.campaign?.objective, 40) || null,
      // Media is referenced by advertising_campaign_media; signed preview URLs aren't kept.
      targeting: {
        ad_set: payload.ad_set || null, locations: payload.locations || [], campaign: payload.campaign || null,
        ad: { ...ad, media_url: undefined, carousel_cards: undefined },
      },
    }).select('id').single();
    if (error) { await release(); throw error; }

    const mediaError = await setMedia(campaign.id, req.body?.media_ids || [], uid, snapshot);
    if (mediaError) {
      await supabase.from('advertising_campaigns').delete().eq('id', campaign.id);
      await release();
      return res.status(400).json({ success: false, error: mediaError });
    }
    if (req.body?.save_as_draft) return res.status(201).json({ success: true, data: { id: campaign.id, status: 'draft' } });
    const { data: status, error: submitError } = await supabase.rpc('ads_submit_campaign', { p_campaign_id: campaign.id, p_owner_id: uid });
    if (submitError) {
      // Keep the draft (and the package claimed by it) so the user can fix and resubmit.
      const known = adError(submitError);
      return res.status(400).json({ success: false, error: known || 'Could not submit campaign', data: { id: campaign.id, status: 'draft' } });
    }
    res.status(201).json({ success: true, data: { id: campaign.id, status } });
  } catch (err) { fail(res, err); }
});

router.patch('/campaigns', authenticateToken, async (req, res) => {
  const uid = req.user.id;
  try {
    const campaign = must(await supabase.from('advertising_campaigns').select('*, advertising_entitlements(package_snapshot)')
      .eq('id', String(req.body?.id || '')).eq('owner_id', uid).maybeSingle());
    if (!campaign) return res.status(404).json({ success: false, error: 'Campaign not found' });
    if (['suspended', 'revoked'].includes(campaign.status)) return res.status(409).json({ success: false, error: 'This campaign can no longer be edited' });
    if (campaign.kind === 'boost' && campaign.status === 'active') return res.status(409).json({ success: false, error: 'A live boost cannot be changed' });
    if (campaignState(campaign) === 'completed') return res.status(409).json({ success: false, error: 'This campaign has finished' });
    const snapshot = campaign.advertising_entitlements.package_snapshot;
    const built = await buildFields(req.body || {}, uid, snapshot, campaign);
    if (built.error) return res.status(400).json({ success: false, error: built.error });
    const mediaError = await setMedia(campaign.id, req.body?.media_ids, uid, snapshot);
    if (mediaError) return res.status(400).json({ success: false, error: mediaError });
    // Only send real changes, so an unchanged save never pulls a live ad out of rotation.
    const changes = Object.fromEntries(Object.entries(built.fields).filter(([k, v]) =>
      k === 'destination_checked_at' || k === 'destination_final_url' || String(v ?? '') !== String(campaign[k] ?? '')));
    const { data: updated, error } = await supabase.from('advertising_campaigns')
      .update({ ...changes, updated_at: new Date().toISOString() }).eq('id', campaign.id).select('status').single();
    if (error) throw error;
    if (campaign.status === 'active' && updated.status === 'pending_review') {
      await supabase.from('advertising_moderation').insert({ campaign_id: campaign.id, action: 'edited_needs_review', actor: 'owner', actor_id: uid });
    }
    res.json({ success: true, data: { id: campaign.id, status: updated.status } });
  } catch (err) { fail(res, err); }
});

router.delete('/campaigns', authenticateToken, async (req, res) => {
  try {
    const c = must(await supabase.from('advertising_campaigns').select('id, status, entitlement_id')
      .eq('id', String(req.query.id || '')).eq('owner_id', req.user.id).maybeSingle());
    if (!c) return res.status(404).json({ success: false, error: 'Campaign not found' });
    if (!['draft', 'rejected'].includes(c.status)) return res.status(409).json({ success: false, error: 'Only drafts and rejected campaigns can be deleted' });
    must(await supabase.from('advertising_campaigns').delete().eq('id', c.id));
    await supabase.from('advertising_entitlements').update({ status: 'available', updated_at: new Date().toISOString() }).eq('id', c.entitlement_id).eq('status', 'used');
    res.json({ success: true });
  } catch (err) { fail(res, err); }
});

router.post('/campaigns/submit', authenticateToken, async (req, res) => {
  try {
    const { data, error } = await supabase.rpc('ads_submit_campaign', { p_campaign_id: String(req.body?.id || ''), p_owner_id: req.user.id });
    if (error) throw error;
    res.json({ success: true, data: { status: data, message: data === 'active' ? 'Your boost is live.' : 'Submitted. Book of Memes will review your ad before it goes live.' } });
  } catch (err) { fail(res, err, 'Could not submit campaign'); }
});

// Totals, daily series and placement breakdown from the real (de-duplicated) events.
router.get('/campaigns/analytics', authenticateToken, async (req, res) => {
  try {
    const c = must(await supabase.from('advertising_campaigns').select('id, starts_at, ends_at')
      .eq('id', String(req.query.id || '')).eq('owner_id', req.user.id).maybeSingle());
    if (!c) return res.status(404).json({ success: false, error: 'Campaign not found' });
    const range = ['7d', '30d', 'lifetime'].includes(req.query.range) ? req.query.range : '7d';
    let q = supabase.from('advertising_events').select('kind, placement, created_at').eq('campaign_id', c.id).order('created_at').limit(50000);
    if (range !== 'lifetime') q = q.gte('created_at', new Date(Date.now() - (range === '7d' ? 7 : 30) * 86400e3).toISOString());
    const events = must(await q);
    const daily = {}; const placements = {}; const totals = { impressions: 0, clicks: 0 };
    for (const e of events) {
      const day = String(e.created_at).slice(0, 10);
      const key = e.kind === 'click' ? 'clicks' : 'impressions';
      daily[day] = daily[day] || { impressions: 0, clicks: 0 };
      placements[e.placement || 'other'] = placements[e.placement || 'other'] || { impressions: 0, clicks: 0 };
      daily[day][key] += 1; placements[e.placement || 'other'][key] += 1; totals[key] += 1;
    }
    const ctr = (o) => (o.impressions ? o.clicks / o.impressions : null);
    res.json({
      success: true,
      data: {
        range, totals: { ...totals, ctr: ctr(totals) },
        daily: Object.entries(daily).map(([day, v]) => ({ day, ...v, ctr: ctr(v) })),
        placements: Object.entries(placements).map(([placement, v]) => ({ placement, ...v, ctr: ctr(v) })),
        starts_at: c.starts_at, ends_at: c.ends_at,
      },
    });
  } catch (err) { fail(res, err); }
});

// ── Media ──────────────────────────────────────────────────────────────────
router.post('/media/sign', authenticateToken, (req, res) => {
  const rt = req.body?.resource_type;
  if (!['image', 'video'].includes(rt)) return res.status(400).json({ success: false, error: 'resource_type must be image or video' });
  try { res.json({ success: true, data: signAdUpload(req.user.id, rt) }); } catch (err) {
    console.error('[ads] sign failed:', err.message);
    res.status(503).json({ success: false, error: 'Media uploads are not available right now' });
  }
});

router.get('/media', authenticateToken, async (req, res) => {
  try {
    const rows = must(await supabase.from('advertising_media').select('*').eq('owner_id', req.user.id).neq('status', 'removed').order('created_at', { ascending: false }));
    res.json({ success: true, data: rows.map(mediaView) });
  } catch (err) { fail(res, err); }
});

router.post('/media', authenticateToken, async (req, res) => {
  const uid = req.user.id;
  try {
    const rt = req.body?.resource_type;
    const publicId = clean(req.body?.public_id, 200);
    if (!['image', 'video'].includes(rt) || !publicId) return res.status(400).json({ success: false, error: 'public_id and resource_type are required' });
    const resource = await getAdResource(rt, publicId);
    const checked = validateAdResource(resource, adFolder(uid), rt);
    if (!checked.ok) {
      if (resource && String(resource.public_id).startsWith(`${adFolder(uid)}/`)) await destroyAdAsset(rt, resource.public_id).catch(() => {});
      return res.status(400).json({ success: false, error: checked.reason });
    }
    const { data } = await supabase.from('advertising_media')
      .upsert({ ...checked.media, owner_id: uid, delivery_type: 'authenticated', status: 'pending' }, { onConflict: 'cloudinary_public_id', ignoreDuplicates: true })
      .select('*').maybeSingle();
    const media = data || must(await supabase.from('advertising_media').select('*').eq('cloudinary_public_id', checked.media.cloudinary_public_id).single());
    if (!media || media.owner_id !== uid) return res.status(409).json({ success: false, error: 'Upload already registered' });
    res.status(201).json({ success: true, data: mediaView(media) });
  } catch (err) { fail(res, err, 'Upload could not be checked'); }
});

router.delete('/media', authenticateToken, async (req, res) => {
  const uid = req.user.id;
  try {
    const id = String(req.query.id || '');
    const media = must(await supabase.from('advertising_media').select('*').eq('id', id).eq('owner_id', uid).maybeSingle());
    if (!media || media.status === 'removed') return res.status(404).json({ success: false, error: 'Media not found' });
    const uses = must(await supabase.from('advertising_campaign_media').select('campaign_id, advertising_campaigns!inner(status)')
      .eq('media_id', id).in('advertising_campaigns.status', ['active', 'pending_review']));
    if (uses?.length) return res.status(409).json({ success: false, error: 'This media is used by a live or pending campaign' });
    await destroyAdAsset(media.resource_type, media.cloudinary_public_id, media.delivery_type).catch((e) => console.error('[ads] destroy failed:', e.message));
    must(await supabase.from('advertising_campaign_media').delete().eq('media_id', id));
    must(await supabase.from('advertising_media').update({ status: 'removed', removed_at: new Date().toISOString() }).eq('id', id));
    res.json({ success: true });
  } catch (err) { fail(res, err); }
});

// ── Serving + events ───────────────────────────────────────────────────────
function weightedPick(rows, count) {
  const pool = [...rows]; const picked = [];
  while (pool.length && picked.length < count) {
    const total = pool.reduce((s, r) => s + Math.max(1, r.priority), 0);
    let roll = Math.random() * total;
    const i = pool.findIndex((r) => (roll -= Math.max(1, r.priority)) < 0);
    picked.push(pool.splice(i === -1 ? 0 : i, 1)[0]);
  }
  return picked;
}

async function cappedCampaigns(req, ids) {
  if (!ids.length || !(String(req.headers['x-ad-viewer'] || '').length >= 16)) return new Set();
  const { data, error } = await supabase.from('advertising_events').select('campaign_id')
    .eq('viewer_key', viewerKey(req)).eq('kind', 'impression').in('campaign_id', ids)
    .gte('created_at', new Date(Date.now() - 86400e3).toISOString()).limit(1000);
  if (error) return new Set();
  const seen = new Map();
  for (const r of data || []) seen.set(r.campaign_id, (seen.get(r.campaign_id) || 0) + 1);
  return new Set([...seen].filter(([, n]) => n >= FREQUENCY_CAP_PER_DAY).map(([id]) => id));
}

function servedHouseAd(h) {
  const media = { resource_type: h.resource_type, format: h.format, cloudinary_public_id: h.cloudinary_public_id, delivery_type: 'upload' };
  return {
    id: h.id, house: true, title: h.title, body: h.body,
    cta_label: h.cta_label || (h.destination_type === 'external' ? 'Visit' : 'View'),
    destination: { type: h.destination_type, url: h.destination_type === 'external' ? h.destination_url : null, item_type: h.item_type, item_id: h.item_id, username: h.profile_username },
    media: [{ type: h.resource_type, url: adDeliveryUrl(media), poster: h.resource_type === 'video' ? adDeliveryUrl(media, { poster: true, width: 720 }) : null, width: h.width, height: h.height }],
  };
}

router.get('/serve', async (req, res) => {
  const placement = String(req.query.placement || '');
  if (!PLACEMENTS.has(placement)) return res.status(400).json({ success: false, error: 'Unknown placement' });
  const adLimit = Math.min(Math.max(parseInt(req.query.ads, 10) || 0, 0), 3);
  const boostLimit = Math.min(Math.max(parseInt(req.query.boosts, 10) || 0, 0), 4);
  const now = new Date().toISOString();
  try {
    const live = (kind) => supabase.from('advertising_campaigns')
      .select(kind === 'ad'
        ? 'id, title, body, cta_label, destination_type, destination_url, item_type, item_id, priority, owner_id, profiles:owner_id(username), advertising_campaign_media(position, advertising_media(id, resource_type, format, cloudinary_public_id, delivery_type, status, width, height))'
        : 'id, item_type, item_id, priority')
      .eq('kind', kind).eq('status', 'active').lte('starts_at', now).gt('ends_at', now).contains('placements', [placement]).limit(60);
    const [ads, boosts, house] = await Promise.all([
      adLimit ? live('ad') : { data: [] },
      boostLimit ? live('boost') : { data: [] },
      adLimit ? supabase.from('house_ads').select('*').eq('status', 'active').lte('starts_at', now).or(`ends_at.is.null,ends_at.gt.${now}`).contains('placements', [placement]).limit(40) : { data: [] },
    ]);
    if (ads.error) throw ads.error;
    if (boosts.error) throw boosts.error;
    const adRows = (ads.data || []).map((c) => ({
      ...c,
      media: (c.advertising_campaign_media || []).sort((a, b) => a.position - b.position).map((r) => r.advertising_media)
        .filter((m) => m && m.status === 'approved' && m.delivery_type === 'upload'),
    })).filter((c) => c.media.length);
    const capped = await cappedCampaigns(req, adRows.map((c) => c.id));
    const houseRows = house.error ? [] : (house.data || []);

    // Paid ads + 'rotate' house ads compete; 'fill' house ads take empty slots.
    const open = adRows.filter((c) => !capped.has(c.id));
    const picked = weightedPick(open.filter((c) => c.priority >= FEATURED_PRIORITY).map((c) => ({ priority: c.priority, paid: c })), Math.min(1, adLimit));
    const pool = [
      ...open.filter((c) => !picked.some((s) => s.paid === c)).map((c) => ({ priority: c.priority, paid: c })),
      ...houseRows.filter((h) => h.mode === 'rotate').map((h) => ({ priority: h.weight, house: h })),
    ];
    picked.push(...weightedPick(pool, adLimit - picked.length));
    if (picked.length < adLimit) picked.push(...weightedPick(houseRows.filter((h) => h.mode !== 'rotate').map((h) => ({ priority: h.weight, house: h })), adLimit - picked.length));
    if (picked.length < adLimit) picked.push(...weightedPick(adRows.filter((c) => capped.has(c.id)).map((c) => ({ priority: c.priority, paid: c })), adLimit - picked.length));

    // Boosted posts: only posts that still exist.
    const boosted = [];
    for (const b of weightedPick(boosts.data || [], boostLimit)) {
      const post = await loadPostMeta(b.item_type, b.item_id);
      if (post) boosted.push({ campaign_id: b.id, post });
    }

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      success: true,
      data: {
        placement,
        ads: picked.map((s) => (s.house ? servedHouseAd(s.house) : {
          id: s.paid.id, title: s.paid.title, body: s.paid.body,
          cta_label: s.paid.cta_label || (s.paid.destination_type === 'external' ? 'Visit' : 'View'),
          destination: {
            type: s.paid.destination_type, url: s.paid.destination_type === 'external' ? s.paid.destination_url : null,
            item_type: s.paid.item_type, item_id: s.paid.item_id, username: s.paid.profiles?.username || null, user_id: s.paid.owner_id,
          },
          media: s.paid.media.map((m) => ({ type: m.resource_type, url: adDeliveryUrl(m), poster: m.resource_type === 'video' ? adDeliveryUrl(m, { poster: true, width: 720 }) : null, width: m.width, height: m.height })),
        })),
        boosted,
      },
    });
  } catch (err) {
    console.error('[ads] serve failed:', err.message);
    res.json({ success: true, data: { placement, ads: [], boosted: [] } }); // never break the page
  }
});

router.post('/event', async (req, res) => {
  const id = String(req.body?.campaign_id || '');
  const kind = req.body?.kind;
  if (!/^[0-9a-f-]{36}$/i.test(id) || !['impression', 'click'].includes(kind)) return res.status(400).json({ success: false, error: 'campaign_id and kind are required' });
  const placement = typeof req.body?.placement === 'string' ? req.body.placement : null;
  try {
    const { data: house } = await supabase.from('house_ads').select('id').eq('id', id).maybeSingle();
    const { data } = house
      ? await supabase.rpc('house_ads_record_event', { p_house_ad_id: id, p_kind: kind, p_placement: placement, p_viewer_key: viewerKey(req) })
      : await supabase.rpc('ads_record_event', { p_campaign_id: id, p_kind: kind, p_placement: placement, p_viewer_key: viewerKey(req) });
    res.json({ success: true, data: { recorded: !!data } });
  } catch (err) {
    res.json({ success: true, data: { recorded: false } });
  }
});

// ── Admin ──────────────────────────────────────────────────────────────────
router.get('/admin/queue', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const status = ['pending_review', 'active', 'suspended', 'rejected'].includes(req.query.status) ? req.query.status : 'pending_review';
    const rows = must(await supabase.from('advertising_campaigns')
      .select('*, profiles:owner_id(full_name, username), advertising_campaign_media(position, advertising_media(*))')
      .eq('kind', 'ad').eq('status', status).order('submitted_at', { ascending: true }).limit(100));
    res.json({
      success: true,
      data: rows.map((c) => ({
        id: c.id, title: c.title, body: c.body, cta_label: c.cta_label, destination_type: c.destination_type,
        destination_url: c.destination_url, destination_final_url: c.destination_final_url, destination_checked_at: c.destination_checked_at,
        package_id: c.package_id, placements: c.placements, status: c.status, starts_at: c.starts_at, ends_at: c.ends_at,
        paused_at: c.paused_at, submitted_at: c.submitted_at, review_note: c.review_note, owner: c.profiles,
        media: (c.advertising_campaign_media || []).sort((a, b) => a.position - b.position).map((r) => r.advertising_media && mediaView(r.advertising_media)).filter(Boolean),
      })),
    });
  } catch (err) { fail(res, err); }
});

async function reviewMedia(adminId, id, action, note) {
  const media = must(await supabase.from('advertising_media').select('*').eq('id', id).maybeSingle());
  if (!media || media.status === 'removed') return { status: 404, error: 'Media not found' };
  if (action === 'approve') {
    if (media.status === 'approved') return { status: 200 };
    if (media.delivery_type === 'authenticated') await publishAdAsset(media.resource_type, media.cloudinary_public_id);
    must(await supabase.from('advertising_media').update({ status: 'approved', delivery_type: 'upload', reviewed_by: adminId, reviewed_at: new Date().toISOString(), reject_reason: null }).eq('id', id));
    await supabase.from('advertising_moderation').insert({ media_id: id, action: 'media_approved', actor: 'admin', actor_id: adminId, note });
    return { status: 200 };
  }
  if (action === 'reject') {
    if (!note) return { status: 400, error: 'Give the advertiser a reason' };
    if (media.status === 'rejected') return { status: 200 };
    // Private in Cloudinary first, so the database never claims a still-public asset was withdrawn.
    if (media.delivery_type === 'upload') await unpublishAdAsset(media.resource_type, media.cloudinary_public_id);
    must(await supabase.rpc('ads_reject_media', { p_media_id: id, p_admin_id: adminId, p_note: note }));
    return { status: 200 };
  }
  return { status: 400, error: 'Unknown action' };
}

router.post('/admin/review', authenticateToken, requireAdmin, async (req, res) => {
  const adminId = req.user.id;
  const { target, action } = req.body || {};
  const id = String(req.body?.id || '');
  const note = clean(req.body?.note, 1000) || null;
  try {
    if (target === 'media') {
      const r = await reviewMedia(adminId, id, action, note);
      return res.status(r.status).json(r.error ? { success: false, error: r.error } : { success: true });
    }
    if (target !== 'campaign') return res.status(400).json({ success: false, error: 'Unknown target' });
    if (action === 'recheck_link') {
      const c = must(await supabase.from('advertising_campaigns').select('destination_url').eq('id', id).maybeSingle());
      const checked = await checkDestination(c?.destination_url);
      if (!checked.ok) return res.status(400).json({ success: false, error: checked.reason });
      must(await supabase.from('advertising_campaigns').update({ destination_final_url: checked.finalUrl, destination_checked_at: new Date().toISOString() }).eq('id', id));
      return res.json({ success: true });
    }
    if (action === 'extend') {
      if (!note) return res.status(400).json({ success: false, error: 'Explain the compensation' });
      const { data, error } = await supabase.rpc('ads_extend_campaign', { p_campaign_id: id, p_admin_id: adminId, p_hours: parseInt(req.body?.hours, 10), p_note: note });
      if (error) throw error;
      return res.json({ success: true, data: { ends_at: data } });
    }
    if (['reject', 'suspend'].includes(action) && !note) return res.status(400).json({ success: false, error: 'Give the advertiser a reason' });
    if (action === 'approve' && req.body?.approve_media) {
      const rows = must(await supabase.from('advertising_campaign_media').select('media_id, advertising_media(status)').eq('campaign_id', id));
      for (const r of rows || []) {
        if (r.advertising_media?.status === 'pending') {
          const out = await reviewMedia(adminId, r.media_id, 'approve', note);
          if (out.error) return res.status(out.status).json({ success: false, error: out.error });
        }
      }
    }
    const { data, error } = await supabase.rpc('ads_review_campaign', { p_campaign_id: id, p_admin_id: adminId, p_action: action, p_note: note });
    if (error) throw error;
    const c = must(await supabase.from('advertising_campaigns').select('owner_id, title, ends_at').eq('id', id).single());
    const text = {
      approve: `Your ad "${c.title}" is approved and live until ${new Date(c.ends_at).toUTCString()}.`,
      reject: `Your ad "${c.title}" needs changes before it can go live: ${note}`,
      suspend: `Your ad "${c.title}" has been paused by Book of Memes: ${note}`,
      reinstate: `Your ad "${c.title}" has been reinstated.`,
    }[action];
    if (text && c.owner_id) {
      await supabase.from('notifications').insert({ user_id: c.owner_id, type: `ad_${action}`, title: 'Your ad', body: text, reference_id: id }).then(() => {}, () => {});
    }
    res.json({ success: true, data: { status: data } });
  } catch (err) { fail(res, err, 'Review failed'); }
});

// House ads: Book of Memes' own ads, published directly by admins.
router.post('/admin/house-ads/sign', authenticateToken, requireAdmin, (req, res) => {
  const rt = req.body?.resource_type;
  if (!['image', 'video'].includes(rt)) return res.status(400).json({ success: false, error: 'resource_type must be image or video' });
  try { res.json({ success: true, data: signHouseAdUpload(rt) }); } catch { res.status(503).json({ success: false, error: 'Uploads are not available right now' }); }
});

router.get('/admin/house-ads', authenticateToken, requireAdmin, async (_req, res) => {
  try {
    const rows = must(await supabase.from('house_ads').select('*').neq('status', 'archived').order('created_at', { ascending: false }).limit(100));
    res.json({ success: true, data: rows.map((h) => ({ ...h, preview: servedHouseAd(h).media[0] })) });
  } catch (err) { fail(res, err); }
});

router.post('/admin/house-ads', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const rt = b.resource_type;
    const resource = await getAdResource(rt, clean(b.public_id, 200), 'upload');
    const checked = validateAdResource(resource, HOUSE_FOLDER, rt, 'upload');
    if (!checked.ok) return res.status(400).json({ success: false, error: checked.reason });
    let destination = {};
    if (b.destination_type === 'external') {
      const link = await checkDestination(b.destination_url);
      if (!link.ok) return res.status(400).json({ success: false, error: link.reason });
      destination = { destination_url: link.url };
    } else if (b.destination_type === 'post') {
      if (!ITEM_TYPES.has(b.item_type) || !b.item_id) return res.status(400).json({ success: false, error: 'Choose a post' });
      destination = { item_type: b.item_type, item_id: b.item_id };
    } else if (b.destination_type === 'profile') {
      destination = { profile_username: clean(b.profile_username, 60) };
    } else return res.status(400).json({ success: false, error: 'Choose where the ad leads' });
    const placements = (Array.isArray(b.placements) ? b.placements : ['home', 'explore', 'feed', 'search']).filter((p) => PLACEMENTS.has(p));
    const row = must(await supabase.from('house_ads').insert({
      title: clean(b.title, 80), body: clean(b.body, 300) || null, cta_label: clean(b.cta_label, 24) || null,
      destination_type: b.destination_type, ...destination,
      resource_type: rt, format: checked.media.format, cloudinary_public_id: checked.media.cloudinary_public_id,
      bytes: checked.media.bytes, width: checked.media.width, height: checked.media.height,
      duration_seconds: checked.media.duration_seconds, version: checked.media.version,
      placements, mode: b.mode === 'rotate' ? 'rotate' : 'fill', weight: Math.min(Math.max(parseInt(b.weight, 10) || 10, 1), 100),
      ends_at: b.ends_at || null, created_by: req.user.id,
    }).select('*').single());
    res.status(201).json({ success: true, data: row });
  } catch (err) { fail(res, err); }
});

router.patch('/admin/house-ads', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const status = req.body?.status;
    if (!['active', 'paused', 'archived'].includes(status)) return res.status(400).json({ success: false, error: 'Unknown status' });
    must(await supabase.from('house_ads').update({ status, updated_at: new Date().toISOString() }).eq('id', String(req.body?.id || '')));
    res.json({ success: true });
  } catch (err) { fail(res, err); }
});

// Google Play refunds/chargebacks of ad packages end their campaigns
// (called from the billing voided-purchase sweep).
export async function revokeVoidedAdPurchase(purchaseToken) {
  const { data } = await supabase.rpc('ads_revoke_entitlement', {
    p_provider: 'google_play', p_provider_ref: purchaseToken, p_status: 'refunded', p_reason: 'Refunded by Google Play',
  });
  return data;
}

export default router;
