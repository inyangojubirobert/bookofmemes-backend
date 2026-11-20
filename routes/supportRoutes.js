// Admin inbox (migration 069). Users message the admins in the app; every
// message from the user side (including withdrawal requests and deposits the
// buyer says are paid, which the database posts itself) is forwarded to the
// admin's WhatsApp, and a daily reminder lists what is still unanswered.
//
//   User:  GET  /api/support/threads             my conversations
//          POST /api/support/threads             { subject?, body, image_url? } start one
//          GET  /api/support/threads/:id         messages (owner or admin)
//          POST /api/support/threads/:id/messages { body, image_url? }
//          GET  /api/support/unread              { user_unread, admin_open }
//   Admin: GET  /api/support/admin/threads?status=open|handled|all
//          POST /api/support/admin/threads/:id/status { status }
//          GET/POST /api/support/admin/alerts    WhatsApp settings
//          POST /api/support/admin/alerts/test   send a test message
//          POST /api/support/admin/alerts/retry  resend failed alerts
//   DB:    POST /api/support/kick                (x-kick-secret) send pending alerts now
import express from 'express';
import { supabase } from '../config/db.js';
import { authenticateToken } from '../auth.js';
import { sendWhatsApp, WHATSAPP_MAX_TEXT } from '../utils/whatsappAlert.js';

const router = express.Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMAGE_URL = /^https:\/\/res\.cloudinary\.com\/[^\s]+$/;
const USER_MESSAGES_PER_HOUR = 20;
const MAX_OPEN_QUESTIONS = 10;
const KIND_LABEL = { support: 'Message', withdrawal: 'Withdrawal', deposit: 'Deposit' };
const USER_COLS = 'id, username, full_name, avatar_url';

const userError = (msg, status = 400) => Object.assign(new Error(msg), { status });
const fail = (res, err) => {
  if (!err.status) console.error('[support]', err.message);
  res.status(err.status || 500).json({ success: false, error: err.status ? err.message : 'Something went wrong' });
};
const must = ({ data, error }) => { if (error) throw error; return data; };
const id = (v) => { const s = String(v || ''); if (!UUID.test(s)) throw userError('Invalid id'); return s; };

async function isAdmin(userId) {
  const { data, error } = await supabase.rpc('is_app_admin', { p_user_id: userId });
  if (error) throw error;
  return !!data;
}
async function requireAdmin(req, res, next) {
  try {
    if (!(await isAdmin(req.user.id))) return res.status(403).json({ success: false, error: 'Admins only' });
    next();
  } catch (err) { fail(res, err); }
}

function cleanBody(b) {
  const body = String(b?.body || '').trim();
  if (!body) throw userError('Write a message');
  if (body.length > 4000) throw userError('Message is too long (4,000 characters at most)');
  const image = b?.image_url ? String(b.image_url) : null;
  if (image && !IMAGE_URL.test(image)) throw userError('Invalid image');
  return { body, image_url: image };
}

async function checkRate(userId) {
  const since = new Date(Date.now() - 3600_000).toISOString();
  const { data: threads } = await supabase.from('support_threads').select('id').eq('user_id', userId);
  const ids = (threads || []).map((t) => t.id);
  if (!ids.length) return;
  const { count } = await supabase.from('support_messages').select('id', { count: 'exact', head: true })
    .in('thread_id', ids).eq('from_admin', false).eq('automatic', false).gte('created_at', since);
  if ((count || 0) >= USER_MESSAGES_PER_HOUR) throw userError('You have sent a lot of messages. Please wait a little before sending more.', 429);
}

async function profilesById(ids) {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return {};
  const rows = must(await supabase.from('profiles').select(USER_COLS).in('id', list));
  return Object.fromEntries(rows.map((p) => [p.id, p]));
}

// The withdrawal or deposit a conversation is about, for the admin's view.
async function refSummary(t) {
  if (!t.ref_id) return null;
  if (t.kind === 'withdrawal') {
    const { data } = await supabase.from('market_withdrawals').select('id, status, amount, currency, bucket').eq('id', t.ref_id).maybeSingle();
    return data;
  }
  if (t.kind === 'deposit') {
    const { data } = await supabase.from('market_payments').select('id, status, deposit_code, amount_due, pay_currency, credit_amount').eq('id', t.ref_id).maybeSingle();
    return data;
  }
  return null;
}

// ── User ────────────────────────────────────────────────────────────────────
router.get('/threads', authenticateToken, async (req, res) => {
  try {
    const rows = must(await supabase.from('support_threads')
      .select('id, kind, subject, status, last_message_at, last_from, user_unread, created_at')
      .eq('user_id', req.user.id).order('last_message_at', { ascending: false }).limit(100));
    res.json({ success: true, data: rows });
  } catch (err) { fail(res, err); }
});

router.post('/threads', authenticateToken, async (req, res) => {
  try {
    const msg = cleanBody(req.body);
    const subject = (String(req.body?.subject || '').trim() || msg.body.split('\n')[0]).slice(0, 120);
    await checkRate(req.user.id);
    const { count } = await supabase.from('support_threads').select('id', { count: 'exact', head: true })
      .eq('user_id', req.user.id).eq('kind', 'support').eq('status', 'open');
    if ((count || 0) >= MAX_OPEN_QUESTIONS) throw userError('You already have several conversations waiting for an answer. Add to one of those instead.', 429);
    const thread = must(await supabase.from('support_threads').insert({ user_id: req.user.id, kind: 'support', subject }).select('*').single());
    must(await supabase.from('support_messages').insert({ thread_id: thread.id, sender_id: req.user.id, from_admin: false, ...msg }));
    res.json({ success: true, data: thread });
  } catch (err) { fail(res, err); }
});

async function loadThreadFor(req) {
  const t = must(await supabase.from('support_threads').select('*').eq('id', id(req.params.id)).maybeSingle());
  if (!t) throw userError('Conversation not found', 404);
  const owner = t.user_id === req.user.id;
  const admin = owner ? await isAdmin(req.user.id).catch(() => false) : await isAdmin(req.user.id);
  if (!owner && !admin) throw userError('Conversation not found', 404);
  return { t, owner, admin };
}

router.get('/threads/:id', authenticateToken, async (req, res) => {
  try {
    const { t, owner, admin } = await loadThreadFor(req);
    const messages = must(await supabase.from('support_messages')
      .select('id, sender_id, from_admin, automatic, body, image_url, created_at' + (admin && !owner ? ', wa_status, wa_error, wa_note' : ''))
      .eq('thread_id', t.id).order('created_at', { ascending: true }).limit(500));
    if (owner && t.user_unread) await supabase.from('support_threads').update({ user_unread: 0 }).eq('id', t.id);
    const extra = admin && !owner ? { user: (await profilesById([t.user_id]))[t.user_id] || null, ref: await refSummary(t) } : {};
    // Users see "Book of Memes", never which admin answered.
    const shown = admin && !owner ? messages : messages.map((m) => (m.from_admin ? { ...m, sender_id: null } : m));
    res.json({ success: true, data: { thread: { ...t, user_unread: owner ? 0 : t.user_unread }, messages: shown, is_admin_view: admin && !owner, ...extra } });
  } catch (err) { fail(res, err); }
});

router.post('/threads/:id/messages', authenticateToken, async (req, res) => {
  try {
    const msg = cleanBody(req.body);
    const { t, owner } = await loadThreadFor(req);
    // An admin writing in their own conversation is writing as a user.
    const fromAdmin = !owner;
    if (!fromAdmin) await checkRate(req.user.id);
    const row = must(await supabase.from('support_messages')
      .insert({ thread_id: t.id, sender_id: req.user.id, from_admin: fromAdmin, ...msg })
      .select('id, from_admin, automatic, body, image_url, created_at').single());
    res.json({ success: true, data: row });
  } catch (err) { fail(res, err); }
});

router.get('/unread', authenticateToken, async (req, res) => {
  try {
    const mine = must(await supabase.from('support_threads').select('user_unread').eq('user_id', req.user.id).gt('user_unread', 0));
    const admin = await isAdmin(req.user.id).catch(() => false);
    let adminOpen = null;
    if (admin) {
      const { count } = await supabase.from('support_threads').select('id', { count: 'exact', head: true }).eq('status', 'open');
      adminOpen = count || 0;
    }
    res.json({ success: true, data: { user_unread: mine.reduce((s, r) => s + r.user_unread, 0), admin_open: adminOpen, is_admin: admin } });
  } catch (err) { fail(res, err); }
});

// ── Admin ───────────────────────────────────────────────────────────────────
router.get('/admin/threads', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const status = ['open', 'handled', 'all'].includes(req.query.status) ? req.query.status : 'open';
    let q = supabase.from('support_threads').select('*').order('last_message_at', { ascending: status === 'open' }).limit(200);
    if (status !== 'all') q = q.eq('status', status);
    const rows = must(await q);
    const users = await profilesById(rows.map((r) => r.user_id));
    // Last message of each, for the list preview.
    const ids = rows.map((r) => r.id);
    const last = {};
    if (ids.length) {
      const msgs = must(await supabase.from('support_messages').select('thread_id, body, from_admin, created_at')
        .in('thread_id', ids).order('created_at', { ascending: false }).limit(1000));
      for (const m of msgs) if (!last[m.thread_id]) last[m.thread_id] = m;
    }
    res.json({ success: true, data: rows.map((r) => ({ ...r, user: users[r.user_id] || null, last_message: last[r.id] || null })) });
  } catch (err) { fail(res, err); }
});

router.post('/admin/threads/:id/status', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const status = req.body?.status === 'open' ? 'open' : 'handled';
    const row = must(await supabase.from('support_threads').update(status === 'handled'
      ? { status, handled_at: new Date().toISOString(), handled_by: req.user.id }
      : { status, handled_at: null, handled_by: null }).eq('id', id(req.params.id)).select('*').single());
    res.json({ success: true, data: row });
  } catch (err) { fail(res, err); }
});

async function getConfig() {
  return must(await supabase.from('admin_alert_config').select('*').eq('id', true).maybeSingle());
}
const configView = async (c) => {
  const [p, f] = await Promise.all([
    supabase.from('support_messages').select('id', { count: 'exact', head: true }).eq('wa_status', 'pending'),
    supabase.from('support_messages').select('wa_error, created_at', { count: 'exact' }).eq('wa_status', 'failed').order('created_at', { ascending: false }).limit(1),
  ]);
  return {
    enabled: !!c?.enabled, whatsapp_number: c?.whatsapp_number || '', has_apikey: !!c?.callmebot_apikey,
    digest_hour: c?.digest_hour ?? 8, timezone: c?.timezone || 'Africa/Lagos', last_digest_on: c?.last_digest_on || null,
    pending: p.count || 0, failed: f.count || 0, last_error: f.data?.[0]?.wa_error || null,
  };
};

router.get('/admin/alerts', authenticateToken, requireAdmin, async (_req, res) => {
  try { res.json({ success: true, data: await configView(await getConfig()) }); } catch (err) { fail(res, err); }
});

router.post('/admin/alerts', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const patch = { updated_at: new Date().toISOString() };
    if (b.whatsapp_number !== undefined) {
      const n = String(b.whatsapp_number || '').replace(/[\s()-]/g, '');
      if (n && !/^\+[1-9][0-9]{7,14}$/.test(n)) throw userError('Use international format, e.g. +2348012345678');
      patch.whatsapp_number = n || null;
    }
    if (b.callmebot_apikey) patch.callmebot_apikey = String(b.callmebot_apikey).trim().slice(0, 100);
    if (b.digest_hour !== undefined) {
      const h = Number(b.digest_hour);
      if (!Number.isInteger(h) || h < 0 || h > 23) throw userError('Reminder hour must be 0 to 23');
      patch.digest_hour = h;
    }
    if (b.enabled !== undefined) patch.enabled = !!b.enabled;
    const c = must(await supabase.from('admin_alert_config').update(patch).eq('id', true).select('*').single());
    if (c.enabled && (!c.whatsapp_number || !c.callmebot_apikey)) {
      await supabase.from('admin_alert_config').update({ enabled: false }).eq('id', true);
      throw userError('Add the WhatsApp number and CallMeBot key before turning alerts on');
    }
    res.json({ success: true, data: await configView(c) });
  } catch (err) { fail(res, err); }
});

router.post('/admin/alerts/test', authenticateToken, requireAdmin, async (_req, res) => {
  try {
    const c = await getConfig();
    const r = await sendWhatsApp({ number: c?.whatsapp_number, apikey: c?.callmebot_apikey },
      '✅ Book of Memes: WhatsApp alerts are working. New messages for the admin will arrive here.');
    if (!r.ok) throw userError(r.error);
    res.json({ success: true, data: { sent: true } });
  } catch (err) { fail(res, err); }
});

router.post('/admin/alerts/retry', authenticateToken, requireAdmin, async (_req, res) => {
  try {
    must(await supabase.from('support_messages').update({ wa_status: 'pending', wa_attempts: 0, wa_next_try_at: null, wa_error: null }).eq('wa_status', 'failed'));
    runSupportSweep().catch(() => {});
    res.json({ success: true, data: { queued: true } });
  } catch (err) { fail(res, err); }
});

// ── Sending ─────────────────────────────────────────────────────────────────
router.post('/kick', async (req, res) => {
  try {
    const c = await getConfig();
    if (!c?.kick_secret || req.get('x-kick-secret') !== c.kick_secret) return res.status(403).json({ success: false });
    res.json({ success: true });
    runSupportSweep().catch((e) => console.error('[support] kick sweep', e.message));
  } catch (err) { fail(res, err); }
});

const MAX_ATTEMPTS = 8;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const who = (u) => (u ? `@${u.username || '?'}${u.full_name ? ` (${u.full_name})` : ''}` : 'a user');
const ago = (iso) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 60 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`;
};

function localNow(tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

async function sendPending(c) {
  const now = new Date().toISOString();
  const rows = must(await supabase.from('support_messages')
    .select('id, thread_id, body, image_url, automatic, from_admin, wa_note, created_at, wa_attempts')
    .eq('wa_status', 'pending').or(`wa_next_try_at.is.null,wa_next_try_at.lte.${now}`)
    .order('created_at', { ascending: true }).limit(30));
  if (!rows.length) return;
  const threads = must(await supabase.from('support_threads').select('id, kind, subject, user_id').in('id', [...new Set(rows.map((r) => r.thread_id))]));
  const tById = Object.fromEntries(threads.map((t) => [t.id, t]));
  const users = await profilesById(threads.map((t) => t.user_id));

  // Several messages go out together, so a burst doesn't hit CallMeBot's limits.
  const footer = '\n\nAnswer in the app: Profile → Admin inbox';
  const batches = [];
  let cur = { text: '', ids: [] };
  for (const m of rows) {
    const t = tById[m.thread_id] || {};
    // System messages from the admin side that need you (e.g. a Paystack
    // payout that has to be paid by hand) lead with their admin-only note.
    const block = (m.from_admin ? [
      `⚠️ ${KIND_LABEL[t.kind] || 'Message'} for ${who(users[t.user_id])} needs you`,
      t.subject,
      m.wa_note || m.body,
    ] : [
      `📩 ${KIND_LABEL[t.kind] || 'Message'} from ${who(users[t.user_id])}`,
      t.kind === 'support' ? `“${t.subject}”` : null,
      m.body.length > 600 ? `${m.body.slice(0, 600)}…` : m.body,
      m.wa_note,
      m.image_url ? `📎 ${m.image_url}` : null,
    ]).filter(Boolean).join('\n');
    if (cur.ids.length && cur.text.length + block.length + footer.length + 2 > WHATSAPP_MAX_TEXT) { batches.push(cur); cur = { text: '', ids: [] }; }
    cur.text += (cur.text ? '\n\n' : '') + block;
    cur.ids.push(m.id);
  }
  if (cur.ids.length) batches.push(cur);

  for (let i = 0; i < batches.length; i += 1) {
    const b = batches[i];
    if (i) await sleep(4000);
    const r = await sendWhatsApp({ number: c.whatsapp_number, apikey: c.callmebot_apikey }, (b.text + footer).slice(0, WHATSAPP_MAX_TEXT));
    if (r.ok) {
      await supabase.from('support_messages').update({ wa_status: 'sent', wa_sent_at: new Date().toISOString(), wa_error: null }).in('id', b.ids);
    } else {
      console.error('[support] WhatsApp send failed:', r.error);
      for (const mid of b.ids) {
        const attempts = (rows.find((x) => x.id === mid)?.wa_attempts || 0) + 1;
        await supabase.from('support_messages').update({
          wa_attempts: attempts, wa_error: r.error.slice(0, 300),
          wa_status: attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
          wa_next_try_at: new Date(Date.now() + Math.min(2 ** attempts, 60) * 60_000).toISOString(),
        }).eq('id', mid);
      }
      break; // try the rest on the next sweep
    }
  }
}

// Once a day: what is still waiting for an answer.
async function sendDigest(c) {
  const { date, hour } = localNow(c.timezone || 'Africa/Lagos');
  if (hour < c.digest_hour || c.last_digest_on === date) return;
  const open = must(await supabase.from('support_threads').select('id, kind, subject, user_id, last_message_at')
    .eq('status', 'open').order('last_message_at', { ascending: true }).limit(200));
  if (open.length) {
    const users = await profilesById(open.slice(0, 10).map((t) => t.user_id));
    const lines = open.slice(0, 10).map((t) => `• ${KIND_LABEL[t.kind]}: ${t.subject} (${who(users[t.user_id])}, waiting ${ago(t.last_message_at)})`);
    const text = `⏰ Book of Memes: ${open.length} conversation${open.length === 1 ? '' : 's'} still waiting for you.\n\n${lines.join('\n')}`
      + (open.length > 10 ? `\n…and ${open.length - 10} more.` : '') + '\n\nProfile → Admin inbox';
    const r = await sendWhatsApp({ number: c.whatsapp_number, apikey: c.callmebot_apikey }, text);
    if (!r.ok) { console.error('[support] digest failed:', r.error); return; } // try again next sweep
  }
  await supabase.from('admin_alert_config').update({ last_digest_on: date }).eq('id', true);
}

let sweeping = false;
export async function runSupportSweep() {
  if (sweeping) return;
  sweeping = true;
  try {
    const c = await getConfig();
    if (!c?.enabled || !c.whatsapp_number || !c.callmebot_apikey) return;
    await sendPending(c);
    await sendDigest(c);
  } finally { sweeping = false; }
}

export function startSupportAlertTimer() {
  const run = () => runSupportSweep().catch((e) => console.error('[support] sweep failed:', e.message));
  setTimeout(run, 15_000);
  setInterval(run, 60_000);
}

export default router;
