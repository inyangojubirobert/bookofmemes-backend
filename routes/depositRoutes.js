// International deposits by wallet payment link, confirmed by a deposit agent
// (migration 060). Mounted at /api/market/deposits. The money rules live in
// the database functions; these routes only check who is calling.
//
// Buyer:  GET  /options          packages by currency, with the USD each credits
//         GET  /                 my link deposits
//         GET  /plan             ?currency=&target_usd= -> packages that together cover it
//         POST /start            { link_id, amount? } -> deposit with code, link and agent
// Public: GET  /listing-activity ?id= -> what anyone may see about a listing
//         POST /submit           { id, payer_name, tx_ref }
//         POST /cancel           { id }
// Agent:  GET  /agent            deposits waiting for me (?status=submitted|paid|failed)
//         POST /agent/review     { id, confirm, amount_received, note }
// Admin:  GET /admin/tiers (ladder with each tier's link), GET/POST/PATCH /admin/links,
//         GET/POST /admin/agents
import express from 'express';
import { supabase } from '../config/db.js';
import { authenticateToken } from '../auth.js';
import { DEPOSIT_TIERS, DEPOSIT_CURRENCIES, planDeposits } from '../config/depositTiers.js';

const router = express.Router();
const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function fail(res, err, fallback = 'Something went wrong') {
  const expected = err?.code === 'P0001' || err?.expected;
  if (!expected) console.error('[deposits]', err?.message || err);
  return res.status(expected ? 400 : 500).json({ success: false, error: expected ? err.message : fallback });
}
const userError = (message) => Object.assign(new Error(message), { expected: true });
async function rpc(name, args) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  return data;
}
const must = ({ data, error }) => { if (error) throw error; return data; };
async function quote(currency, amount) {
  try { return await rpc('market_link_deposit_quote', { p_currency: currency, p_amount: amount }); } catch { return null; }
}
const money2 = (n) => Math.round(Number(n) * 100) / 100;
const id = (v) => { const s = String(v || ''); if (!UUID.test(s)) throw userError('Invalid id'); return s; };

async function agentsById(ids) {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return {};
  const rows = must(await supabase.from('market_deposit_agents').select('user_id, display_name, whatsapp').in('user_id', list));
  return Object.fromEntries(rows.map((a) => [a.user_id, { name: a.display_name, whatsapp: a.whatsapp }]));
}

function depositView(p, link, agent) {
  return {
    id: p.id, code: p.deposit_code, status: p.status, provider: p.deposit_provider,
    pay_currency: p.pay_currency, pay_amount: Number(p.amount_due), credit_currency: p.credit_currency, credit_amount: Number(p.credit_amount),
    fee_usd: p.deposit_fee === null || p.deposit_fee === undefined ? null : Number(p.deposit_fee),
    spread_usd: p.deposit_spread === null || p.deposit_spread === undefined ? null : Number(p.deposit_spread),
    url: link?.url || null, instructions: link?.instructions || null,
    agent: agent || null, payer_name: p.payer_name, tx_ref: p.payer_tx_ref,
    note: p.review_note || p.provider_data?.note || (p.status === 'failed' ? p.provider_data?.reason : null) || null,
    created_at: p.created_at, submitted_at: p.submitted_at, paid_at: p.paid_at, expires_at: p.expires_at,
  };
}

// ── Buyer ───────────────────────────────────────────────────────────────────
router.get('/options', authenticateToken, async (_req, res) => {
  try {
    const [links, s, agents] = await Promise.all([
      supabase.from('market_deposit_links').select('id, provider, pay_currency, pay_amount, min_amount, max_amount, instructions, sort_order').eq('is_active', true).order('sort_order').order('pay_amount'),
      supabase.from('market_settings').select('link_deposit_spread_pct, link_deposit_daily_cap_usd, link_deposit_fee_pct, link_deposit_fee_min_usd, link_deposit_max_package_usd, link_deposit_large_usd').eq('id', true).single(),
      supabase.from('market_deposit_agents').select('user_id', { count: 'exact', head: true }).eq('is_active', true),
    ]);
    const settings = must(s);
    const all = must(links);
    const open = all.filter((l) => l.pay_amount === null).map((l) => ({
      id: l.id, provider: l.provider, pay_currency: l.pay_currency, open: true,
      min_amount: Number(l.min_amount), max_amount: Number(l.max_amount), instructions: l.instructions,
    }));
    const packages = await Promise.all(all.filter((l) => l.pay_amount !== null).map(async (l) => {
      const q = await quote(l.pay_currency, Number(l.pay_amount));
      return {
        id: l.id, provider: l.provider, pay_currency: l.pay_currency, pay_amount: Number(l.pay_amount), instructions: l.instructions,
        gross_usd: q ? money2(q.gross_usd) : null,
        spread_usd: q ? money2(q.spread_usd) : null,
        fee_usd: q ? money2(q.fee_usd) : null,
        credit_usd: q ? money2(q.credit_usd) : null,
        available: !!q && !q.over_ceiling,
      };
    }));
    res.json({
      success: true,
      data: {
        currencies: DEPOSIT_CURRENCIES.filter((c) => packages.some((p) => p.pay_currency === c) || open.some((o) => o.pay_currency === c)),
        packages, open_links: open, large_usd: Number(settings.link_deposit_large_usd), spread_pct: Number(settings.link_deposit_spread_pct), daily_cap_usd: Number(settings.link_deposit_daily_cap_usd),
        fee_pct: Number(settings.link_deposit_fee_pct), fee_min_usd: Number(settings.link_deposit_fee_min_usd),
        max_package_usd: Number(settings.link_deposit_max_package_usd),
        agents_available: (agents.count || 0) > 0,
      },
    });
  } catch (err) { fail(res, err); }
});

router.get('/', authenticateToken, async (req, res) => {
  try {
    const rows = must(await supabase.from('market_payments').select('*').eq('user_id', req.user.id).eq('method', 'wallet_link')
      .order('created_at', { ascending: false }).limit(30));
    const [agents, links] = await Promise.all([
      agentsById(rows.map((r) => r.agent_id)),
      rows.length ? supabase.from('market_deposit_links').select('id, url, instructions').in('id', [...new Set(rows.map((r) => r.deposit_link_id).filter(Boolean))]) : { data: [] },
    ]);
    const linkBy = Object.fromEntries((links.data || []).map((l) => [l.id, l]));
    res.json({ success: true, data: rows.map((p) => depositView(p, linkBy[p.deposit_link_id], agents[p.agent_id])) });
  } catch (err) { fail(res, err); }
});

// Packages (and/or an open-amount link) that together add at least
// target_usd to the buyer's funds, in the chosen currency.
router.get('/plan', authenticateToken, async (req, res) => {
  try {
    const currency = String(req.query.currency || 'USD').toUpperCase();
    const target = Math.round(Number(req.query.target_usd) * 100) / 100;
    if (!DEPOSIT_CURRENCIES.includes(currency)) throw userError('Unsupported currency');
    if (!(target > 0)) throw userError('Enter how much you need');
    const [links, s] = await Promise.all([
      supabase.from('market_deposit_links').select('*').eq('is_active', true).eq('pay_currency', currency),
      supabase.from('market_settings').select('link_deposit_spread_pct, link_deposit_fee_pct, link_deposit_fee_min_usd, link_deposit_daily_cap_usd').eq('id', true).single(),
    ]);
    const settings = must(s);
    const rows = must(links);
    const fixed = (await Promise.all(rows.filter((l) => l.pay_amount !== null).map(async (l) => {
      const q = await quote(currency, Number(l.pay_amount));
      return q && !q.over_ceiling ? { id: l.id, pay_amount: Number(l.pay_amount), credit_usd: money2(q.credit_usd), provider: l.provider } : null;
    }))).filter(Boolean);
    const openRow = rows.find((l) => l.pay_amount === null);
    let amountForCredit = null;
    let openLink = null;
    if (openRow) {
      openLink = { id: openRow.id, min_amount: Number(openRow.min_amount), max_amount: Number(openRow.max_amount) };
      const q1 = await quote(currency, 1);
      if (q1) {
        const mid = Number(q1.mid_rate);
        const spread = currency === 'USD' ? 0 : Number(settings.link_deposit_spread_pct) / 100;
        const feePct = Number(settings.link_deposit_fee_pct) / 100;
        const feeMin = Number(settings.link_deposit_fee_min_usd);
        // Smallest amount in this currency whose credit covers the target.
        amountForCredit = (t) => {
          const usd = Math.max(t / (1 - spread - feePct), (t + feeMin) / (1 - spread));
          return Math.ceil(usd * mid * 100 + 1) / 100;
        };
      }
    }
    const plan = planDeposits(target, fixed, openLink, amountForCredit);
    if (!plan) throw userError('That is more than one plan can cover. Add funds in parts, or contact a deposit agent.');
    const items = plan.items.map((i) => {
      if (i.open) return { link_id: i.id, open: true, pay_amount: i.amount, provider: openRow.provider };
      const f = fixed.find((x) => x.id === i.id);
      return { link_id: f.id, pay_amount: f.pay_amount, credit_usd: f.credit_usd, provider: f.provider };
    });
    // Exact credit for the open amount from the database's own quote.
    for (const it of items.filter((x) => x.open)) it.credit_usd = money2((await quote(currency, it.pay_amount))?.credit_usd ?? 0);
    const total = money2(items.reduce((sum, i) => sum + Number(i.credit_usd || 0), 0));
    res.json({
      success: true,
      data: {
        currency, target_usd: target, items, total_credit_usd: total,
        pay_total: money2(items.reduce((sum, i) => sum + i.pay_amount, 0)),
        over_daily_cap: total > Number(settings.link_deposit_daily_cap_usd),
      },
    });
  } catch (err) { fail(res, err); }
});

router.post('/start', authenticateToken, async (req, res) => {
  try {
    const amount = req.body?.amount === undefined || req.body?.amount === null ? null : Number(req.body.amount);
    const p = await rpc('market_start_link_deposit', { p_user_id: req.user.id, p_link_id: id(req.body?.link_id), p_amount: amount });
    const [link, agents] = await Promise.all([
      supabase.from('market_deposit_links').select('url, instructions').eq('id', p.deposit_link_id).single(),
      agentsById([p.agent_id]),
    ]);
    res.status(201).json({ success: true, data: depositView(p, link.data, agents[p.agent_id]) });
  } catch (err) { fail(res, err); }
});

router.post('/submit', authenticateToken, async (req, res) => {
  try {
    const p = await rpc('market_submit_link_deposit', {
      p_user_id: req.user.id, p_payment_id: id(req.body?.id),
      p_payer_name: String(req.body?.payer_name || '').slice(0, 100), p_tx_ref: String(req.body?.tx_ref || '').slice(0, 140),
    });
    const agents = await agentsById([p.agent_id]);
    res.json({ success: true, data: depositView(p, null, agents[p.agent_id]) });
  } catch (err) { fail(res, err); }
});

router.post('/cancel', authenticateToken, async (req, res) => {
  try {
    await rpc('market_cancel_link_deposit', { p_user_id: req.user.id, p_payment_id: id(req.body?.id) });
    res.json({ success: true });
  } catch (err) { fail(res, err); }
});

// ── Public: listing activity (anyone) ───────────────────────────────────────
router.get('/listing-activity', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'public, max-age=30');
    res.json({ success: true, data: await rpc('market_listing_activity', { p_listing_id: id(req.query.id) }) });
  } catch (err) { fail(res, err); }
});

// ── Agent ───────────────────────────────────────────────────────────────────
async function requireAgent(req, res, next) {
  try {
    if (!(await rpc('is_deposit_agent', { p_user_id: req.user.id }))) return res.status(403).json({ success: false, error: 'Deposit agents only' });
    next();
  } catch (err) { fail(res, err); }
}

router.get('/agent', authenticateToken, requireAgent, async (req, res) => {
  try {
    const status = ['submitted', 'paid', 'failed', 'pending'].includes(req.query.status) ? req.query.status : 'submitted';
    const rows = must(await supabase.from('market_payments').select('*, profiles:user_id(full_name, username)')
      .eq('method', 'wallet_link').eq('agent_id', req.user.id).eq('status', status)
      .order(status === 'submitted' ? 'submitted_at' : 'created_at', { ascending: status === 'submitted' }).limit(100));
    res.json({
      success: true,
      data: rows.map((p) => ({ ...depositView(p, null, null), buyer: p.profiles ? { name: p.profiles.full_name, username: p.profiles.username } : null })),
    });
  } catch (err) { fail(res, err); }
});

router.post('/agent/review', authenticateToken, requireAgent, async (req, res) => {
  try {
    const confirm = req.body?.confirm === true;
    const amount = confirm ? Number(req.body?.amount_received) : null;
    if (confirm && !(amount > 0)) throw userError('Enter the amount the wallet app shows you received');
    const p = await rpc('market_review_link_deposit', {
      p_agent_id: req.user.id, p_payment_id: id(req.body?.id), p_confirm: confirm, p_amount_received: amount,
      p_note: String(req.body?.note || '').slice(0, 500) || null,
    });
    res.json({ success: true, data: depositView(p, null, null) });
  } catch (err) { fail(res, err); }
});

// ── Admin: packages and agents ──────────────────────────────────────────────
async function requireAdmin(req, res, next) {
  try {
    if (!(await rpc('is_app_admin', { p_user_id: req.user.id }))) return res.status(403).json({ success: false, error: 'Admins only' });
    next();
  } catch (err) { fail(res, err); }
}

router.get('/admin/tiers', authenticateToken, requireAdmin, async (_req, res) => {
  try {
    const links = must(await supabase.from('market_deposit_links').select('*').order('pay_amount'));
    const data = await Promise.all(DEPOSIT_CURRENCIES.map(async (currency) => ({
      currency,
      tiers: await Promise.all(DEPOSIT_TIERS[currency].map(async (amount) => {
        const q = await quote(currency, amount);
        return {
          amount,
          credit_usd: q ? money2(q.credit_usd) : null,
          over_ceiling: q ? !!q.over_ceiling : null,
          links: links.filter((l) => l.pay_currency === currency && Number(l.pay_amount) === amount),
        };
      })),
      open_link: links.find((l) => l.pay_currency === currency && l.pay_amount === null) || null,
      other_links: links.filter((l) => l.pay_currency === currency && l.pay_amount !== null && !DEPOSIT_TIERS[currency].includes(Number(l.pay_amount))),
    })));
    res.json({ success: true, data });
  } catch (err) { fail(res, err); }
});

router.get('/admin/links', authenticateToken, requireAdmin, async (_req, res) => {
  try {
    res.json({ success: true, data: must(await supabase.from('market_deposit_links').select('*').order('pay_currency').order('pay_amount')) });
  } catch (err) { fail(res, err); }
});

function linkFields(b, partial = false) {
  const f = {};
  if (!partial || b.provider !== undefined) { f.provider = String(b.provider || '').trim(); if (f.provider.length < 2) throw userError('Name the wallet app'); }
  if (!partial || b.pay_currency !== undefined) { f.pay_currency = String(b.pay_currency || '').toUpperCase(); if (!DEPOSIT_CURRENCIES.includes(f.pay_currency)) throw userError(`Currency must be one of ${DEPOSIT_CURRENCIES.join(', ')}`); }
  if (b.open) {
    // Open-amount link: the buyer types any amount from min to max.
    f.pay_amount = null;
    f.min_amount = Math.round(Number(b.min_amount) * 100) / 100;
    f.max_amount = Math.round(Number(b.max_amount) * 100) / 100;
    if (!(f.min_amount > 0) || !(f.max_amount > f.min_amount)) throw userError('Enter a minimum and a larger maximum');
  } else if (!partial || b.pay_amount !== undefined) { f.pay_amount = Math.round(Number(b.pay_amount) * 100) / 100; if (!(f.pay_amount > 0)) throw userError('Enter the package amount'); }
  if (!partial || b.url !== undefined) {
    f.url = String(b.url || '').trim();
    try { const u = new URL(f.url); if (u.protocol !== 'https:') throw new Error(); } catch { throw userError('The payment link must be a full https:// address'); }
  }
  if (b.instructions !== undefined) f.instructions = String(b.instructions || '').trim().slice(0, 500) || null;
  if (b.is_active !== undefined) f.is_active = !!b.is_active;
  if (b.sort_order !== undefined) f.sort_order = parseInt(b.sort_order, 10) || 100;
  return f;
}

async function checkCeiling(f) {
  if (f.pay_currency !== undefined && f.max_amount !== undefined) {
    const q = await quote(f.pay_currency, f.max_amount);
    if (!q) throw userError(`No current ${f.pay_currency} exchange rate. Try again later.`);
    if (q.over_ceiling) throw userError('The maximum is above the deposit ceiling. Use a smaller maximum.');
    return;
  }
  if (f.pay_currency === undefined || f.pay_amount === undefined || f.pay_amount === null) return;
  const q = await quote(f.pay_currency, f.pay_amount);
  if (!q) throw userError(`No current ${f.pay_currency} exchange rate. Try again later.`);
  if (q.over_ceiling) throw userError('This package is above the deposit ceiling. Use a smaller amount.');
  if (!(Number(q.credit_usd) > 0)) throw userError('This package is too small to cover the deposit fee.');
}

router.post('/admin/links', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const f = linkFields(req.body || {});
    await checkCeiling(f);
    res.status(201).json({ success: true, data: must(await supabase.from('market_deposit_links').insert(f).select('*').single()) });
  } catch (err) { fail(res, err); }
});

router.patch('/admin/links', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const f = { ...linkFields(req.body || {}, true), updated_at: new Date().toISOString() };
    await checkCeiling(f);
    res.json({ success: true, data: must(await supabase.from('market_deposit_links').update(f).eq('id', id(req.body?.id)).select('*').single()) });
  } catch (err) { fail(res, err); }
});

router.get('/admin/agents', authenticateToken, requireAdmin, async (_req, res) => {
  try {
    res.json({ success: true, data: must(await supabase.from('market_deposit_agents').select('*, profiles:user_id(full_name, username)').order('created_at')) });
  } catch (err) { fail(res, err); }
});

// Add or update an agent: { user_id | username, display_name, whatsapp, is_active }
router.post('/admin/agents', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    let userId = b.user_id;
    if (!userId && b.username) {
      const p = must(await supabase.from('profiles').select('id').eq('username', String(b.username).replace(/^@/, '')).maybeSingle());
      if (!p) throw userError('No user with that username');
      userId = p.id;
    }
    const whatsapp = String(b.whatsapp || '').replace(/[\s()-]/g, '');
    if (!/^\+[1-9][0-9]{7,14}$/.test(whatsapp)) throw userError('WhatsApp number must be in international format, e.g. +2348012345678');
    const name = String(b.display_name || '').trim();
    if (name.length < 2) throw userError('Enter the name buyers will see');
    const row = must(await supabase.from('market_deposit_agents')
      .upsert({ user_id: id(userId), display_name: name.slice(0, 60), whatsapp, is_active: b.is_active !== false }).select('*').single());
    res.json({ success: true, data: row });
  } catch (err) { fail(res, err); }
});

export default router;
