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

export default router;
