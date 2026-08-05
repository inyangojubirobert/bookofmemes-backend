import express from 'express';
import { supabase } from '../config/db.js';
import { authenticateToken } from '../auth.js';

const router = express.Router();

// GET /api/transfers/lookup/:walletId  — look up a wallet by ID for the send flow
router.get('/lookup/:walletId', authenticateToken, async (req, res) => {
  try {
    const { walletId } = req.params;
    const { data, error } = await supabase
      .from('wallets')
      .select('id, user_id, profiles:user_id(full_name, avatar_url)')
      .eq('id', walletId)
      .single();

    if (error || !data) {
      return res.status(404).json({ success: false, error: 'Wallet not found' });
    }
    res.json({ success: true, data });
  } catch (error) {
    console.error('Wallet lookup error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/transfers/history
router.get('/history', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { type } = req.query; // 'sent' | 'received' | undefined (all)

    const { data: wallet, error: walletError } = await supabase
      .from('wallets')
      .select('id')
      .eq('user_id', userId)
      .single();

    if (walletError || !wallet) {
      return res.status(404).json({ success: false, error: 'Wallet not found' });
    }

    let query = supabase
      .from('p2p_transfers')
      .select(`
        *,
        sender_wallet:sender_wallet_id (id, user_id, profiles:user_id(full_name, avatar_url)),
        receiver_wallet:receiver_wallet_id (id, user_id, profiles:user_id(full_name, avatar_url))
      `)
      .order('created_at', { ascending: false });

    if (type === 'sent') {
      query = query.eq('sender_wallet_id', wallet.id);
    } else if (type === 'received') {
      query = query.eq('receiver_wallet_id', wallet.id);
    } else {
      query = query.or(`sender_wallet_id.eq.${wallet.id},receiver_wallet_id.eq.${wallet.id}`);
    }

    const { data, error } = await query;
    if (error) throw error;

    const tagged = (data || []).map(t => ({
      ...t,
      direction: t.sender_wallet_id === wallet.id ? 'sent' : 'received',
    }));

    res.json({ success: true, data: tagged });
  } catch (error) {
    console.error('Transfer history error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/transfers
router.post('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { toWalletId, amount, currency = 'USD', note } = req.body;

    if (!toWalletId || !amount) {
      return res.status(400).json({ success: false, error: 'Missing toWalletId or amount' });
    }

    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      return res.status(400).json({ success: false, error: 'Amount must be greater than 0' });
    }

    const { data: senderWallet, error: senderError } = await supabase
      .from('wallets')
      .select('id')
      .eq('user_id', userId)
      .single();

    if (senderError || !senderWallet) {
      return res.status(404).json({ success: false, error: 'Sender wallet not found' });
    }

    if (senderWallet.id === toWalletId) {
      return res.status(400).json({ success: false, error: 'Cannot transfer to your own wallet' });
    }

    // Check balance — prefer wallet_currencies, fall back to wallets.wallet_balance for USD
    const { data: senderCurrency } = await supabase
      .from('wallet_currencies')
      .select('balance')
      .eq('wallet_id', senderWallet.id)
      .eq('currency_code', currency)
      .maybeSingle();

    let senderBalance;
    if (senderCurrency) {
      senderBalance = Number(senderCurrency.balance);
    } else if (currency === 'USD') {
      const { data: walletRow } = await supabase
        .from('wallets')
        .select('wallet_balance')
        .eq('id', senderWallet.id)
        .single();
      senderBalance = Number(walletRow?.wallet_balance || 0);
    } else {
      return res.status(400).json({ success: false, error: `No ${currency} balance found` });
    }

    if (senderBalance < numAmount) {
      return res.status(400).json({ success: false, error: 'Insufficient balance' });
    }

    const { data: receiverWallet, error: receiverError } = await supabase
      .from('wallets')
      .select('id')
      .eq('id', toWalletId)
      .single();

    if (receiverError || !receiverWallet) {
      return res.status(404).json({ success: false, error: 'Recipient wallet not found' });
    }

    const reference = `TRF-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

    const { data: transfer, error: transferError } = await supabase
      .from('p2p_transfers')
      .insert({
        sender_wallet_id: senderWallet.id,
        receiver_wallet_id: toWalletId,
        amount: numAmount,
        currency,
        reference,
        note: note || null,
        status: 'completed',
      })
      .select()
      .single();

    if (transferError) throw transferError;

    // Debit sender — use wallet_currencies row if it exists, else update wallets.wallet_balance
    if (senderCurrency) {
      await supabase
        .from('wallet_currencies')
        .update({ balance: senderBalance - numAmount, updated_at: new Date().toISOString() })
        .eq('wallet_id', senderWallet.id)
        .eq('currency_code', currency);
    } else {
      await supabase
        .from('wallets')
        .update({ wallet_balance: senderBalance - numAmount })
        .eq('id', senderWallet.id);
    }

    // Credit receiver's currency balance (create the row if they don't have this currency yet)
    const { data: receiverCurrency } = await supabase
      .from('wallet_currencies')
      .select('balance')
      .eq('wallet_id', receiverWallet.id)
      .eq('currency_code', currency)
      .maybeSingle();

    if (receiverCurrency) {
      await supabase
        .from('wallet_currencies')
        .update({ balance: Number(receiverCurrency.balance) + numAmount, updated_at: new Date().toISOString() })
        .eq('wallet_id', receiverWallet.id)
        .eq('currency_code', currency);
    } else {
      await supabase
        .from('wallet_currencies')
        .insert({ wallet_id: receiverWallet.id, currency_code: currency, balance: numAmount, is_primary: false });
    }

    // Log transactions for both wallets
    await supabase.from('wallet_transactions').insert([
      {
        wallet_id: senderWallet.id,
        currency_code: currency,
        type: 'transfer_out',
        amount: -numAmount,
        description: `Transfer to wallet ···${toWalletId.slice(-8)}`,
        metadata: { reference, to_wallet_id: toWalletId },
        status: 'completed',
      },
      {
        wallet_id: receiverWallet.id,
        currency_code: currency,
        type: 'transfer_in',
        amount: numAmount,
        description: `Transfer from wallet ···${senderWallet.id.slice(-8)}`,
        metadata: { reference, from_wallet_id: senderWallet.id },
        status: 'completed',
      },
    ]);

    res.status(201).json({
      success: true,
      data: transfer,
      message: 'Transfer completed successfully',
    });
  } catch (error) {
    console.error('Transfer error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
