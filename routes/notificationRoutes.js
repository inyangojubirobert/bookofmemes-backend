// In-app notifications inbox. Rows are written by the database (market_notify,
// leadership games, ads review, deposits...) and by routes; this lets the app
// read them and mark them read. Served with the service key so it works
// whatever RLS the notifications table has.
import express from 'express';
import { supabase } from '../config/db.js';
import { authenticateToken } from '../auth.js';
import { searchText, ilikeAny } from '../utils/searchText.js';

const router = express.Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/notifications?before=<iso>&limit=30 -> { items, unread }
router.get('/', authenticateToken, async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
    let q = supabase.from('notifications').select('*') // includes data (087) when it exists
      .eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(limit);
    if (req.query.before && !Number.isNaN(Date.parse(req.query.before))) q = q.lt('created_at', new Date(req.query.before).toISOString());
    const text = searchText(req.query.q); // ?q= words in the title or text
    if (text) q = q.or(ilikeAny(text, ['title', 'body']));
    const [{ data, error }, { count, error: cErr }] = await Promise.all([
      q,
      supabase.from('notifications').select('id', { count: 'exact', head: true }).eq('user_id', req.user.id).eq('is_read', false),
    ]);
    if (error || cErr) throw error || cErr;
    res.json({ success: true, data: { items: data || [], unread: count || 0 } });
  } catch (err) {
    console.error('notifications list:', err.message);
    res.status(500).json({ success: false, error: 'Could not load notifications' });
  }
});

// GET /api/notifications/unread -> { unread }
router.get('/unread', authenticateToken, async (req, res) => {
  const { count, error } = await supabase.from('notifications').select('id', { count: 'exact', head: true })
    .eq('user_id', req.user.id).eq('is_read', false);
  if (error) return res.status(500).json({ success: false, error: 'Could not load notifications' });
  res.json({ success: true, data: { unread: count || 0 } });
});

// POST /api/notifications/read { ids?: uuid[] } -> marks those (or all) read
router.post('/read', authenticateToken, async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((x) => UUID.test(String(x))).slice(0, 200) : null;
    let q = supabase.from('notifications').update({ is_read: true }).eq('user_id', req.user.id).eq('is_read', false);
    if (ids) {
      if (!ids.length) return res.json({ success: true });
      q = q.in('id', ids);
    }
    const { error } = await q;
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('notifications read:', err.message);
    res.status(500).json({ success: false, error: 'Could not update notifications' });
  }
});

export default router;
