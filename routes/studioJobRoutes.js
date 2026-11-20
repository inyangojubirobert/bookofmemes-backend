// Background jobs, for the app to follow (utils/studioJobs.js, migration 073).
//   GET /api/studio/jobs/:id                          one job
//   GET /api/studio/jobs?project_kind=&project_id=    a project's jobs (or my latest 30)
import express from 'express';
import { supabase } from '../config/db.js';
import { authenticateToken } from '../auth.js';
import { getJob, publicJob } from '../utils/studioJobs.js';

const router = express.Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get('/jobs/:id', authenticateToken, async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(404).json({ success: false, error: 'Not found' });
  const job = await getJob(req.params.id, req.user.id);
  if (!job) return res.status(404).json({ success: false, error: 'Not found' });
  res.json({ success: true, data: publicJob(job) });
});

router.get('/jobs', authenticateToken, async (req, res) => {
  let q = supabase.from('studio_jobs').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(30);
  if (req.query.project_kind) q = q.eq('project_kind', String(req.query.project_kind).slice(0, 20));
  if (UUID.test(String(req.query.project_id || ''))) q = q.eq('project_id', req.query.project_id);
  if (req.query.active === '1') q = q.in('status', ['queued', 'running']);
  const { data, error } = await q;
  if (error) return res.status(500).json({ success: false, error: 'Could not load your jobs' });
  res.json({ success: true, data: (data || []).map(publicJob) });
});

export default router;
