// Reporting and moderation (migration 091; Google Play's User Generated Content policy).
//
//   User:  POST /api/moderation/report   { target: 'content'|'comment'|'user', item_type?, item_id?,
//                                          comment_id?, user_id?, reason, details? }
//   Admin: GET  /api/moderation/admin/reports?status=open|closed
//          POST /api/moderation/admin/reports/:id/action { action: 'remove'|'dismiss'|'suspend', note? }
//          POST /api/moderation/admin/users/:id/unsuspend
//
// Every new report alerts the admins (Telegram or WhatsApp, the admin inbox's channel). Blocking
// is done by the app in blocked_users (its own row-level rules), so it isn't here.
import express from 'express';
import { supabase } from '../config/db.js';
import { authenticateToken } from '../auth.js';
import { notifyAdmins } from './supportRoutes.js';

const router = express.Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASONS = { spam: 'Spam or scam', nudity: 'Nudity or sexual content', hate: 'Hate or harassment', violence: 'Violence or dangerous acts', copyright: 'Copyright (my work)', other: 'Something else' };
// Item types → their table, and the fields that describe a post in a report.
const ITEM_TABLES = {
  stories: 'stories', memes: 'memes', puzzles: 'puzzles', kids_collections: 'kids_collections',
  music_box: 'music_box', podcast_box: 'podcast_box', tv_box: 'tv_box', books_library: 'books_library',
};
const REPORTS_PER_DAY = 30;
const SUSPEND_HOURS = 24 * 365 * 100; // until an admin lifts it

const fail = (res, status, error) => res.status(status).json({ success: false, error });
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] != null).map((k) => [k, o[k]]));

async function isAdmin(userId) {
  const { data } = await supabase.rpc('is_app_admin', { p_user_id: userId });
  return !!data;
}
async function requireAdmin(req, res, next) {
  if (!(await isAdmin(req.user.id).catch(() => false))) return fail(res, 403, 'Admins only');
  next();
}

async function loadItem(itemType, itemId) {
  const table = ITEM_TABLES[itemType];
  if (!table || !UUID.test(String(itemId || ''))) return null;
  const { data } = await supabase.from(table).select('*').eq('id', itemId).maybeSingle();
  return data || null;
}
const itemSnapshot = (it) => pick(it, ['title', 'description', 'story_synopsis', 'cover_image_url', 'thumbnail_url', 'image_url', 'author_id', 'author_name']);

// ── Report ───────────────────────────────────────────────────────────────────
router.post('/report', authenticateToken, async (req, res) => {
  const me = req.user.id;
  const b = req.body || {};
  const target = String(b.target || '');
  const reason = String(b.reason || '');
  if (!['content', 'comment', 'user'].includes(target)) return fail(res, 400, 'Choose what you are reporting');
  if (!REASONS[reason]) return fail(res, 400, 'Choose a reason');
  const details = b.details ? String(b.details).trim().slice(0, 1000) : null;

  const since = new Date(Date.now() - 86400_000).toISOString();
  const { count } = await supabase.from('content_reports').select('id', { count: 'exact', head: true }).eq('reporter_id', me).gte('created_at', since);
  if ((count || 0) >= REPORTS_PER_DAY) return fail(res, 429, 'You have sent a lot of reports today. Thank you: we will look at them.');

  const row = { reporter_id: me, target, reason, details };
  let label = '';
  if (target === 'content') {
    const it = await loadItem(b.item_type, b.item_id);
    if (!it) return fail(res, 404, 'That post was not found');
    Object.assign(row, { item_type: b.item_type, item_id: it.id, target_user_id: it.author_id || null, snapshot: itemSnapshot(it) });
    label = `post "${it.title || 'Untitled'}" (${b.item_type})`;
  } else if (target === 'comment') {
    if (!UUID.test(String(b.comment_id || ''))) return fail(res, 400, 'Missing comment');
    const { data: c } = await supabase.from('comments').select('*').eq('id', b.comment_id).maybeSingle();
    if (!c) return fail(res, 404, 'That comment was not found');
    Object.assign(row, { item_type: c.item_type || null, item_id: UUID.test(String(c.item_id || '')) ? c.item_id : null, comment_id: c.id, target_user_id: c.user_id || c.author_id || null, snapshot: { content: String(c.content || '').slice(0, 1000) } });
    label = `comment "${String(c.content || '').slice(0, 80)}"`;
  } else {
    if (!UUID.test(String(b.user_id || ''))) return fail(res, 400, 'Missing account');
    const { data: p } = await supabase.from('profiles').select('id, username, full_name, avatar_url, bio').eq('id', b.user_id).maybeSingle();
    if (!p) return fail(res, 404, 'That account was not found');
    Object.assign(row, { target_user_id: p.id, snapshot: pick(p, ['username', 'full_name', 'avatar_url', 'bio']) });
    label = `account @${p.username || p.full_name || p.id.slice(0, 8)}`;
  }
  if (row.target_user_id === me) return fail(res, 400, 'You cannot report yourself');

  const { error } = await supabase.from('content_reports').insert(row);
  if (error?.code === '23505') return res.json({ success: true, data: { already: true } }); // already reported, still open
  if (error) {
    console.error('[moderation] report failed:', error.message);
    return fail(res, /content_reports|PGRST205/.test(error.message) ? 503 : 500, 'Could not send the report. Please try again.');
  }
  notifyAdmins(`🚩 New report: ${REASONS[reason]}\n${label}${details ? `\n"${details.slice(0, 200)}"` : ''}\nOpen Profile → Reports in the app.`);
  res.json({ success: true, data: { reported: true } });
});

// ── Admin: the queue ─────────────────────────────────────────────────────────
router.get('/admin/reports', authenticateToken, requireAdmin, async (req, res) => {
  const closed = req.query.status === 'closed';
  let q = supabase.from('content_reports').select('*').order('created_at', { ascending: false }).limit(100);
  q = closed ? q.neq('status', 'open') : q.eq('status', 'open');
  const { data, error } = await q;
  if (error) return fail(res, /content_reports|PGRST205/.test(error.message) ? 503 : 500, 'Could not load reports (has migration 091 been run?)');
  const ids = [...new Set((data || []).flatMap((r) => [r.reporter_id, r.target_user_id]).filter(Boolean))];
  const { data: people } = ids.length ? await supabase.from('profiles').select('id, username, full_name, avatar_url, suspended_at').in('id', ids) : { data: [] };
  const byId = Object.fromEntries((people || []).map((p) => [p.id, p]));
  // How many open reports each thing has (so repeated reports stand out).
  const key = (r) => `${r.target}:${r.item_id || ''}:${r.comment_id || ''}:${r.target === 'user' ? r.target_user_id : ''}`;
  const counts = {};
  for (const r of data || []) if (r.status === 'open') counts[key(r)] = (counts[key(r)] || 0) + 1;
  res.json({ success: true, data: {
    reasons: REASONS,
    reports: (data || []).map((r) => ({ ...r, reason_label: REASONS[r.reason], reporter: byId[r.reporter_id] || null, target_user: byId[r.target_user_id] || null, open_count: counts[key(r)] || 0 })),
  } });
});

// Removes a post: deleted when nothing depends on it, otherwise unpublished (hidden from everyone).
async function removeItem(itemType, itemId) {
  const table = ITEM_TABLES[itemType];
  if (!table || !itemId) return 'missing';
  const del = await supabase.from(table).delete().eq('id', itemId);
  if (!del.error) return 'deleted';
  const hide = await supabase.from(table).update({ is_published: false }).eq('id', itemId);
  if (!hide.error) return 'unpublished';
  throw new Error(`could not remove ${itemType} ${itemId}: ${del.error.message}`);
}

router.post('/admin/reports/:id/action', authenticateToken, requireAdmin, async (req, res) => {
  if (!UUID.test(req.params.id)) return fail(res, 400, 'Invalid report');
  const action = String(req.body?.action || '');
  const note = req.body?.note ? String(req.body.note).slice(0, 500) : null;
  if (!['remove', 'dismiss', 'suspend'].includes(action)) return fail(res, 400, 'Choose remove, dismiss or suspend');
  const { data: r } = await supabase.from('content_reports').select('*').eq('id', req.params.id).maybeSingle();
  if (!r) return fail(res, 404, 'Report not found');
  try {
    let result = null;
    if (action === 'remove') {
      if (r.target === 'comment') {
        const { error } = await supabase.from('comments').delete().eq('id', r.comment_id);
        if (error) throw error;
        result = 'comment deleted';
      } else if (r.target === 'content') {
        result = `post ${await removeItem(r.item_type, r.item_id)}`;
      } else return fail(res, 400, 'A person cannot be removed: suspend the account instead');
    }
    if (action === 'suspend') {
      if (!r.target_user_id) return fail(res, 400, 'No account to suspend');
      if (await isAdmin(r.target_user_id)) return fail(res, 400, 'Admins cannot be suspended here');
      const { error } = await supabase.auth.admin.updateUserById(r.target_user_id, { ban_duration: `${SUSPEND_HOURS}h` });
      if (error) throw error;
      await supabase.from('profiles').update({ suspended_at: new Date().toISOString(), suspended_reason: note || r.reason }).eq('id', r.target_user_id);
      result = 'account suspended';
    }
    // Close this report and every other open report about the same thing (or person, when suspended).
    const status = action === 'remove' ? 'removed' : action === 'suspend' ? 'suspended' : 'dismissed';
    let q = supabase.from('content_reports').update({ status, resolved_by: req.user.id, resolved_at: new Date().toISOString(), resolution_note: note }).eq('status', 'open');
    if (action === 'suspend') q = q.eq('target_user_id', r.target_user_id);
    else if (r.target === 'comment') q = q.eq('comment_id', r.comment_id);
    else if (r.target === 'content') q = q.eq('target', 'content').eq('item_id', r.item_id);
    else q = q.eq('id', r.id);
    await q;
    res.json({ success: true, data: { status, result } });
  } catch (err) {
    console.error('[moderation] action failed:', err.message);
    fail(res, 500, 'Could not do that. Please try again.');
  }
});

router.post('/admin/users/:id/unsuspend', authenticateToken, requireAdmin, async (req, res) => {
  if (!UUID.test(req.params.id)) return fail(res, 400, 'Invalid account');
  const { error } = await supabase.auth.admin.updateUserById(req.params.id, { ban_duration: 'none' });
  if (error) return fail(res, 500, 'Could not lift the suspension');
  await supabase.from('profiles').update({ suspended_at: null, suspended_reason: null }).eq('id', req.params.id);
  res.json({ success: true, data: { unsuspended: true } });
});

export default router;
