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

/** Fire-and-forget: saveToGallery({ userId, kind, url, feature, prompt, model, durationSeconds }). */
export function saveToGallery({ userId, kind, url, feature, prompt = null, model = null, durationSeconds = null, source = 'ai' }) {
  if (!userId || !url || !/^https:\/\//.test(url)) return;
  (async () => {
    let stored = url;
    try { stored = await keepCopy(url, kind); } catch (err) { console.warn('[gallery] copy failed, keeping provider link:', err.message); }
    const { error } = await supabase.from('gallery_assets').upsert({
      user_id: userId, kind, url: stored, source, feature,
      prompt: prompt ? String(prompt).slice(0, 1000) : null, model,
      duration_seconds: durationSeconds ? Math.round(durationSeconds) : null,
    }, { onConflict: 'user_id,url', ignoreDuplicates: true });
    if (error) console.warn('[gallery] save failed:', error.message);
  })().catch((err) => console.warn('[gallery] save failed:', err.message));
}
