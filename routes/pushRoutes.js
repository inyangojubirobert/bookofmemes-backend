// Push and recommendations API (/api/push), migration 087.
//   POST  /register              this phone's FCM token (+ its UTC offset for quiet hours)
//   POST  /unregister            on sign-out
//   GET   /settings | PATCH /settings   push on/off, recommendations on/off, quiet hours
//   GET   /recommendations/next  the in-app "Recommended" card (≤3 a day, ≥3 h apart)
//   POST  /recommendations/action { ids, action: opened | dismissed | less }
import express from 'express';
import { supabase } from '../config/db.js';
import { authenticateToken } from '../auth.js';
import { nextRecommendation, logShown } from '../utils/recommendations.js';
import { pushConfigured } from '../utils/push.js';

const router = express.Router();
const fail = (res, status, error, extra = {}) => res.status(status).json({ success: false, error, ...extra });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CARDS_PER_DAY = 3;
const CARD_GAP_HOURS = 3;
const needs087 = (err) => /push_devices|notification_settings|recommendation_log|recommend_items|PGRST20[25]/i.test(err?.message || '');
const DEFAULTS = { push_enabled: true, recommendations_enabled: true, quiet_start: 22, quiet_end: 7 };

router.post('/register', authenticateToken, async (req, res) => {
  const token = String(req.body?.token || '').trim();
  if (token.length < 20 || token.length > 4096) return fail(res, 400, 'Invalid push token');
  const platform = req.body?.platform === 'ios' ? 'ios' : 'android';
  const now = new Date().toISOString();
  // One token belongs to one phone: if someone else signs in on it, it moves to them.
  const { error } = await supabase.from('push_devices').upsert({
    token, user_id: req.user.id, platform, app_version: String(req.body?.app_version || '').slice(0, 20) || null, enabled: true, last_seen_at: now,
  }, { onConflict: 'token' });
  if (error) return needs087(error) ? fail(res, 503, 'Push is not switched on yet (migration 087).') : fail(res, 500, 'Could not register this phone');
  const tz = Math.max(-720, Math.min(840, Math.round(Number(req.body?.tz_offset_minutes) || 0)));
  await supabase.from('notification_settings').upsert({ user_id: req.user.id, tz_offset_minutes: tz, updated_at: now }, { onConflict: 'user_id' });
  res.json({ success: true, data: { push_ready: pushConfigured() } });
});

router.post('/unregister', authenticateToken, async (req, res) => {
  const token = String(req.body?.token || '').trim();
  if (token) await supabase.from('push_devices').update({ enabled: false }).eq('token', token).eq('user_id', req.user.id);
  res.json({ success: true });
});

router.get('/settings', authenticateToken, async (req, res) => {
  const { data, error } = await supabase.from('notification_settings').select('*').eq('user_id', req.user.id).maybeSingle();
  if (error && needs087(error)) return fail(res, 503, 'Push is not switched on yet (migration 087).');
  res.json({ success: true, data: { ...DEFAULTS, ...(data || {}) } });
});

router.patch('/settings', authenticateToken, async (req, res) => {
  const b = req.body || {};
  const up = { user_id: req.user.id, updated_at: new Date().toISOString() };
  for (const k of ['push_enabled', 'recommendations_enabled']) if (typeof b[k] === 'boolean') up[k] = b[k];
  for (const k of ['quiet_start', 'quiet_end']) if (Number.isInteger(b[k]) && b[k] >= 0 && b[k] <= 23) up[k] = b[k];
  const { data, error } = await supabase.from('notification_settings').upsert(up, { onConflict: 'user_id' }).select().single();
  if (error) return needs087(error) ? fail(res, 503, 'Push is not switched on yet (migration 087).') : fail(res, 500, 'Could not save');
  res.json({ success: true, data: { ...DEFAULTS, ...data } });
});

// The in-app "Recommended" card. Quietly empty when there's nothing, or it was shown recently.
router.get('/recommendations/next', authenticateToken, async (req, res) => {
  try {
    const { data: s } = await supabase.from('notification_settings').select('recommendations_enabled').eq('user_id', req.user.id).maybeSingle();
    if (s?.recommendations_enabled === false) return res.json({ success: true, data: null });
    const { data: recent } = await supabase.from('recommendation_log').select('shown_at').eq('user_id', req.user.id).eq('channel', 'card')
      .gt('shown_at', new Date(Date.now() - 24 * 3600000).toISOString()).order('shown_at', { ascending: false }).limit(20);
    const cards = new Set((recent || []).map((r) => r.shown_at.slice(0, 19))).size; // one card logs several rows at once
    if (cards >= CARDS_PER_DAY) return res.json({ success: true, data: null });
    if (recent?.[0] && Date.now() - new Date(recent[0].shown_at).getTime() < CARD_GAP_HOURS * 3600000) return res.json({ success: true, data: null });
    const rec = await nextRecommendation(req.user.id);
    if (!rec) return res.json({ success: true, data: null });
    const ids = await logShown(req.user.id, rec, 'card');
    res.json({ success: true, data: { ...rec, log_ids: ids } });
  } catch (err) { console.error('[recs] next:', err.message); res.json({ success: true, data: null }); }
});

router.post('/recommendations/action', authenticateToken, async (req, res) => {
  const action = ['opened', 'dismissed', 'less'].includes(req.body?.action) ? req.body.action : null;
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).filter((x) => UUID.test(String(x))).slice(0, 10);
  if (!action || !ids.length) return fail(res, 400, 'Nothing to update');
  await supabase.from('recommendation_log').update({ action, acted_at: new Date().toISOString() }).in('id', ids).eq('user_id', req.user.id);
  res.json({ success: true });
});

export default router;
