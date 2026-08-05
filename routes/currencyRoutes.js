import express from 'express';
import { supabase } from '../config/db.js';
import { authenticateToken } from '../auth.js';

const router = express.Router();

// GET /api/currencies — all active currencies ordered by tier then name
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('currencies')
    .select('code, name, symbol, flag, decimal_places, region, tier')
    .eq('is_active', true)
    .order('tier', { ascending: true })
    .order('name', { ascending: true });

  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, data: data || [] });
});

// GET /api/currencies/rates?base=USD — exchange rates for a base currency
router.get('/rates', async (req, res) => {
  const base = (req.query.base || 'USD').toUpperCase();
  const { data, error } = await supabase
    .from('exchange_rates')
    .select('quote_currency, rate, updated_at')
    .eq('base_currency', base)
    .order('updated_at', { ascending: false });

  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, data: data || [], base });
});

// POST /api/currencies/wallet/add — add a new currency wallet (balance 0) to the user's wallet
router.post('/wallet/add', authenticateToken, async (req, res) => {
  const { currency_code } = req.body;
  if (!currency_code) return res.status(400).json({ success: false, error: 'currency_code is required' });

  const userId = req.user.id;

  // Verify the currency is supported
  const { data: currency, error: currErr } = await supabase
    .from('currencies')
    .select('code')
    .eq('code', currency_code.toUpperCase())
    .eq('is_active', true)
    .single();

  if (currErr || !currency) {
    return res.status(400).json({ success: false, error: 'Currency not supported' });
  }

  // Get the user's wallet
  const { data: wallet, error: walletErr } = await supabase
    .from('wallets')
    .select('id')
    .eq('user_id', userId)
    .single();

  if (walletErr || !wallet) {
    return res.status(404).json({ success: false, error: 'Wallet not found' });
  }

  // Check if this currency wallet already exists
  const { data: existing } = await supabase
    .from('wallet_currencies')
    .select('id, available_balance, is_primary')
    .eq('wallet_id', wallet.id)
    .eq('currency_code', currency_code.toUpperCase())
    .maybeSingle();

  if (existing) {
    return res.status(409).json({ success: false, error: 'Currency wallet already exists', data: existing });
  }

  // Create the new currency wallet
  const { data: newWallet, error: insertErr } = await supabase
    .from('wallet_currencies')
    .insert({
      wallet_id: wallet.id,
      currency_code: currency_code.toUpperCase(),
      balance: 0,
      is_primary: false,
    })
    .select()
    .single();

  if (insertErr) return res.status(500).json({ success: false, error: insertErr.message });
  res.status(201).json({ success: true, data: newWallet });
});

// Rate fetching lives here in plain Node, not as a Postgres function -- earlier
// attempts (migrations 038-040) tried calling the external API from inside a
// SECURITY DEFINER SQL function via the `http` extension, which turned out to be
// unavailable/misconfigured on this project and, per review feedback, was the
// wrong design anyway: a DB transaction shouldn't depend on internet
// connectivity, and letting any `authenticated` client trigger a refresh (GRANT
// EXECUTE ... TO authenticated) is needless attack surface. Migration 041 drops
// that Postgres function entirely -- convert_currency_to_usd only ever READS
// exchange_rates now, which this cron keeps warm.
//
// Upserts (not delete-then-insert) so there's never a window where the table is
// empty mid-refresh -- exchange_rates_base_quote_unique (migration 041) makes
// the upsert possible. Only inserts currencies this app actually supports (the
// `currencies` table, ~65 rows) even though the API returns ~166 -- the FK on
// exchange_rates.quote_currency would reject the rest anyway.
export async function refreshExchangeRates() {
  const res = await fetch('https://open.er-api.com/v6/latest/USD');
  const json = await res.json();
  if (json.result !== 'success') {
    throw new Error(`Exchange rate API did not return success: ${JSON.stringify(json).slice(0, 200)}`);
  }

  const { data: currencies, error: currError } = await supabase.from('currencies').select('code');
  if (currError) throw currError;
  const supported = new Set((currencies || []).map((c) => c.code));

  const rows = Object.entries(json.rates)
    .filter(([code]) => supported.has(code))
    .map(([code, rate]) => ({
      base_currency: 'USD',
      quote_currency: code,
      rate,
      source: 'open.er-api.com',
      updated_at: new Date().toISOString(),
    }));

  const { error } = await supabase
    .from('exchange_rates')
    .upsert(rows, { onConflict: 'base_currency,quote_currency' });
  if (error) throw error;

  return rows.length;
}

// Same in-app-timer pattern as startMarketplaceSweepTimer (marketplaceRoutes.js):
// runs once at startup, then on an interval. The source API updates once a day,
// so every 6 hours is a comfortable freshness margin without hammering it --
// convert_currency_to_usd (migration 041) refuses to use a rate older than 48h,
// so even several missed cycles in a row fail loudly instead of silently using
// very stale data.
export function startExchangeRateRefreshTimer(intervalMs = 6 * 60 * 60 * 1000) {
  const refresh = () => {
    refreshExchangeRates()
      .then((count) => console.log(`[exchange rates] refreshed ${count} rate(s)`))
      .catch((err) => console.error('[exchange rates] refresh failed:', err.message));
  };
  refresh();
  setInterval(refresh, intervalMs);
}

// DELETE /api/currencies/wallet/remove — remove a non-primary currency wallet
router.delete('/wallet/remove', authenticateToken, async (req, res) => {
  const { currency_code } = req.body;
  if (!currency_code) return res.status(400).json({ success: false, error: 'currency_code is required' });

  const userId = req.user.id;

  const { data: wallet } = await supabase
    .from('wallets')
    .select('id')
    .eq('user_id', userId)
    .single();

  if (!wallet) return res.status(404).json({ success: false, error: 'Wallet not found' });

  const { data: currWallet } = await supabase
    .from('wallet_currencies')
    .select('id, balance, is_primary')
    .eq('wallet_id', wallet.id)
    .eq('currency_code', currency_code.toUpperCase())
    .single();

  if (!currWallet) return res.status(404).json({ success: false, error: 'Currency wallet not found' });
  if (currWallet.is_primary) return res.status(400).json({ success: false, error: 'Cannot remove primary currency wallet' });
  if (currWallet.balance > 0) return res.status(400).json({ success: false, error: 'Cannot remove wallet with non-zero balance' });

  const { error } = await supabase
    .from('wallet_currencies')
    .delete()
    .eq('id', currWallet.id);

  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, message: `${currency_code} wallet removed` });
});

export default router;
