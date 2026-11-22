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
  const at = new Date().toISOString();
  await supabase.from('video_shots').update({ clip_url: videoUrl, clip_public_id: publicId, status: 'ready', source: 'ai', updated_at: at }).eq('id', shotId);
  // Non-destructive (migration 079): keep every version with what made it.
  // Before 079 the column doesn't exist; then this step is simply skipped.
  try {
    const { data: s, error } = await supabase.from('video_shots').select('clip_history').eq('id', shotId).single();
    if (!error) {
      const entry = { url: videoUrl, public_id: publicId, prompt: job.input?.prompt || null, references: job.input?.referenceImages || (job.input?.referenceImageUrl ? [job.input.referenceImageUrl] : []), credits: job.credits, model: job.input?.premium ? 'premium' : 'fast', job_id: job.id, at };
      await supabase.from('video_shots').update({ clip_history: [...(s.clip_history || []), entry].slice(-20) }).eq('id', shotId);
    }
  } catch (err) { console.warn('[video] clip history:', err.message); }
  if (job.project_id) await supabase.from('video_projects').update({ status: 'shooting', updated_at: new Date().toISOString() }).eq('id', job.project_id);
}

export async function shotClipFailed(job) {
  const shotId = job.input?.shot_id;
  if (!shotId) return;
  await supabase.from('video_shots').update({ status: 'failed', updated_at: new Date().toISOString() }).eq('id', shotId).eq('job_id', job.id);
}
