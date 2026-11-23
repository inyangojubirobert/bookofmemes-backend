// Colour looks + grades as 3D LUTs (.3dl) on Cloudinary. A look (cinematic,
// noir, blue screen…) at a strength, followed by the user's fine grade
// (warmth, tint, hue, brightness, contrast, saturation), is baked into ONE
// 17-point 12-bit cube, uploaded once as a raw file (its name is a hash of the
// settings), and applied to a video with l_lut:<id>. Verified 2026-11-23 on a
// real clip: LUT on frames and on MP4, together with trim and crop.
import os from 'os';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { v2 as cloudinary } from 'cloudinary';
import { LOOKS, LOOK_STRENGTHS, gradeFn, cleanGrade } from '../config/soundStudio.js';

cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET });

const VERSION = 'v1'; // bump when a formula changes
const N = 17;
const ready = new Map(); // publicId → Promise<overlay>

/** null when nothing changes the picture. */
export function colourKey({ look = null, strength = 'full', grade = null } = {}) {
  const l = LOOKS[look] ? look : null;
  const g = cleanGrade(grade);
  if (!l && !g) return null;
  const s = LOOK_STRENGTHS[strength] ? strength : 'full';
  const gs = g ? Object.entries(g).map(([k, v]) => `${k[0]}${v}`).join('') : '';
  const name = `${l || 'none'}_${l ? s : ''}${gs ? `_${crypto.createHash('md5').update(gs).digest('hex').slice(0, 8)}` : ''}`;
  return { look: l, strength: s, grade: g, publicId: `bookofmemes/luts/${VERSION}_${name}.3dl` };
}

export function lutText({ look, strength, grade }) {
  const fn = look ? LOOKS[look].fn : null;
  const k = LOOK_STRENGTHS[strength] ?? 1;
  const after = grade ? gradeFn(grade) : null;
  const lines = [Array.from({ length: N }, (_, i) => Math.round((i * 1023) / (N - 1))).join(' ')];
  for (let r = 0; r < N; r++) for (let g = 0; g < N; g++) for (let b = 0; b < N; b++) {
    const src = [r / (N - 1), g / (N - 1), b / (N - 1)];
    let out = src;
    if (fn) { const o = fn(...src); out = src.map((v, i) => v + (o[i] - v) * k); }
    if (after) out = after(...out);
    lines.push(out.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 4095)).join(' '));
  }
  return `${lines.join('\n')}\n`;
}

/** Makes sure the LUT is on Cloudinary; returns the overlay ('lut:…') or null when there's no colour change. */
export function ensureColour(settings) {
  const key = colourKey(settings);
  if (!key) return Promise.resolve(null);
  if (!ready.has(key.publicId)) {
    const p = (async () => {
      const file = path.join(os.tmpdir(), path.basename(key.publicId));
      fs.writeFileSync(file, lutText(key));
      try { await cloudinary.uploader.upload(file, { resource_type: 'raw', public_id: key.publicId, overwrite: false }); }
      finally { fs.rmSync(file, { force: true }); }
      return `lut:${key.publicId.replace(/\//g, ':')}`;
    })();
    p.catch(() => ready.delete(key.publicId));
    ready.set(key.publicId, p);
  }
  return ready.get(key.publicId);
}
