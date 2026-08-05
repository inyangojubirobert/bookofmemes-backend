import express from 'express';
import { supabase } from "../config/db.js";
import { authenticateToken } from '../auth.js';

const router = express.Router();

router.post('/initialize', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { amount, currency, method } = req.body;

    if (!amount || !currency || !method) {
      return res.status(400).json({ success: false, error: 'Missing amount, currency or method' });
    }

    const { data: wallet } = await supabase
      .from('wallets').select('*').eq('user_id', userId).single();

    if (!wallet) return res.status(404).json({ error: 'Wallet not found' });

    const reference = `DEP-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // For NGN bank transfers use Paystack Pay-with-Transfer to get a real virtual account
    if (method === 'bank_transfer' && currency === 'NGN') {
      const email = req.user.email;
      const amountInKobo = Math.round(amount * 100);

      let paystackAccount = null;
      try {
        const paystackRes = await fetch('https://api.paystack.co/charge', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ email, amount: amountInKobo, currency: 'NGN', bank_transfer: {}, reference }),
        });
        const paystackData = await paystackRes.json();

        if (paystackData.status && paystackData.data) {
          const tx = paystackData.data;
          paystackAccount = {
            account_number: tx.account_number,
            account_name: tx.account_name,
            bank_name: tx.bank_name,
            reference: tx.reference || reference,
          };
        }
      } catch (paystackErr) {
        console.error('Paystack charge call failed:', paystackErr.message);
      }

      const finalReference = paystackAccount?.reference || reference;

      const { data: deposit, error } = await supabase
        .from('deposits')
        .insert([{
          user_id: userId,
          wallet_id: wallet.id,
          amount,
          currency,
          method,
          reference: finalReference,
          status: 'pending',
          metadata: paystackAccount || {},
        }])
        .select().single();

      if (error) throw error;

      return res.json({
        success: true,
        data: {
          deposit,
          bank_transfer: paystackAccount
            ? { ...paystackAccount, amount }
            : null,
        },
      });
    }

    // Non-NGN or non-bank_transfer: save pending deposit with no dynamic account
    const { data: deposit, error } = await supabase
      .from('deposits')
      .insert([{ user_id: userId, wallet_id: wallet.id, amount, currency, method, reference, status: 'pending' }])
      .select().single();

    if (error) throw error;

    res.json({ success: true, data: { deposit, bank_transfer: null } });

  } catch (err) {
    console.error('Initialize deposit error:', err);
    res.status(500).json({ error: err.message });
  }
});
router.post('/verify', authenticateToken, async (req, res) => {
  try {
    const { reference } = req.body;

    if (!reference) {
      return res.status(400).json({ error: 'Missing reference' });
    }

    // Find deposit
    const { data: deposit } = await supabase
      .from('deposits')
      .select('*')
      .eq('reference', reference)
      .single();

    if (!deposit) {
      return res.status(404).json({ error: 'Deposit not found' });
    }

    if (deposit.status === 'completed') {
      return res.json({ success: true, message: 'Already verified' });
    }

    // Verify with Paystack API
    const paystackRes = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
    );
    const paystackData = await paystackRes.json();
    const paymentSuccessful = paystackData?.data?.status === 'success';

    if (!paymentSuccessful) {
      await supabase
        .from('deposits')
        .update({ status: 'failed' })
        .eq('id', deposit.id);

      return res.status(400).json({ error: 'Payment failed' });
    }

    // ✅ CREDIT WALLET -- wallet_balance (USD) is the one ledger marketplace/
    // cashout/token-purchase/transfer all actually spend from. This used to
    // always call credit_wallet_currency, which put USD deposits into the
    // wallet_currencies bucket instead -- money that showed on the Wallet
    // screen but was invisible/unspendable everywhere else (confirmed live:
    // two real wallets had $45 and $55 stuck there; see migration 035's
    // reconciliation). Non-USD still goes to wallet_currencies since there's
    // no live exchange rate data to convert it correctly yet.
    if (deposit.currency === 'USD') {
      const { data: walletRow } = await supabase.from('wallets').select('wallet_balance').eq('id', deposit.wallet_id).single();
      await supabase.from('wallets').update({ wallet_balance: Number(walletRow?.wallet_balance || 0) + Number(deposit.amount) }).eq('id', deposit.wallet_id);
    } else {
      const { error: creditError } = await supabase.rpc('credit_wallet_currency', {
        p_wallet_id: deposit.wallet_id,
        p_currency: deposit.currency,
        p_amount: deposit.amount
      });
      // Don't mark the deposit 'completed' if the credit itself failed -- leaving
      // it 'pending' means a retried /verify call (or the webhook) will attempt
      // the credit again instead of the payment being silently lost.
      if (creditError) {
        console.error('credit_wallet_currency error:', creditError.message);
        return res.status(500).json({ error: 'Payment received but wallet credit failed. Contact support with your reference.', reference });
      }
    }

    // ✅ UPDATE DEPOSIT -- audit trail (migration 035): rate is always 1.0 for
    // USD since no conversion happens; left null for non-USD until real FX exists.
    await supabase
      .from('deposits')
      .update({
        status: 'completed',
        ...(deposit.currency === 'USD' ? { exchange_rate: 1.0, credited_usd_amount: deposit.amount } : {}),
      })
      .eq('id', deposit.id);

    // ✅ LOG TRANSACTION -- currency_code must match what was actually credited
    // above (deposit.currency), not assumed USD. Omitting it here was why a
    // non-USD deposit still displayed with a $ in WalletTransactions.js: that
    // screen defaults a null currency_code to USD for genuinely-legacy rows
    // predating this column, and every row from here landed in that bucket.
    await supabase.from('wallet_transactions').insert([{
      wallet_id: deposit.wallet_id,
      currency_code: deposit.currency,
      type: 'deposit',
      amount: deposit.amount,
      description: `Deposit via ${deposit.method}`,
      metadata: { reference },
      status: 'completed'
    }]);

    // ✅ CREATE NOTIFICATION
    await supabase.from('deposit_notifications').insert([{
      user_id: deposit.user_id,
      deposit_id: deposit.id,
      title: 'Deposit Successful',
      message: `Your deposit of ${deposit.amount} ${deposit.currency} was successful`
    }]);

    res.json({
      success: true,
      message: 'Deposit verified and wallet credited'
    });

  } catch (err) {
    console.error('Verify deposit error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/history', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const { data, error } = await supabase
      .from('deposits')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({
      success: true,
      data
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/notifications', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const { data } = await supabase
      .from('deposit_notifications')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    res.json({ success: true, data });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Pair Device Deposit Requests ─────────────────────────────────────────────

// GET /api/deposits/pair-device/requests
// Returns all pending deposit_requests where the current user's wallet is the recipient
router.get('/pair-device/requests', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const { data: wallet } = await supabase
      .from('wallets').select('id').eq('user_id', userId).single();
    if (!wallet) return res.status(404).json({ error: 'Wallet not found' });

    const { data, error } = await supabase
      .from('deposit_requests')
      .select(`
        id, status, created_at,
        deposit:deposit_id (id, amount, currency, reference),
        from_wallet:from_wallet_id (id, user_id, profiles:user_id (full_name, avatar_url))
      `)
      .eq('to_wallet_id', wallet.id)
      .eq('status', 'pending')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (err) {
    console.error('Pair device requests error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/deposits/pair-device/confirm
// User B confirms: debit User B's wallet, credit User A's wallet, finalize the deposit
router.post('/pair-device/confirm', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { requestId } = req.body;
    if (!requestId) return res.status(400).json({ error: 'Missing requestId' });

    // Get confirmer's wallet (User B)
    const { data: confirmerWallet } = await supabase
      .from('wallets').select('id').eq('user_id', userId).single();
    if (!confirmerWallet) return res.status(404).json({ error: 'Your wallet not found' });

    // Load the deposit request with related data
    const { data: request, error: reqErr } = await supabase
      .from('deposit_requests')
      .select(`
        id, status, from_wallet_id, to_wallet_id,
        deposit:deposit_id (id, amount, currency, user_id)
      `)
      .eq('id', requestId)
      .single();

    if (reqErr || !request) return res.status(404).json({ error: 'Request not found' });
    if (request.to_wallet_id !== confirmerWallet.id) return res.status(403).json({ error: 'Unauthorized' });
    if (request.status !== 'pending') return res.status(400).json({ error: `Request is already ${request.status}` });

    const deposit = request.deposit;
    const amount  = Number(deposit.amount);
    const currency = deposit.currency;
    const requesterWalletId = request.from_wallet_id;

    // ── Check User B's balance ────────────────────────────────────────────────
    // USD always checks/debits wallet_balance -- the one authoritative spendable
    // ledger (see the /verify fix above). This used to check wallet_currencies
    // FIRST even for USD, falling back to wallet_balance only when no
    // wallet_currencies row existed at all -- which breaks the moment
    // reconciliation (migration 035) zeroes an existing USD row out to $0
    // instead of deleting it: a $0 row would still be "found" and used instead
    // of the real wallet_balance, wrongly reporting insufficient funds.
    const isUsd = currency === 'USD';
    const { data: confirmerCurrency } = isUsd
      ? { data: null }
      : await supabase
          .from('wallet_currencies')
          .select('balance')
          .eq('wallet_id', confirmerWallet.id)
          .eq('currency_code', currency)
          .maybeSingle();

    let confirmerBalance;
    if (isUsd) {
      const { data: wRow } = await supabase
        .from('wallets').select('wallet_balance').eq('id', confirmerWallet.id).single();
      confirmerBalance = Number(wRow?.wallet_balance || 0);
    } else if (confirmerCurrency) {
      confirmerBalance = Number(confirmerCurrency.balance);
    } else {
      return res.status(400).json({ error: `You have no ${currency} balance to send` });
    }

    if (confirmerBalance < amount) {
      return res.status(400).json({
        error: `Insufficient balance. You have ${confirmerBalance.toFixed(2)} ${currency} but ${amount.toFixed(2)} ${currency} is required.`
      });
    }

    // ── Debit User B ──────────────────────────────────────────────────────────
    if (isUsd) {
      await supabase
        .from('wallets')
        .update({ wallet_balance: confirmerBalance - amount })
        .eq('id', confirmerWallet.id);
    } else {
      // confirmerCurrency is guaranteed non-null here -- the "no balance to
      // send" check above already returned for the only other case.
      await supabase
        .from('wallet_currencies')
        .update({ balance: confirmerBalance - amount, updated_at: new Date().toISOString() })
        .eq('wallet_id', confirmerWallet.id)
        .eq('currency_code', currency);
    }

    // ── Credit User A ─────────────────────────────────────────────────────────
    // USD goes to wallet_balance -- the ledger marketplace/cashout/token-purchase
    // actually spend from (same fix as the Paystack /verify path above). This used
    // to always credit wallet_currencies even for USD, which is how the two real
    // stuck balances migration 035 reconciles ($45/$55) actually got stuck.
    let requesterBalanceBefore;
    if (currency === 'USD') {
      const { data: requesterWalletRow } = await supabase.from('wallets').select('wallet_balance').eq('id', requesterWalletId).single();
      requesterBalanceBefore = Number(requesterWalletRow?.wallet_balance || 0);
      await supabase.from('wallets').update({ wallet_balance: requesterBalanceBefore + amount }).eq('id', requesterWalletId);
    } else {
      const { data: requesterCurrency } = await supabase
        .from('wallet_currencies')
        .select('balance')
        .eq('wallet_id', requesterWalletId)
        .eq('currency_code', currency)
        .maybeSingle();

      requesterBalanceBefore = Number(requesterCurrency?.balance || 0);
      if (requesterCurrency) {
        await supabase
          .from('wallet_currencies')
          .update({ balance: requesterBalanceBefore + amount, updated_at: new Date().toISOString() })
          .eq('wallet_id', requesterWalletId)
          .eq('currency_code', currency);
      } else {
        await supabase
          .from('wallet_currencies')
          .insert({ wallet_id: requesterWalletId, currency_code: currency, balance: amount, is_primary: false });
      }
    }

    // ── Update statuses ───────────────────────────────────────────────────────
    await supabase.from('deposit_requests').update({ status: 'confirmed' }).eq('id', requestId);
    await supabase.from('deposits').update({ status: 'completed' }).eq('id', deposit.id);

    const pairReference = `PDR-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    // requesterBalanceBefore already captured above (inside the USD/non-USD branch).

    // ── p2p_transfers — capture the inserted ID to use as ledger reference_id ─
    const { data: p2pRecord } = await supabase
      .from('p2p_transfers')
      .insert([{
        sender_wallet_id: confirmerWallet.id,
        receiver_wallet_id: requesterWalletId,
        amount,
        currency,
        reference: pairReference,
        note: `Pair device deposit request ${requestId}`,
        status: 'completed',
      }])
      .select('id')
      .single();

    // ── wallet_transactions (currency_code → currencies.code FK required) ─────
    await supabase.from('wallet_transactions').insert([
      {
        wallet_id: confirmerWallet.id,
        currency_code: currency,
        type: 'transfer_out',
        amount: -amount,
        description: `Pair device deposit to wallet ···${requesterWalletId.slice(-8)}`,
        metadata: { request_id: requestId, reference: pairReference, to_wallet_id: requesterWalletId },
        status: 'completed',
      },
      {
        wallet_id: requesterWalletId,
        currency_code: currency,
        type: 'transfer_in',
        amount,
        description: `Pair device deposit from wallet ···${confirmerWallet.id.slice(-8)}`,
        metadata: { request_id: requestId, reference: pairReference, from_wallet_id: confirmerWallet.id },
        status: 'completed',
      },
    ]);

    // ── wallet_ledger (actual columns from schema) ────────────────────────────
    // transaction_type: text NOT NULL
    // debit / credit:   numeric nullable (only one set per row)
    // balance_before / balance_after: numeric NOT NULL
    // reference_id:     uuid (use p2p_transfers.id)
    const ledgerRef = p2pRecord?.id || null; // UUID or null — both valid per schema
    await supabase.from('wallet_ledger').insert([
      {
        wallet_id: confirmerWallet.id,
        transaction_type: 'pair_device_debit',
        debit: amount,
        credit: null,
        balance_before: confirmerBalance,
        balance_after: confirmerBalance - amount,
        reference_id: ledgerRef,
      },
      {
        wallet_id: requesterWalletId,
        transaction_type: 'pair_device_credit',
        debit: null,
        credit: amount,
        balance_before: requesterBalanceBefore,
        balance_after: requesterBalanceBefore + amount,
        reference_id: ledgerRef,
      },
    ]);

    // ── Notify User A ─────────────────────────────────────────────────────────
    await supabase.from('deposit_notifications').insert([{
      user_id: deposit.user_id,
      deposit_id: deposit.id,
      title: 'Pair Device Deposit Confirmed',
      message: `Your deposit request of ${amount.toFixed(2)} ${currency} was accepted and funds have been transferred to your wallet.`,
    }]);

    res.json({ success: true, message: 'Transfer completed successfully', reference: pairReference });
  } catch (err) {
    console.error('Pair device confirm error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/deposits/pair-device/reject
router.post('/pair-device/reject', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { requestId } = req.body;
    if (!requestId) return res.status(400).json({ error: 'Missing requestId' });

    const { data: wallet } = await supabase
      .from('wallets').select('id').eq('user_id', userId).single();
    if (!wallet) return res.status(404).json({ error: 'Wallet not found' });

    const { data: request } = await supabase
      .from('deposit_requests')
      .select('id, status, to_wallet_id')
      .eq('id', requestId)
      .single();

    if (!request) return res.status(404).json({ error: 'Request not found' });
    if (request.to_wallet_id !== wallet.id) return res.status(403).json({ error: 'Unauthorized' });
    if (request.status !== 'pending') return res.status(400).json({ error: `Request is already ${request.status}` });

    await supabase.from('deposit_requests').update({ status: 'rejected' }).eq('id', requestId);

    res.json({ success: true, message: 'Request declined' });
  } catch (err) {
    console.error('Pair device reject error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;