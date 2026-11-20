// Bascardo Gallery (migration 072): every picture, video and audio a user
// makes with Bascardo AI is saved here so they can reuse it later (as a
// reference picture, a video's start frame, a post's image or cover).
//
// Provider links (Runware) are not permanent, so anything not already on our
// Cloudinary is copied there first (Cloudinary fetches it itself; nothing
// passes through this server). Saving is best-effort: it never fails or
// slows the generation the user is waiting for.
import { v2 as cloudinary } from 'cloudinary';
import { supabase } from '../config/db.js';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

export const isOurCloudinary = (url) =>
  typeof url === 'string' && url.startsWith(`https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/`);

async function keepCopy(url, kind) {
  if (isOurCloudinary(url)) return url;
  const up = await cloudinary.uploader.upload(url, {
    resource_type: kind === 'image' ? 'image' : 'video', // Cloudinary stores audio as "video"
    folder: 'bookofmemes/gallery',
  });
  return up.secure_url;
}

/**
 * Fire-and-forget: saveToGallery({ userId, kind, url, feature, prompt, model, durationSeconds,
 *   projectKind, projectId, role, provider, providerCost, credits, width, height, jobId }).
 * The project/cost fields need migration 073; without it they're dropped and the asset is still saved.
 */
export function saveToGallery({
  userId, kind, url, feature, prompt = null, model = null, durationSeconds = null, source = 'ai',
  projectKind = null, projectId = null, role = null, provider = null, providerCost = null, credits = null, width = null, height = null, jobId = null,
}) {
  if (!userId || !url || !/^https:\/\//.test(url)) return;
  (async () => {
    let stored = url;
    try { stored = await keepCopy(url, kind); } catch (err) { console.warn('[gallery] copy failed, keeping provider link:', err.message); }
    const base = {
      user_id: userId, kind, url: stored, source, feature,
      prompt: prompt ? String(prompt).slice(0, 1000) : null, model,
      duration_seconds: durationSeconds ? Math.round(durationSeconds) : null,
    };
    const extra = Object.fromEntries(Object.entries({
      project_kind: projectKind, project_id: projectId, role, provider, provider_cost: providerCost, credits, width, height, job_id: jobId,
    }).filter(([, v]) => v !== null && v !== undefined));
    let { error } = await supabase.from('gallery_assets').upsert({ ...base, ...extra }, { onConflict: 'user_id,url', ignoreDuplicates: true });
    if (error && Object.keys(extra).length && /column|schema cache|PGRST204/i.test(error.message)) {
      ({ error } = await supabase.from('gallery_assets').upsert(base, { onConflict: 'user_id,url', ignoreDuplicates: true }));
    }
    if (error) console.warn('[gallery] save failed:', error.message);
  })().catch((err) => console.warn('[gallery] save failed:', err.message));
}
