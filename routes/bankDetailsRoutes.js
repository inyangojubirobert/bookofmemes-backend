import express from 'express';
import { supabase } from "../config/db.js";
import { authenticateToken } from '../auth.js';

const router = express.Router();

/**
 * @route   GET /api/bank-details
 * @desc    Get bank details for authenticated user
 * @access  Private
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const { data, error } = await supabase
      .from('bank_details')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw error;

    // Mask account number for security
    if (data?.account_number) {
      data.masked_account_number = `****${data.account_number.slice(-4)}`;
    }

    res.json({
      success: true,
      data: data || null,
      message: data ? 'Bank details retrieved' : 'No bank details found'
    });
  } catch (error) {
    console.error('Error fetching bank details:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to fetch bank details'
    });
  }
});

/**
 * @route   POST /api/bank-details
 * @desc    Create or update bank details
 * @access  Private
 */
router.post('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { account_name, account_number, bank_name, bank_code, branch } = req.body;

    // Validate input
    if (!account_name || !account_number || !bank_name) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: account_name, account_number, bank_name'
      });
    }

    // Validate account number (10 digits)
    if (!/^\d{10}$/.test(account_number)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid account number. Must be 10 digits'
      });
    }

    // Save bank details
    const { data, error } = await supabase
      .from('bank_details')
      .upsert({
        user_id: userId,
        account_name,
        account_number,
        bank_name,
        bank_code: bank_code || null,
        branch: branch || null,
        updated_at: new Date()
      }, {
        onConflict: 'user_id'
      })
      .select()
      .single();

    if (error) throw error;

    // Return masked data
    res.status(201).json({
      success: true,
      data: {
        ...data,
        masked_account_number: `****${data.account_number.slice(-4)}`
      },
      message: 'Bank details saved successfully'
    });
  } catch (error) {
    console.error('Error saving bank details:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to save bank details'
    });
  }
});

/**
 * @route   DELETE /api/bank-details
 * @desc    Delete bank details
 * @access  Private
 */
router.delete('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const { error } = await supabase
      .from('bank_details')
      .delete()
      .eq('user_id', userId);

    if (error) throw error;

    res.json({
      success: true,
      message: 'Bank details deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting bank details:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to delete bank details'
    });
  }
});

/**
 * @route   POST /api/bank-details/verify
 * @desc    Verify bank account (basic validation)
 * @access  Private
 */
router.post('/verify', authenticateToken, async (req, res) => {
  try {
    const { account_number, bank_code } = req.body;

    if (!account_number) {
      return res.status(400).json({
        success: false,
        error: 'Account number is required'
      });
    }

    // Basic validation
    const isValid = /^\d{10}$/.test(account_number);

    res.json({
      success: isValid,
      message: isValid ? 'Account number is valid' : 'Invalid account number'
    });
  } catch (error) {
    console.error('Error verifying account:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to verify account'
    });
  }
});

export default router;