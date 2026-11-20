// Brand network: ads for our own products, shown across all our apps
// (migration 078; docs/BRAND_NETWORK.md for the other apps).
//
// Public (any of our apps, no login):
//   GET  /api/brand/serve?app=onedream&placement=home&limit=1&platform=android
//        → our other products for that app (never its own), weighted at random
//   POST /api/brand/event { id, app, kind: 'impression' | 'click' }
//
// Manage (Book of Memes admins with their login, OR another app's server with
// its key in the X-Brand-Key header; keys are made by a Book of Memes admin):
//   GET   /api/brand/products            all products + last 30 days' views/taps
//   POST  /api/brand/products            add one
//   PATCH /api/brand/products/:id        edit / pause / archive
//   GET   /api/brand/partners            the apps and whether they have a key   (Book of Memes admins)
//   POST  /api/brand/partners/:app/key   make a new key for an app (shown once) (Book of Memes admins)
import express from 'express';
import crypto from 'crypto';
import { supabase } from '../config/db.js';
import { authenticateToken } from '../auth.js';

const router = express.Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HTTPS = /^https:\/\/[^\s]{4,500}$/;
const APP = /^[a-z0-9_]{2,40}$/;
const PLACEMENTS = ['home', 'explore', 'feed', 'search', 'content', 'games'];
const fail = (res, status, error) => res.status(status).json({ success: false, error });
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// ── Serving ─────────────────────────────────────────────────────────────────
export async function liveBrandProducts({ app, placement = null, limit = 20 }) {
  const now = new Date().toISOString();
  let q = supabase.from('brand_products').select('*').eq('status', 'active').lte('starts_at', now)
    .or(`ends_at.is.null,ends_at.gt.${now}`).contains('show_in', [app]).limit(limit);
  if (placement) q = q.contains('placements', [placement]);
  const { data, error } = await q;
  if (error) return [];
  return (data || []).filter((p) => p.product_app !== app);
}

export function servedBrand(p, platform = null) {
  const primary = platform === 'ios' ? p.ios_url || p.web_url || p.android_url
    : platform === 'android' ? p.android_url || p.web_url || p.ios_url
      : p.web_url || p.android_url || p.ios_url;
  return {
    id: p.id, brand: true, product_app: p.product_app, name: p.name, title: p.headline, body: p.body,
    cta_label: p.cta_label || (primary === p.android_url || primary === p.ios_url ? 'Download' : 'Visit'),
    links: { android: p.android_url, ios: p.ios_url, web: p.web_url },
    destination: { type: 'external', url: primary },
    media: [p.video_url
      ? { type: 'video', url: p.video_url, poster: p.image_url || cloudinaryPoster(p.video_url) }
      : { type: 'image', url: p.image_url, poster: null }],
  };
}
const cloudinaryPoster = (url) => (/res\.cloudinary\.com\/.+\/video\/upload\//.test(url)
  ? url.replace('/video/upload/', '/video/upload/so_1,w_720/').replace(/\.(mp4|mov|webm|m4v)(\?.*)?$/i, '.jpg') : null);

export function weightedPickBrand(rows, n) {
  const pool = [...rows];
  const out = [];
  while (out.length < n && pool.length) {
    const total = pool.reduce((s, r) => s + (r.weight || 1), 0);
    let x = Math.random() * total;
    const i = pool.findIndex((r) => (x -= (r.weight || 1)) <= 0);
    out.push(pool.splice(i < 0 ? 0 : i, 1)[0]);
  }
  return out;
}

router.get('/serve', async (req, res) => {
  const app = String(req.query.app || '');
  if (!APP.test(app)) return fail(res, 400, 'app is required (e.g. onedream)');
  const placement = PLACEMENTS.includes(req.query.placement) ? req.query.placement : null;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 1, 1), 5);
  const platform = ['android', 'ios', 'web'].includes(req.query.platform) ? req.query.platform : null;
  const rows = await liveBrandProducts({ app, placement });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true, data: weightedPickBrand(rows, limit).map((p) => servedBrand(p, platform)) });
});

router.post('/event', async (req, res) => {
  const id = String(req.body?.id || '');
  const app = String(req.body?.app || '');
  const kind = req.body?.kind;
  if (!UUID.test(id) || !APP.test(app) || !['impression', 'click'].includes(kind)) return fail(res, 400, 'id, app and kind are required');
  const { data } = await supabase.rpc('brand_record_event', { p_product_id: id, p_app: app, p_kind: kind });
  res.json({ success: true, data: { recorded: !!data } });
});

// ── Who may manage ──────────────────────────────────────────────────────────
async function isBomAdmin(userId) {
  const { data } = await supabase.rpc('is_app_admin', { p_user_id: userId });
  return !!data;
}

// X-Brand-Key (another app's server) or a Book of Memes admin's login.
async function requireManager(req, res, next) {
  const key = req.get('x-brand-key');
  if (key) {
    const { data } = await supabase.from('brand_partner_apps').select('app_key, can_manage, active').eq('api_key_hash', sha(key)).maybeSingle();
    if (!data?.active || !data.can_manage) return fail(res, 403, 'This key cannot manage brand ads');
    req.brandApp = data.app_key;
    return next();
  }
  return authenticateToken(req, res, async () => {
    if (!(await isBomAdmin(req.user.id))) return fail(res, 403, 'Admins only');
    req.brandApp = 'bookofmemes';
    next();
  });
}
function requireBomAdmin(req, res, next) {
  return authenticateToken(req, res, async () => {
    if (!(await isBomAdmin(req.user.id))) return fail(res, 403, 'Admins only');
    next();
  });
}

function cleanProduct(b, partial = false) {
  const out = {};
  const str = (k, max, required) => {
    if (b[k] === undefined) { if (required && !partial) throw new Error(`${k} is required`); return; }
    const v = b[k] === null ? null : String(b[k]).trim().slice(0, max);
    if (required && !v) throw new Error(`${k} is required`);
    out[k] = v || null;
  };
  const url = (k) => {
    if (b[k] === undefined) return;
    if (b[k] && !HTTPS.test(String(b[k]))) throw new Error(`${k} must be an https link`);
    out[k] = b[k] || null;
  };
  str('name', 80, true); str('headline', 120, true); str('body', 400); str('cta_label', 30);
  ['video_url', 'image_url', 'android_url', 'ios_url', 'web_url'].forEach(url);
  if (b.product_app !== undefined) out.product_app = b.product_app && APP.test(b.product_app) ? b.product_app : null;
  if (Array.isArray(b.show_in)) out.show_in = b.show_in.filter((a) => APP.test(a)).slice(0, 20);
  if (Array.isArray(b.placements)) out.placements = b.placements.filter((p) => PLACEMENTS.includes(p));
  if (b.mode !== undefined) { if (!['fill', 'rotate'].includes(b.mode)) throw new Error('mode is fill or rotate'); out.mode = b.mode; }
  if (b.weight !== undefined) out.weight = Math.min(Math.max(parseInt(b.weight, 10) || 10, 1), 100);
  if (b.status !== undefined) { if (!['active', 'paused', 'archived'].includes(b.status)) throw new Error('status is active, paused or archived'); out.status = b.status; }
  for (const k of ['starts_at', 'ends_at']) if (b[k] !== undefined) out[k] = b[k] ? new Date(b[k]).toISOString() : (k === 'ends_at' ? null : new Date().toISOString());
  return out;
}

router.get('/products', requireManager, async (_req, res) => {
  const { data, error } = await supabase.from('brand_products').select('*').neq('status', 'archived').order('created_at', { ascending: false }).limit(200);
  if (error) return fail(res, 500, 'Could not load products');
  const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const { data: stats } = await supabase.from('brand_ad_stats').select('product_id, shown_in, impressions, clicks').gte('day', since);
  const agg = {};
  for (const s of stats || []) {
    const a = (agg[s.product_id] ||= { impressions: 0, clicks: 0, by_app: {} });
    a.impressions += s.impressions; a.clicks += s.clicks;
    a.by_app[s.shown_in] = (a.by_app[s.shown_in] || 0) + s.impressions;
  }
  res.json({ success: true, data: (data || []).map((p) => ({ ...p, stats_30d: agg[p.id] || { impressions: 0, clicks: 0, by_app: {} } })) });
});

router.post('/products', requireManager, async (req, res) => {
  try {
    const row = cleanProduct(req.body || {});
    if (!row.video_url && !row.image_url) throw new Error('Add a video or a picture');
    if (!row.android_url && !row.ios_url && !row.web_url) throw new Error('Add a download or visit link');
    const { data, error } = await supabase.from('brand_products').insert({ ...row, created_by_app: req.brandApp, created_by_user: req.user?.id || null }).select().single();
    if (error) throw new Error(error.message);
    res.json({ success: true, data });
  } catch (err) { fail(res, 400, err.message); }
});

router.patch('/products/:id', requireManager, async (req, res) => {
  if (!UUID.test(req.params.id)) return fail(res, 404, 'Not found');
  try {
    const row = cleanProduct(req.body || {}, true);
    const { data, error } = await supabase.from('brand_products').update({ ...row, updated_at: new Date().toISOString() }).eq('id', req.params.id).select().single();
    if (error) throw new Error(error.message);
    res.json({ success: true, data });
  } catch (err) { fail(res, 400, err.message); }
});

router.get('/partners', requireBomAdmin, async (_req, res) => {
  const { data } = await supabase.from('brand_partner_apps').select('app_key, name, can_manage, active, api_key_hash').order('app_key');
  res.json({ success: true, data: (data || []).map(({ api_key_hash, ...p }) => ({ ...p, has_key: !!api_key_hash })) });
});

// A new key for one app (replaces the old one). Shown once: store it in that
// app's server environment as BRAND_NETWORK_KEY.
router.post('/partners/:app/key', requireBomAdmin, async (req, res) => {
  const app = String(req.params.app);
  if (!APP.test(app)) return fail(res, 400, 'Unknown app');
  const key = `bn_${app}_${crypto.randomBytes(24).toString('base64url')}`;
  const { data, error } = await supabase.from('brand_partner_apps')
    .upsert({ app_key: app, name: req.body?.name || app, api_key_hash: sha(key), can_manage: req.body?.can_manage !== false, active: true }, { onConflict: 'app_key' })
    .select('app_key').single();
  if (error || !data) return fail(res, 500, 'Could not make the key');
  res.json({ success: true, data: { app, key, note: 'Shown once. Put it in that app\'s server environment as BRAND_NETWORK_KEY.' } });
});

export default router;
