import express from 'express';
import { supabase } from '../config/db.js';
import { authenticateToken } from '../auth.js';

const router = express.Router();

// GET /api/wallet
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    let { data, error } = await supabase
      .from('wallets')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error && error.code === 'PGRST116') {
      const { data: newWallet, error: createError } = await supabase
        .from('wallets')
        .insert({ user_id: userId })
        .select()
        .single();
      if (createError) throw createError;
      return res.json({ success: true, data: newWallet });
    }

    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/wallet/currencies
router.get('/currencies', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { data: wallet } = await supabase
      .from('wallets')
      .select('id')
      .eq('user_id', userId)
      .single();

    if (!wallet) return res.status(404).json({ success: false, error: 'Wallet not found' });

    const { data, error } = await supabase
      .from('wallet_currencies')
      .select('*')
      .eq('wallet_id', wallet.id);

    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/wallet/ledger
router.get('/ledger', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const { data: wallet } = await supabase
      .from('wallets')
      .select('id')
      .eq('user_id', userId)
      .single();

    if (!wallet) return res.status(404).json({ success: false, error: 'Wallet not found' });

    const { data, error } = await supabase
      .from('wallet_ledger')
      .select('*')
      .eq('wallet_id', wallet.id)
      .order('created_at', { ascending: false })
      .range(offset, offset + parseInt(limit) - 1);

    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/wallet/transactions
router.get('/transactions', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { type, limit = 50 } = req.query;

    const { data: wallet } = await supabase
      .from('wallets')
      .select('id')
      .eq('user_id', userId)
      .single();

    if (!wallet) return res.status(404).json({ success: false, error: 'Wallet not found' });

    let query = supabase
      .from('wallet_transactions')
      .select('*')
      .eq('wallet_id', wallet.id)
      .order('created_at', { ascending: false })
      .limit(parseInt(limit));

    if (type) query = query.eq('type', type);

    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/wallet/lookup/:query
// Accepts a wallet UUID or a @username / plain username.
// Uses the service-role client so RLS does not block cross-user lookups.
router.get('/lookup/:query', authenticateToken, async (req, res) => {
  try {
    const { query } = req.params;
    if (!query || query.length < 2) {
      return res.status(400).json({ success: false, error: 'Query too short' });
    }

    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(query);
    let walletData = null;

    if (isUUID) {
      const { data, error } = await supabase
        .from('wallets')
        .select('id, user_id, profiles:user_id(full_name, avatar_url, username)')
        .eq('id', query)
        .maybeSingle();
      if (error) throw error;
      walletData = data;
    } else {
      // Username search — strip leading @ if present
      const username = query.startsWith('@') ? query.slice(1) : query;

      const { data: profile, error: profileErr } = await supabase
        .from('profiles')
        .select('id, full_name, avatar_url, username')
        .ilike('username', username)
        .maybeSingle();
      if (profileErr) throw profileErr;

      if (profile) {
        const { data: wallet, error: walletErr } = await supabase
          .from('wallets')
          .select('id, user_id')
          .eq('user_id', profile.id)
          .maybeSingle();
        if (walletErr) throw walletErr;
        if (wallet) walletData = { ...wallet, profiles: profile };
      }
    }

    if (!walletData) {
      const msg = isUUID ? 'No wallet found with this ID' : 'No user found with that username';
      return res.status(404).json({ success: false, error: msg });
    }

    res.json({ success: true, data: walletData });
  } catch (error) {
    console.error('Wallet lookup error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
