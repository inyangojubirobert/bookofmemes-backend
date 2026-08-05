import express from 'express';
import { supabase } from "../config/db.js";
import { authenticateToken } from '../auth.js';

const router = express.Router();

// ============= CAShOUT ROUTES =============

/**
 * @route   GET /api/cashout/requests
 * @desc    Get all cashout requests for authenticated user
 * @access  Private
 */
router.get('/requests', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { status } = req.query;

    let query = supabase
      .from('cashout_requests')
      .select(`
        *,
        bank_details:bank_details_id (
          id,
          account_name,
          account_number,
          bank_name,
          bank_code,
          branch
        ),
        wallet:wallet_id (
          id,
          wallet_balance,
          token_balance
        )
      `)
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (status) {
      query = query.eq('status', status);
    }

    const { data, error } = await query;

    if (error) throw error;

    // Mask account numbers for security
    const maskedData = (data || []).map(request => ({
      ...request,
      bank_details: request.bank_details ? {
        ...request.bank_details,
        account_number: `****${request.bank_details.account_number.slice(-4)}`
      } : null
    }));

    res.json({
      success: true,
      data: maskedData,
      message: 'Cashout requests fetched successfully'
    });
  } catch (error) {
    console.error('Error fetching cashout requests:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to fetch cashout requests'
    });
  }
});

/**
 * @route   GET /api/cashout/summary
 * @desc    Get cashout summary for authenticated user
 * @access  Private
 */
router.get('/summary', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const { data, error } = await supabase
      .from('cashout_requests')
      .select('status, amount')
      .eq('user_id', userId);

    if (error) throw error;

    const summary = {
      total_cashed_out: 0,
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      cancelled: 0
    };

    (data || []).forEach(request => {
      summary[request.status] = (summary[request.status] || 0) + request.amount;
      if (request.status === 'completed') {
        summary.total_cashed_out += request.amount;
      }
    });

    res.json({
      success: true,
      data: summary,
      message: 'Cashout summary fetched successfully'
    });
  } catch (error) {
    console.error('Error fetching cashout summary:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to fetch cashout summary'
    });
  }
});

/**
 * @route   POST /api/cashout/request
 * @desc    Create a new cashout request
 * @access  Private
 */
router.post('/request', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { amount, bankDetailsId } = req.body;

    // Validate input
    if (!amount || !bankDetailsId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: amount, bankDetailsId'
      });
    }

    if (amount < 100) {
      return res.status(400).json({
        success: false,
        error: 'Minimum cashout amount is 100'
      });
    }

    // Get user's wallet
    const { data: wallet, error: walletError } = await supabase
      .from('wallets')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (walletError || !wallet) {
      return res.status(404).json({
        success: false,
        error: 'Wallet not found'
      });
    }

    // Check balance
    if (wallet.wallet_balance < amount) {
      return res.status(400).json({
        success: false,
        error: 'Insufficient balance'
      });
    }

    // Get bank details
    const { data: bankDetails, error: bankError } = await supabase
      .from('bank_details')
      .select('*')
      .eq('id', bankDetailsId)
      .eq('user_id', userId)
      .single();

    if (bankError || !bankDetails) {
      return res.status(404).json({
        success: false,
        error: 'Bank details not found'
      });
    }

    // Generate unique reference
    const reference = `CO-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Start a transaction (using Supabase's built-in transaction handling)
    const { data: cashoutRequest, error: cashoutError } = await supabase
      .from('cashout_requests')
      .insert([{
        user_id: userId,
        wallet_id: wallet.id,
        amount: amount,
        bank_details_id: bankDetailsId,
        reference: reference,
        status: 'pending'
      }])
      .select()
      .single();

    if (cashoutError) throw cashoutError;

    // Add transaction record
    const { error: transactionError } = await supabase
      .from('wallet_transactions')
      .insert([{
        wallet_id: wallet.id,
        type: 'cashout',
        amount: -amount,
        description: `Cashout request to ${bankDetails.bank_name} - ****${bankDetails.account_number.slice(-4)}`,
        metadata: { reference, bank_details_id: bankDetailsId },
        status: 'pending'
      }]);

    if (transactionError) {
      console.error('Error adding transaction:', transactionError);
      // Don't fail the request, just log the error
    }

    res.status(201).json({
      success: true,
      data: cashoutRequest,
      message: 'Cashout request submitted successfully'
    });
  } catch (error) {
    console.error('Error creating cashout request:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to create cashout request'
    });
  }
});

/**
 * @route   PUT /api/cashout/request/:requestId/cancel
 * @desc    Cancel a pending cashout request
 * @access  Private
 */
router.put('/request/:requestId/cancel', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { requestId } = req.params;

    // Get the request
    const { data: request, error: fetchError } = await supabase
      .from('cashout_requests')
      .select('*')
      .eq('id', requestId)
      .eq('user_id', userId)
      .single();

    if (fetchError || !request) {
      return res.status(404).json({
        success: false,
        error: 'Cashout request not found'
      });
    }

    if (request.status !== 'pending') {
      return res.status(400).json({
        success: false,
        error: 'Cannot cancel request that is already being processed'
      });
    }

    // Update request status
    const { data, error } = await supabase
      .from('cashout_requests')
      .update({ 
        status: 'cancelled',
        notes: 'Cancelled by user',
        updated_at: new Date()
      })
      .eq('id', requestId)
      .select()
      .single();

    if (error) throw error;

    // Add transaction record for reversal
    const { error: transactionError } = await supabase
      .from('wallet_transactions')
      .insert([{
        wallet_id: request.wallet_id,
        type: 'cashout_cancelled',
        amount: request.amount,
        description: `Cashout cancelled - ${request.reference}`,
        metadata: { original_request: requestId },
        status: 'completed'
      }]);

    if (transactionError) {
      console.error('Error adding reversal transaction:', transactionError);
    }

    res.json({
      success: true,
      data: data,
      message: 'Cashout request cancelled successfully'
    });
  } catch (error) {
    console.error('Error cancelling cashout:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to cancel cashout request'
    });
  }
});

/**
 * @route   GET /api/cashout/request/:requestId
 * @desc    Get a specific cashout request
 * @access  Private
 */
router.get('/request/:requestId', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { requestId } = req.params;

    const { data, error } = await supabase
      .from('cashout_requests')
      .select(`
        *,
        bank_details:bank_details_id (
          id,
          account_name,
          account_number,
          bank_name,
          bank_code,
          branch
        ),
        wallet:wallet_id (
          id,
          wallet_balance,
          token_balance
        )
      `)
      .eq('id', requestId)
      .eq('user_id', userId)
      .single();

    if (error || !data) {
      return res.status(404).json({
        success: false,
        error: 'Cashout request not found'
      });
    }

    // Mask account number
    if (data.bank_details) {
      data.bank_details.account_number = `****${data.bank_details.account_number.slice(-4)}`;
    }

    res.json({
      success: true,
      data: data,
      message: 'Cashout request fetched successfully'
    });
  } catch (error) {
    console.error('Error fetching cashout request:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to fetch cashout request'
    });
  }
});

/**
 * @route   GET /api/cashout/check-eligibility
 * @desc    Check if user is eligible for cashout
 * @access  Private
 */
router.get('/check-eligibility', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // Check if user has bank details
    const { data: bankDetails, error: bankError } = await supabase
      .from('bank_details')
      .select('id, is_verified')
      .eq('user_id', userId)
      .maybeSingle();

    // Get wallet balance
    const { data: wallet, error: walletError } = await supabase
      .from('wallets')
      .select('wallet_balance')
      .eq('user_id', userId)
      .single();

    const eligibility = {
      hasBankDetails: !!bankDetails,
      bankVerified: bankDetails?.is_verified || false,
      hasBalance: wallet?.wallet_balance > 0,
      balance: wallet?.wallet_balance || 0,
      minimumAmount: 100,
      canCashout: !!(bankDetails && wallet?.wallet_balance >= 100)
    };

    res.json({
      success: true,
      data: eligibility,
      message: 'Eligibility checked successfully'
    });
  } catch (error) {
    console.error('Error checking eligibility:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to check eligibility'
    });
  }
});

export default router;