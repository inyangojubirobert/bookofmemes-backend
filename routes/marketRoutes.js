// Real-money marketplace: Paystack (naira) and USDT payments in, refunds and
// withdrawals out, admin review, and account deletion. The money rules
// themselves live in the database (migration 055); these routes only talk to
// Paystack and the blockchains, then call those database functions.
//
// Env (Backend/.env):
//   PAYSTACK_SECRET_KEY            shared with One Dream (references here start "bom")
//   PAYSTACK_TRANSFERS_ENABLED     "true" to send bank payouts automatically through
//                                  Paystack Transfers. Leave unset until a real test
//                                  transfer has worked; admins then pay by hand and
//                                  record the bank reference.
//   CRYPTO_WALLET_ADDRESS_TRON / _BSC, TRON_GRID_API, TRON_PRO_API_KEY, BSC_RPC_URL
//   SITE_URL                       optional, defaults to https://bookofmemes.cc
import express from 'express';
import { supabase } from '../config/db.js';
import { authenticateToken } from '../auth.js';
import { userScopedClient, tokenFromRequest } from '../utils/supabaseUserClient.js';
import { paystack, bomReference, listBanks, namesMatch, PaystackError } from '../utils/paystack.js';
import { verifyUsdtForPayment, isValidUsdtAddress, USDT_NETWORKS } from '../utils/usdtVerify.js';

const router = express.Router();
export const accountRouter = express.Router();

const SITE_URL = process.env.SITE_URL || 'https://bookofmemes.cc';
const transfersEnabled = () => process.env.PAYSTACK_TRANSFERS_ENABLED === 'true';
const round2 = (n) => Math.round(Number(n) * 100) / 100;

// Database rule violations (RAISE EXCEPTION -> P0001) and Paystack refusals are
// the user's to fix (400). Anything else is ours (500, logged).
function fail(res, err, fallback = 'Something went wrong') {
  const expected = err?.code === 'P0001' || err instanceof PaystackError || err?.expected;
  if (!expected) console.error('[market]', err?.message || err);
  return res.status(expected ? 400 : 500).json({ success: false, error: expected ? err.message : fallback });
}
const userError = (message) => Object.assign(new Error(message), { expected: true });

async function rpc(name, args) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  return data;
}

async function settings() {
  const { data, error } = await supabase.from('market_settings').select('*').eq('id', true).single();
  if (error) throw error;
  return data;
}

async function ngnRate() {
  const { data } = await supabase.from('market_fx_rates').select('*').eq('currency', 'NGN').maybeSingle();
  return data;
}

// How much must be paid in, and in which currency, so the user can make
// this bid / purchase. Uses the database's own quote (market_quote), so the
// fee and any GBP/EUR/GHS conversion match exactly what place_cash_bid charges.
// Returns { currency, amount, methods }.
const TOPUP_MAX_USD = 2000;
async function amountNeeded(userId, purpose) {
  // A plain top-up of marketplace funds (Add funds): the amount asked for.
  if (purpose.action === 'deposit') {
    const s = await settings();
    const rate = purpose.currency === 'USD' ? 1 : Number(await rpc('market_rate', { p_code: purpose.currency }));
    const usd = purpose.amount / rate;
    if (usd < Number(s.min_payment_usd)) throw userError(`The minimum top-up is ${purpose.currency === 'USD' ? '$' : '₦'}${(Number(s.min_payment_usd) * rate).toFixed(2)}`);
    if (usd > TOPUP_MAX_USD) throw userError(`The most you can add at once is about $${TOPUP_MAX_USD}`);
    return { currency: purpose.currency, amount: purpose.amount, methods: purpose.currency === 'NGN' ? ['paystack'] : ['paystack', 'usdt'] };
  }
  const { data: l } = await supabase.from('marketplace_listings')
    .select('status, expires_at, seller_id, listing_type, buy_now_price, listing_currency').eq('id', purpose.listing_id).maybeSingle();
  if (!l) throw userError('Listing not found');
  let listingAmount;
  if (purpose.action === 'bid') {
    listingAmount = round2(purpose.bid_amount);
    if (!(listingAmount > 0)) throw userError('Enter a bid amount');
    // Check the bid is valid before taking any money.
    if (l.status !== 'active' || (l.expires_at && new Date(l.expires_at) <= new Date())) throw userError('Bidding on this listing has closed');
    if (l.seller_id === userId) throw userError("You can't bid on your own listing");
    if (l.listing_type === 'fixed_price') throw userError('This is a fixed-price listing. Use Buy Now instead.');
    if (l.buy_now_price && listingAmount >= Number(l.buy_now_price)) throw userError('Your bid reaches the Buy Now price. Use Buy Now instead.');
    const min = Number(await rpc('market_min_bid', { p_listing_id: purpose.listing_id }));
    if (listingAmount < min) throw userError(`Bid must be at least ${l.listing_currency} ${min.toFixed(2)}`);
  } else if (purpose.action === 'buy_now') {
    if (l.status !== 'active' || !l.buy_now_price) throw userError('This listing is not available');
    if (l.seller_id === userId) throw userError("You can't buy your own listing");
    listingAmount = Number(l.buy_now_price);
  } else {
    throw userError('Unknown action');
  }
  const quote = await rpc('market_quote', { p_listing_id: purpose.listing_id, p_amount: listingAmount });
  const currency = quote.settle_currency;
  const funds = Number(await rpc('market_funds_balance', { p_user_id: userId, p_currency: currency }));
  const total = Number(quote.total);
  if (total <= funds) return { currency, amount: 0, methods: quote.payment_methods };
  const s = await settings();
  const minPay = currency === 'USD' ? Number(s.min_payment_usd)
    : Number(await rpc('market_convert', { p_amount: s.min_payment_usd, p_from: 'USD', p_to: currency }));
  return { currency, amount: round2(Math.max(total - funds, minPay)), methods: quote.payment_methods };
}

// After a payment is confirmed, finish what the user was doing, as that user.
async function runPurpose(req, purpose) {
  if (!purpose?.action || !req) return null;
  const client = userScopedClient(tokenFromRequest(req));
  if (purpose.action === 'bid') {
    const { data, error } = await client.rpc('place_cash_bid', { p_listing_id: purpose.listing_id, p_amount: purpose.bid_amount });
    if (error) return { done: false, error: `Payment received and saved in your marketplace funds, but the bid didn't go through: ${error.message}` };
    return { done: true, bid: data };
  }
  if (purpose.action === 'buy_now') {
    const { data, error } = await client.rpc('buy_now_cash', { p_listing_id: purpose.listing_id });
    if (error) return { done: false, error: `Payment received and saved in your marketplace funds, but the purchase didn't go through: ${error.message}` };
    return { done: true, purchase: data };
  }
  return null;
}

function cleanPurpose(body) {
  const action = body?.action;
  if (action === 'deposit') {
    const currency = body?.currency === 'NGN' ? 'NGN' : 'USD';
    const amount = round2(body?.amount);
    if (!(amount > 0)) throw userError('Enter an amount');
    return { action, currency, amount };
  }
  if (action === 'bid') return { action, listing_id: String(body.listing_id), bid_amount: round2(body.bid_amount) };
  if (action === 'buy_now') return { action, listing_id: String(body.listing_id) };
  throw userError('Unknown action');
}

// Runs the payment's purpose exactly once, even if verify is called twice.
async function claimAndRunPurpose(req, payment) {
  const { data: claimed } = await supabase.from('market_payments')
    .update({ purpose: { ...payment.purpose, consumed: true } })
    .eq('id', payment.id).is('purpose->>consumed', null).select('id');
  if (!claimed?.length) return null;
  return runPurpose(req, payment.purpose);
}

// ── Config ───────────────────────────────────────────────────────────────────
router.get('/config', async (_req, res) => {
  try {
    const [s, fx, currencies] = await Promise.all([
      settings(), ngnRate(),
      supabase.from('marketplace_currencies').select('code, name, symbol, settlement_currency, payment_methods').eq('is_enabled', true).order('sort_order'),
    ]);
    res.json({
      success: true,
      data: {
        settings: s,
        currencies: currencies.data || [],
        ngn_per_usd: fx ? round2(Number(fx.units_per_usd) * (1 + Number(s.fx_spread_pct) / 100)) : null,
        usdt: Object.fromEntries(Object.entries(USDT_NETWORKS)
          .filter(([, v]) => v.address())
          .map(([k, v]) => [k, { label: v.label, address: v.address() }])),
        transfers_automatic: transfersEnabled(),
      },
    });
  } catch (err) { fail(res, err); }
});

router.get('/banks', authenticateToken, async (_req, res) => {
  try { res.json({ success: true, data: await listBanks() }); } catch (err) { fail(res, err); }
});

// ── Paystack payments ───────────────────────────────────────────────────────
router.post('/pay/paystack/start', authenticateToken, async (req, res) => {
  try {
    const purpose = cleanPurpose(req.body);
    const need = await amountNeeded(req.user.id, purpose);
    if (need.amount <= 0) return res.json({ success: true, data: { no_payment_needed: true } });
    if (!need.methods.includes('paystack')) throw userError('This listing is paid in USDT');

    const reference = bomReference('pay');
    const payment = await rpc('market_create_payment', {
      p_user_id: req.user.id, p_method: 'paystack', p_credit_currency: need.currency, p_amount: need.amount,
      p_purpose: purpose, p_reference: reference,
    });
    const email = req.user.email || `${req.user.id}@users.bookofmemes.cc`;
    const init = await paystack('/transaction/initialize', {
      method: 'POST',
      body: {
        email,
        amount: Math.round(Number(payment.amount_due) * 100),
        currency: 'NGN',
        reference,
        callback_url: `${SITE_URL}/pay/done?ref=${reference}`,
        metadata: { app: 'bookofmemes', payment_id: payment.id, user_id: req.user.id, purpose },
      },
    });
    res.json({
      success: true,
      data: {
        reference, authorization_url: init.authorization_url,
        credit_currency: need.currency, credit_amount: need.amount,
        amount_ngn: Number(payment.amount_due), ngn_per_usd: payment.fx_rate ? Number(payment.fx_rate) : null,
      },
    });
  } catch (err) { fail(res, err); }
});

async function confirmPaystack(payment) {
  const tx = await paystack(`/transaction/verify/${encodeURIComponent(payment.paystack_reference)}`);
  if (tx.status !== 'success') return { ok: false, pending: ['ongoing', 'pending', 'processing', 'queued', 'abandoned'].includes(tx.status), status: tx.status };
  if (tx.reference !== payment.paystack_reference || tx.currency !== 'NGN') throw userError('Payment details do not match');
  if (tx.metadata?.payment_id && tx.metadata.payment_id !== payment.id) throw userError('Payment details do not match');
  const received = Number(tx.amount) / 100;
  if (received < Number(payment.amount_due)) throw userError('Amount paid is less than amount due');
  await rpc('market_confirm_payment', {
    p_payment_id: payment.id, p_amount_received: received,
    p_provider_data: { id: tx.id, channel: tx.channel, paid_at: tx.paid_at, card: tx.authorization?.last4 ? { last4: tx.authorization.last4, bank: tx.authorization.bank } : null },
  });
  return { ok: true };
}

router.post('/pay/paystack/verify', authenticateToken, async (req, res) => {
  try {
    const { data: payment } = await supabase.from('market_payments').select('*')
      .eq('paystack_reference', String(req.body?.reference || '')).eq('user_id', req.user.id).maybeSingle();
    if (!payment) return res.status(404).json({ success: false, error: 'Payment not found' });
    if (payment.status !== 'paid') {
      const r = await confirmPaystack(payment);
      if (!r.ok) return res.status(r.pending ? 202 : 400).json({ success: false, pending: r.pending, error: r.pending ? 'Payment not completed yet' : `Payment ${r.status}` });
    }
    const next = await claimAndRunPurpose(req, payment);
    res.json({ success: true, data: { paid: true, next } });
  } catch (err) { fail(res, err); }
});

// ── USDT payments ───────────────────────────────────────────────────────────
router.post('/pay/usdt/start', authenticateToken, async (req, res) => {
  try {
    const network = req.body?.network;
    const sender = String(req.body?.sender || '').trim();
    if (!USDT_NETWORKS[network]?.address()) return res.status(400).json({ success: false, error: 'Choose TRON or BSC' });
    if (!isValidUsdtAddress(network, sender)) return res.status(400).json({ success: false, error: 'Enter the wallet address you will send from' });
    const purpose = { ...cleanPurpose(req.body), network, sender: network === 'bsc' ? sender.toLowerCase() : sender };
    const need = await amountNeeded(req.user.id, purpose);
    if (need.amount <= 0) return res.json({ success: true, data: { no_payment_needed: true } });
    if (!need.methods.includes('usdt')) throw userError('Naira listings are paid by card or bank (Paystack)');
    const payment = await rpc('market_create_payment', {
      p_user_id: req.user.id, p_method: 'usdt', p_credit_currency: 'USD', p_amount: need.amount, p_purpose: purpose, p_reference: null,
    });
    res.json({
      success: true,
      data: {
        payment_id: payment.id, network, pay_to: USDT_NETWORKS[network].address(), label: USDT_NETWORKS[network].label,
        amount_usdt: Number(payment.amount_due), expires_at: payment.expires_at,
        note: `Send exactly ${payment.amount_due} USDT from ${sender}. A different amount or sender address won't be matched to this payment.`,
      },
    });
  } catch (err) { fail(res, err); }
});

router.post('/pay/usdt/verify', authenticateToken, async (req, res) => {
  try {
    const { data: payment } = await supabase.from('market_payments').select('*')
      .eq('id', String(req.body?.payment_id || '')).eq('user_id', req.user.id).eq('method', 'usdt').maybeSingle();
    if (!payment) return res.status(404).json({ success: false, error: 'Payment not found' });
    if (payment.status === 'failed') return res.status(400).json({ success: false, error: 'This payment session expired. Start a new one.' });
    if (payment.status !== 'paid') {
      const network = payment.purpose?.network;
      const v = await verifyUsdtForPayment(payment, network, req.body?.tx_hash);
      if (!v.ok) return res.status(v.pending ? 202 : 400).json({ success: false, pending: !!v.pending, error: v.error });
      await rpc('market_confirm_payment', {
        p_payment_id: payment.id, p_amount_received: v.amount, p_provider_data: { verified_at: new Date().toISOString() },
        p_usdt_network: network, p_usdt_tx_hash: v.hash, p_usdt_sender: v.sender,
      });
    }
    const next = await claimAndRunPurpose(req, payment);
    res.json({ success: true, data: { paid: true, next } });
  } catch (err) {
    if (/duplicate|unique/i.test(err.message)) return res.status(409).json({ success: false, error: 'This transaction has already been used' });
    fail(res, err);
  }
});

// ── Payout accounts ─────────────────────────────────────────────────────────
router.post('/payout-accounts/bank', authenticateToken, async (req, res) => {
  try {
    const bankCode = String(req.body?.bank_code || '');
    const accountNumber = String(req.body?.account_number || '').replace(/\D/g, '');
    if (!/^\d{10}$/.test(accountNumber)) return res.status(400).json({ success: false, error: 'Enter a 10-digit account number' });
    const bank = (await listBanks()).find((b) => b.code === bankCode);
    if (!bank) return res.status(400).json({ success: false, error: 'Choose your bank' });

    const resolved = await paystack(`/bank/resolve?account_number=${accountNumber}&bank_code=${encodeURIComponent(bankCode)}`);
    const { data: profile } = await supabase.from('profiles').select('full_name, username').eq('id', req.user.id).single();
    if (!namesMatch(resolved.account_name, profile?.full_name)) {
      return res.status(400).json({
        success: false,
        error: `This account is in the name "${resolved.account_name}", which doesn't match your profile name. Payouts can only go to an account in your own name.`,
      });
    }
    const recipient = await paystack('/transferrecipient', {
      method: 'POST',
      body: { type: 'nuban', name: resolved.account_name, account_number: accountNumber, bank_code: bankCode, currency: 'NGN',
              metadata: { app: 'bookofmemes', user_id: req.user.id } },
    });
    const row = await rpc('save_payout_account', {
      p_user_id: req.user.id, p_method: 'bank_ngn', p_bank_code: bankCode, p_bank_name: bank.name,
      p_account_number: accountNumber, p_account_name: resolved.account_name, p_recipient_code: recipient.recipient_code, p_usdt_address: null,
    });
    res.json({ success: true, data: row });
  } catch (err) { fail(res, err); }
});

router.post('/payout-accounts/usdt', authenticateToken, async (req, res) => {
  try {
    const network = req.body?.network;
    const address = String(req.body?.address || '').trim();
    if (!['tron', 'bsc'].includes(network) || !isValidUsdtAddress(network, address)) {
      return res.status(400).json({ success: false, error: 'Enter a valid USDT address for that network' });
    }
    const row = await rpc('save_payout_account', {
      p_user_id: req.user.id, p_method: `usdt_${network}`, p_bank_code: null, p_bank_name: null,
      p_account_number: null, p_account_name: null, p_recipient_code: null, p_usdt_address: network === 'bsc' ? address.toLowerCase() : address,
    });
    res.json({ success: true, data: row });
  } catch (err) { fail(res, err); }
});

// ── Admin ───────────────────────────────────────────────────────────────────
async function requireAdmin(req, res, next) {
  try {
    const isAdmin = await rpc('is_app_admin', { p_user_id: req.user.id });
    if (!isAdmin) return res.status(403).json({ success: false, error: 'Admins only' });
    next();
  } catch (err) { fail(res, err); }
}

// Treasury check, per settlement currency, before approving payouts:
//   credited      money users paid in (credited to their funds)
//   owed          what the platform still owes them: spendable funds, bids held
//                 in escrow, unpaid earnings, payouts in progress
//   paid_out      payouts already sent
//   platform      fees the platform has earned (bid/purchase fees, commission)
// The ledger is double-entry, so credited = owed + paid_out + platform; any
// difference means a bug or a manual change and must be looked at before
// paying anyone. "hold_at_least" is what must be in the bank/wallet for the
// currency to cover every user (owed).
router.get('/admin/treasury', authenticateToken, requireAdmin, async (_req, res) => {
  try {
    const all = async (q) => { const { data, error } = await q; if (error) throw error; return data || []; };
    const [ledger, bids, payments, withdrawals] = await Promise.all([
      all(supabase.from('market_ledger').select('user_id, bucket, kind, currency, amount')),
      all(supabase.from('marketplace_bids').select('settle_currency, settle_amount').eq('status', 'active').eq('funding', 'cash')),
      all(supabase.from('market_payments').select('credit_currency, credit_amount').eq('status', 'paid')),
      all(supabase.from('market_withdrawals').select('currency, amount, status').in('status', ['pending', 'processing', 'paid'])),
    ]);
    const t = {};
    const cur = (c) => (t[c] ||= { credited: 0, funds: 0, escrow: 0, earnings: 0, payouts_in_progress: 0, paid_out: 0, platform: 0 });
    for (const p of payments) cur(p.credit_currency).credited += Number(p.credit_amount);
    for (const l of ledger) {
      const amt = Number(l.amount);
      if (l.bucket === 'platform') cur(l.currency).platform += amt;
      else if (l.bucket === 'funds' && l.user_id) cur(l.currency).funds += amt;
      else if (l.bucket === 'earnings' && l.user_id) {
        cur(l.currency).earnings += amt;
        // Authors' ad earnings are paid from ad revenue (AdMob/advertisers), not
        // from users' payments, so they count as money in (migration 068).
        if (l.kind === 'ad_revenue') { cur(l.currency).credited += amt; cur(l.currency).ad_revenue = (cur(l.currency).ad_revenue || 0) + amt; }
      }
    }
    for (const b of bids) cur(b.settle_currency).escrow += Number(b.settle_amount);
    for (const w of withdrawals) {
      if (w.status === 'paid') cur(w.currency).paid_out += Number(w.amount);
      else cur(w.currency).payouts_in_progress += Number(w.amount);
    }
    const r2 = (n) => Math.round(n * 100) / 100;
    const data = Object.entries(t).map(([currency, v]) => {
      const owed = v.funds + v.escrow + v.earnings + v.payouts_in_progress;
      const difference = v.credited - (owed + v.paid_out + v.platform);
      return {
        currency, ...Object.fromEntries(Object.entries(v).map(([k, n]) => [k, r2(n)])),
        owed: r2(owed), hold_at_least: r2(owed), difference: r2(difference), balanced: Math.abs(difference) < 0.01,
      };
    }).sort((a, b) => a.currency.localeCompare(b.currency));
    res.json({ success: true, data: { currencies: data, checked_at: new Date().toISOString() } });
  } catch (err) { fail(res, err); }
});

router.get('/admin/withdrawals', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const status = String(req.query.status || 'pending');
    const { data: rows, error } = await supabase.from('market_withdrawals').select('*')
      .in('status', status === 'open' ? ['pending', 'processing'] : [status]).order('created_at', { ascending: true }).limit(100);
    if (error) throw error;
    const userIds = [...new Set(rows.map((r) => r.user_id).filter(Boolean))];
    const { data: profiles } = userIds.length
      ? await supabase.from('profiles').select('id, full_name, username, created_at').in('id', userIds)
      : { data: [] };
    const byId = Object.fromEntries((profiles || []).map((p) => [p.id, p]));
    const out = [];
    for (const w of rows) {
      const item = { ...w, user: byId[w.user_id] || null };
      if (w.bucket === 'funds') {
        item.sources = await rpc('market_withdrawal_sources', { p_withdrawal_id: w.id });
      } else {
        // Who paid for the earnings being withdrawn: lets the admin spot sales
        // between connected accounts before paying out.
        const { data: sales } = await supabase.from('market_earnings')
          .select('kind, currency, amount, created_at, ownership:ownership_id(to_user_id, sale_price)')
          .eq('user_id', w.user_id).order('created_at', { ascending: false }).limit(20);
        item.recent_earnings = sales || [];
      }
      out.push(item);
    }
    res.json({ success: true, data: out, transfers_automatic: transfersEnabled() });
  } catch (err) { fail(res, err); }
});

async function payoutEarnings(w, s) {
  const d = w.payout_details || {};
  if (d.method !== 'bank_ngn' || !transfersEnabled()) {
    return { manual: true, note: d.method === 'bank_ngn' ? 'Automatic transfers are off: pay by bank transfer, then mark paid with the reference.' : `Send USDT to ${d.usdt_address}, then mark paid with the transaction hash.` };
  }
  let rate = null;
  let ngn;
  if (w.currency === 'NGN') {
    ngn = Math.floor(Number(w.amount));
  } else {
    const fx = await ngnRate();
    if (!fx || Date.now() - new Date(fx.fetched_at).getTime() > Number(s.fx_max_age_hours) * 3600_000) {
      return { manual: true, note: 'No current exchange rate: pay by hand or retry later' };
    }
    rate = round2(Number(fx.units_per_usd) * (1 - Number(s.fx_spread_pct) / 100));
    ngn = Math.floor(Number(w.amount) * rate);
  }
  const reference = `bomwd_${w.id.replace(/-/g, '')}`;
  await supabase.from('market_withdrawals').update({ provider_ref: reference, amount_paid: ngn, currency_paid: 'NGN', fx_rate: rate }).eq('id', w.id);
  try {
    const t = await paystack('/transfer', {
      method: 'POST',
      body: { source: 'balance', amount: ngn * 100, recipient: d.recipient_code, reference, reason: 'Book of Memes earnings' },
    });
    if (t.status === 'success') {
      await rpc('market_complete_withdrawal', { p_withdrawal_id: w.id, p_provider_ref: reference, p_amount_paid: ngn, p_currency_paid: 'NGN', p_fx_rate: rate, p_admin_id: null });
      return { paid: true };
    }
    if (t.status === 'otp') return { manual: true, note: 'Paystack wants an OTP for this transfer. Finish it in the Paystack dashboard, then mark paid. Turn off transfer OTP to make this automatic.' };
    return { pending: true, note: `Transfer ${t.status}. It will be confirmed automatically.` };
  } catch (err) {
    await supabase.from('market_withdrawals').update({ provider_ref: null }).eq('id', w.id);
    return { manual: true, note: `Paystack transfer failed: ${err.message}. Fix it and retry, pay by hand, or mark failed to return the money.` };
  }
}

async function refundFunds(w) {
  const sources = await rpc('market_withdrawal_sources', { p_withdrawal_id: w.id });
  const refs = [];
  const manual = [];
  for (const src of sources) {
    if (src.method === 'paystack') {
      // NGN lots refund naira 1:1; USD lots paid by card refund the naira
      // that was charged for them, at that payment's own rate.
      const kobo = src.currency === 'NGN'
        ? Math.round(Number(src.amount) * 100)
        : Math.round(Number(src.amount) * Number(src.fx_rate) * 100);
      try {
        const r = await paystack('/refund', {
          method: 'POST',
          body: { transaction: src.paystack_reference, amount: kobo, merchant_note: `Book of Memes refund ${w.id}` },
        });
        refs.push(`refund:${r.id || src.paystack_reference}`);
      } catch (err) {
        manual.push(`Paystack refund for ${src.paystack_reference} failed (${err.message})`);
      }
    } else if (src.method === 'wallet_link') {
      // No API: the agent or admin sends it back through the wallet app by hand,
      // in the currency it was paid in, at that deposit's own rate.
      const back = src.pay_currency === 'USD' ? Number(src.amount) : Math.round(Number(src.amount) * Number(src.fx_mid_rate) * 100) / 100;
      manual.push(`Send ${src.pay_currency} ${back.toFixed(2)} back through ${src.deposit_provider} to ${src.payer_name} (deposit ${src.deposit_code}, their transaction ${src.payer_tx_ref})`);
    } else {
      manual.push(`Send ${Number(src.amount)} USDT on ${src.usdt_network} back to ${src.usdt_sender}`);
    }
  }
  if (!manual.length) {
    await rpc('market_complete_withdrawal', { p_withdrawal_id: w.id, p_provider_ref: refs.join(','), p_amount_paid: Number(w.amount), p_currency_paid: w.currency, p_fx_rate: null, p_admin_id: null });
    return { paid: true };
  }
  if (refs.length) await supabase.from('market_withdrawals').update({ admin_note: `${w.admin_note || ''} Refunds created: ${refs.join(',')}`.trim() }).eq('id', w.id);
  return { manual: true, note: manual.join('; ') + (refs.length ? `. Already refunded through Paystack: ${refs.join(', ')}.` : '') };
}

router.post('/admin/withdrawals/:id/approve', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const s = await settings();
    const w = await rpc('market_decide_withdrawal', { p_withdrawal_id: req.params.id, p_approve: true, p_note: req.body?.note || null, p_admin_id: req.user.id });
    const result = w.bucket === 'earnings' ? await payoutEarnings(w, s) : await refundFunds(w);
    res.json({ success: true, data: { withdrawal_id: w.id, ...result } });
  } catch (err) { fail(res, err); }
});

router.post('/admin/withdrawals/:id/reject', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const w = await rpc('market_decide_withdrawal', { p_withdrawal_id: req.params.id, p_approve: false, p_note: req.body?.note || 'Declined by admin', p_admin_id: req.user.id });
    res.json({ success: true, data: w });
  } catch (err) { fail(res, err); }
});

router.post('/admin/withdrawals/:id/mark-paid', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { reference, amount_paid, currency } = req.body || {};
    const w = await rpc('market_complete_withdrawal', {
      p_withdrawal_id: req.params.id, p_provider_ref: String(reference || ''), p_amount_paid: Number(amount_paid) || null,
      p_currency_paid: currency || null, p_fx_rate: null, p_admin_id: req.user.id,
    });
    res.json({ success: true, data: w });
  } catch (err) { fail(res, err); }
});

router.post('/admin/withdrawals/:id/mark-failed', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const w = await rpc('market_fail_withdrawal', { p_withdrawal_id: req.params.id, p_reason: String(req.body?.reason || 'Payout failed') });
    res.json({ success: true, data: w });
  } catch (err) { fail(res, err); }
});

// ── Account deletion (Google Play requirement) ─────────────────────────────
accountRouter.post('/delete', authenticateToken, async (req, res) => {
  try {
    const { data, error } = await userScopedClient(tokenFromRequest(req)).rpc('request_account_deletion');
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) { fail(res, err); }
});

accountRouter.post('/delete/cancel', authenticateToken, async (req, res) => {
  try {
    const { error } = await userScopedClient(tokenFromRequest(req)).rpc('cancel_account_deletion');
    if (error) throw error;
    res.json({ success: true });
  } catch (err) { fail(res, err); }
});

// ── Background jobs ─────────────────────────────────────────────────────────
// Rates for every listing currency, from open.er-api.com (publishes daily).
// A new rate that moved more than max_rate_jump_percent from the stored one is
// refused (bad-feed protection, as in One Dream); the old rate then ages out
// and payments in that currency pause until someone checks.
export async function refreshFxRates() {
  const r = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(20_000) });
  const body = await r.json();
  if (body?.result !== 'success') throw new Error('FX provider error');
  const s = await settings();
  const { data: currencies } = await supabase.from('marketplace_currencies').select('code').neq('code', 'USD');
  const { data: stored } = await supabase.from('market_fx_rates').select('currency, units_per_usd');
  const prev = Object.fromEntries((stored || []).map((x) => [x.currency, Number(x.units_per_usd)]));
  const rows = [];
  for (const { code } of currencies || []) {
    const next = Number(body.rates?.[code]);
    if (!(next > 0)) { console.error(`[market] FX: no ${code} rate`); continue; }
    if (prev[code] && Math.abs(next - prev[code]) / prev[code] * 100 > Number(s.max_rate_jump_percent)) {
      console.error(`[market] FX: refused ${code} ${next} (was ${prev[code]}): moved more than ${s.max_rate_jump_percent}%`);
      continue;
    }
    rows.push({ currency: code, units_per_usd: next, fetched_at: new Date().toISOString() });
  }
  if (rows.length) {
    const { error } = await supabase.from('market_fx_rates').upsert(rows);
    if (error) throw error;
  }
  return rows;
}

// Payments whose user closed the app before returning, transfers that were
// still pending, and accounts ready to be deleted.
export async function runMarketReconciliation() {
  const since = new Date(Date.now() - 3 * 3600_000).toISOString();
  const { data: pending } = await supabase.from('market_payments').select('*')
    .eq('method', 'paystack').eq('status', 'pending').gte('created_at', since).limit(50);
  for (const p of pending || []) {
    try {
      const r = await confirmPaystack(p);
      if (r.ok) {
        await supabase.from('notifications').insert({ user_id: p.user_id, type: 'marketplace_payment', title: 'Payment received',
          body: 'Your payment is in your marketplace funds. Open the listing to finish your bid or purchase.', reference_id: p.id });
      }
    } catch (err) { console.error('[market] reconcile payment', p.id, err.message); }
  }

  if (transfersEnabled()) {
    const { data: processing } = await supabase.from('market_withdrawals').select('*')
      .eq('status', 'processing').eq('bucket', 'earnings').like('provider_ref', 'bomwd_%').limit(50);
    for (const w of processing || []) {
      try {
        const t = await paystack(`/transfer/verify/${w.provider_ref}`);
        if (t.status === 'success') {
          await rpc('market_complete_withdrawal', { p_withdrawal_id: w.id, p_provider_ref: w.provider_ref, p_amount_paid: w.amount_paid, p_currency_paid: 'NGN', p_fx_rate: w.fx_rate, p_admin_id: null });
        } else if (['failed', 'reversed'].includes(t.status)) {
          await rpc('market_fail_withdrawal', { p_withdrawal_id: w.id, p_reason: `Bank transfer ${t.status}` });
        }
      } catch (err) { console.error('[market] reconcile transfer', w.id, err.message); }
    }
  }

  // Link deposits the buyer never finished.
  await rpc('market_expire_link_deposits', {}).catch((e) => console.error('[market] expire link deposits', e.message));

  const ready = await rpc('accounts_ready_for_deletion', {});
  for (const { user_id: uid } of ready || []) {
    try {
      await rpc('finalize_account_deletion', { p_user_id: uid });
      await supabase.from('profiles').delete().eq('id', uid);
      const { error } = await supabase.auth.admin.deleteUser(uid);
      if (error && !/not found/i.test(error.message)) throw error;
    } catch (err) { console.error('[account] deletion', uid, err.message); }
  }
}

export function startMarketTimers() {
  const fx = () => refreshFxRates().catch((e) => console.error('[market] FX refresh failed:', e.message));
  const rec = () => runMarketReconciliation().catch((e) => console.error('[market] reconciliation failed:', e.message));
  fx(); rec();
  setInterval(fx, 3 * 3600_000);
  setInterval(rec, 10 * 60_000);
}

export default router;
