// Called by the video_clip job (routes/runwareRoutes.js) when a clip made for
// a Video Studio shot finishes or fails, so the shot row is updated even if
// the app is closed.
import { supabase } from '../config/db.js';
import { ensureOnCloudinary } from './renderVideo.js';

export async function shotClipReady(job, videoUrl) {
  const shotId = job.input?.shot_id;
  if (!shotId) return;
  let publicId = null;
  try { publicId = await ensureOnCloudinary(videoUrl); } catch (err) { console.warn('[video] keep clip failed:', err.message); }
  await supabase.from('video_shots').update({ clip_url: videoUrl, clip_public_id: publicId, status: 'ready', source: 'ai', updated_at: new Date().toISOString() }).eq('id', shotId);
  if (job.project_id) await supabase.from('video_projects').update({ status: 'shooting', updated_at: new Date().toISOString() }).eq('id', job.project_id);
}

export async function shotClipFailed(job) {
  const shotId = job.input?.shot_id;
  if (!shotId) return;
  await supabase.from('video_shots').update({ status: 'failed', updated_at: new Date().toISOString() }).eq('id', shotId).eq('job_id', job.id);
}
