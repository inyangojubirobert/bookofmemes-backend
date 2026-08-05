import express from 'express';
import { supabase } from '../config/db.js';
import { authenticateToken } from '../auth.js';

const router = express.Router();

const TOKEN_PACKAGES = [
  { id: 'pack_100',  tokens: 100,  price: 1.00,  label: '100 Tokens',   bonus: null,   savings: null },
  { id: 'pack_500',  tokens: 500,  price: 4.50,  label: '500 Tokens',   bonus: null,   savings: '10%' },
  { id: 'pack_1000', tokens: 1000, price: 8.00,  label: '1,000 Tokens', bonus: 50,     savings: '20%' },
  { id: 'pack_5000', tokens: 5000, price: 35.00, label: '5,000 Tokens', bonus: 500,    savings: '30%' },
];

// GET /api/tokens/packages
router.get('/packages', (req, res) => {
  res.json({ success: true, data: TOKEN_PACKAGES });
});

// GET /api/tokens/balance
router.get('/balance', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { data, error } = await supabase
      .from('wallets')
      .select('token_balance, wallet_balance')
      .eq('user_id', userId)
      .single();

    if (error) throw error;
    res.json({
      success: true,
      data: {
        token_balance: data?.token_balance || 0,
        wallet_balance: data?.wallet_balance || 0,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/tokens/purchase
router.post('/purchase', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { packageId } = req.body;

    const pkg = TOKEN_PACKAGES.find(p => p.id === packageId);
    if (!pkg) {
      return res.status(400).json({ success: false, error: 'Invalid token package' });
    }

    const { data: wallet, error: walletError } = await supabase
      .from('wallets')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (walletError || !wallet) {
      return res.status(404).json({ success: false, error: 'Wallet not found' });
    }

    if ((wallet.wallet_balance || 0) < pkg.price) {
      return res.status(400).json({
        success: false,
        error: `Insufficient balance. Need $${pkg.price.toFixed(2)}, have $${(wallet.wallet_balance || 0).toFixed(2)}`,
      });
    }

    const totalTokens = pkg.tokens + (pkg.bonus || 0);
    const reference = `TOK-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const { error: updateError } = await supabase
      .from('wallets')
      .update({
        wallet_balance: (wallet.wallet_balance || 0) - pkg.price,
        token_balance: (wallet.token_balance || 0) + totalTokens,
      })
      .eq('id', wallet.id);

    if (updateError) throw updateError;

    await supabase.from('wallet_transactions').insert([{
      wallet_id: wallet.id,
      type: 'token_purchase',
      amount: -pkg.price,
      description: `Purchased ${pkg.tokens} Bascardo Tokens${pkg.bonus ? ` + ${pkg.bonus} bonus` : ''}`,
      metadata: { package_id: packageId, tokens: totalTokens, reference },
      status: 'completed',
    }]);

    res.json({
      success: true,
      data: {
        tokens_purchased: totalTokens,
        cost: pkg.price,
        new_token_balance: (wallet.token_balance || 0) + totalTokens,
        new_wallet_balance: (wallet.wallet_balance || 0) - pkg.price,
        reference,
      },
      message: `Successfully purchased ${totalTokens} Bascardo Tokens`,
    });
  } catch (error) {
    console.error('Token purchase error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/tokens/history
router.get('/history', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { data: wallet } = await supabase
      .from('wallets')
      .select('id')
      .eq('user_id', userId)
      .single();

    if (!wallet) return res.status(404).json({ success: false, error: 'Wallet not found' });

    const { data, error } = await supabase
      .from('wallet_transactions')
      .select('*')
      .eq('wallet_id', wallet.id)
      .in('type', ['token_purchase', 'token_spend', 'token_reward'])
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
