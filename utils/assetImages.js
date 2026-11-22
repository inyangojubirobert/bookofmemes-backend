// Smart upload for the Video Studio cast library: nothing reaches the engine
// as a whole picture. The app sends the picture and the part to keep; the
// server cuts that part out on our Cloudinary and, if asked, removes the
// background (Runware removeBackground, ideogram:remove-background@0,
// $0.01 a picture). The cleaned picture is what the asset keeps.
import crypto from 'crypto';
import { v2 as cloudinary } from 'cloudinary';
import { callRunwareTasks } from './runwareClient.js';

cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET });

export const BACKGROUND_MODEL = process.env.RUNWARE_BACKGROUND_MODEL || 'ideogram:remove-background@0';
const FOLDER = 'bookofmemes/video-cast';
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0));

/**
 * crop: { x, y, w, h } as fractions (0–1) of the picture, or null for the whole picture.
 * Returns { url, width, height, publicId, cost } — cost is Runware's, when the background was removed.
 */
export async function prepareAssetImage(sourceUrl, { crop = null, removeBackground = false } = {}) {
  const up = await cloudinary.uploader.upload(sourceUrl, { folder: FOLDER, resource_type: 'image' });
  let url = up.secure_url;
  let width = up.width;
  let height = up.height;
  if (crop) {
    const x = clamp(crop.x, 0, 0.98);
    const y = clamp(crop.y, 0, 0.98);
    const w = clamp(crop.w, 0.02, 1 - x);
    const h = clamp(crop.h, 0.02, 1 - y);
    width = Math.max(16, Math.round(w * up.width));
    height = Math.max(16, Math.round(h * up.height));
    url = cloudinary.url(up.public_id, {
      secure: true, format: 'png',
      transformation: [{ crop: 'crop', x: Math.round(x * up.width), y: Math.round(y * up.height), width, height }, { crop: 'limit', width: 1536, height: 1536 }],
    });
  }
  let cost = null;
  let publicId = up.public_id;
  if (removeBackground) {
    const { data } = await callRunwareTasks([{
      taskType: 'removeBackground', taskUUID: crypto.randomUUID(), model: BACKGROUND_MODEL,
      inputs: { image: url }, outputFormat: 'PNG', outputType: 'URL', includeCost: true,
    }]);
    const r = data?.[0];
    if (!r?.imageURL) throw Object.assign(new Error('The background could not be removed.'), { status: 502 });
    cost = r.cost ?? null;
    // Runware links don't last; keep our own copy.
    const kept = await cloudinary.uploader.upload(r.imageURL, { folder: FOLDER, resource_type: 'image', format: 'png' });
    // Nothing left (no clear subject, e.g. a room): an all-transparent PNG
    // compresses to almost nothing. Fail as a 400 so the credits are released.
    if (kept.bytes < kept.width * kept.height * 0.03) {
      cloudinary.uploader.destroy(kept.public_id).catch(() => {});
      throw Object.assign(new Error('Removing the background left nothing — this picture has no single subject. Untick "Remove the background" and save again.'), { status: 400 });
    }
    url = kept.secure_url; width = kept.width; height = kept.height; publicId = kept.public_id;
  }
  return { url, width, height, publicId, cost };
}
