import express from 'express';
import { supabase } from '../config/db.js';
import { authenticateToken } from '../auth.js';

const router = express.Router();

// GET /api/affiliates/referrals
router.get('/referrals', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { data, error } = await supabase
      .from('invites')
      .select('*')
      .eq('sender_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/affiliates/summary
router.get('/summary', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { data, error } = await supabase
      .from('invites')
      .select('id, used, commission')
      .eq('sender_id', userId);

    if (error) throw error;

    const total = data?.length || 0;
    const used = data?.filter(i => i.used).length || 0;
    const totalCommission = data?.reduce((sum, i) => sum + (i.commission || 0), 0) || 0;

    res.json({
      success: true,
      data: {
        total_invites: total,
        used_invites: used,
        pending_invites: total - used,
        total_commission: totalCommission,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
