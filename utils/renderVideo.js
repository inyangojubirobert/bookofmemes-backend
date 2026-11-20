// Joins a video project's clips (and voice-over / music) into one MP4.
// Cloudinary first (measured 2026-11-20: two clips of different sizes joined
// into one 10.87 s MP4 in 4 s), behind this one function so an ffmpeg worker
// could replace it later without touching the routes.
import { v2 as cloudinary } from 'cloudinary';

cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET });

const SIZE = { width: 1280, height: 720, crop: 'fill' };
const layerId = (publicId) => publicId.replace(/\//g, ':');

/** Puts a clip or audio file on our Cloudinary (if it isn't) and returns its public id. */
export async function ensureOnCloudinary(url, folder = 'bookofmemes/video-studio') {
  const m = String(url).match(new RegExp(`res\\.cloudinary\\.com/${process.env.CLOUDINARY_CLOUD_NAME}/video/upload/(?:[^/]+/)*?(?:v\\d+/)(.+?)\\.[a-z0-9]+$`, 'i'));
  if (m) return m[1];
  const up = await cloudinary.uploader.upload(url, { resource_type: 'video', folder });
  return up.public_id;
}

/**
 * clips: [{ publicId, trimStart, trimEnd }] in order; voiceover/music: public ids or null.
 * Returns { url, seconds, publicId }.
 */
export async function renderVideo({ clips, voiceover = null, music = null, folder = 'bookofmemes/video-studio/renders' }) {
  if (!clips.length) throw Object.assign(new Error('Add at least one ready clip first.'), { status: 400 });
  const trim = (c) => ({ ...(c.trimStart ? { start_offset: c.trimStart } : {}), ...(c.trimEnd ? { end_offset: c.trimEnd } : {}) });
  const t = [{ ...SIZE, ...trim(clips[0]) }];
  for (const c of clips.slice(1)) {
    t.push({ overlay: `video:${layerId(c.publicId)}`, flags: 'splice', ...SIZE, ...trim(c) });
    t.push({ flags: 'layer_apply' });
  }
  if (voiceover) { t.push({ overlay: `audio:${layerId(voiceover)}` }); t.push({ flags: 'layer_apply' }); }
  if (music) { t.push({ overlay: `audio:${layerId(music)}`, effect: 'volume:-70' }); t.push({ flags: 'layer_apply' }); }
  const url = cloudinary.url(clips[0].publicId, { resource_type: 'video', format: 'mp4', transformation: t });

  // Cloudinary builds the joined video on first request (423 = still building).
  let r = await fetch(url);
  for (let i = 0; r.status === 423 && i < 40; i++) { await new Promise((x) => setTimeout(x, 4000)); r = await fetch(url); }
  if (!r.ok) throw new Error(`Joining the clips failed (${r.status}: ${r.headers.get('x-cld-error') || 'no detail'})`);
  const up = await cloudinary.uploader.upload(url, { resource_type: 'video', folder });
  return { url: up.secure_url, seconds: up.duration, publicId: up.public_id };
}
