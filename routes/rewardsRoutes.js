import express from 'express';
import { supabase } from '../config/db.js';
import { authenticateToken } from '../auth.js';

const router = express.Router();

// GET /api/rewards - all rewards summary
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const [achievements, badges, level, streaks] = await Promise.all([
      supabase
        .from('user_achievements')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false }),
      supabase
        .from('user_badges')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false }),
      supabase
        .from('user_levels')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle(),
      supabase
        .from('user_streaks')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle(),
    ]);

    res.json({
      success: true,
      data: {
        achievements: achievements.data || [],
        badges: badges.data || [],
        level: level.data || null,
        streaks: streaks.data || null,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
