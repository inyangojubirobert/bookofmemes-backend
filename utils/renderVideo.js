// Joins a video project's clips, with each shot's edits and every sound, into one MP4.
// Cloudinary does all of it (no ffmpeg on the server):
//
//   1. each shot → an edited clip: trim, crop/zoom, fill to the video's shape,
//      light & colour (look + grade as one 3D LUT, utils/luts.js), vignette,
//      the clip's own sound kept / lowered / muted. Uploaded once and reused
//      while the edit is unchanged (shot.edit_cache), which also gives its
//      exact length for the timeline.
//   2. the edited clips spliced in order; voice lines and sound effects placed
//      at their exact second (layer_apply start_offset, verified 2026-11-23 with
//      a waveform: offsets land to the frame once the sound's own leading
//      silence is cut, utils/audioOnset.js); music under it all, cut to length
//      and faded out.
import crypto from 'crypto';
import { v2 as cloudinary } from 'cloudinary';
import { ASPECTS, cropRect, MUSIC_LEVELS, SFX_LEVELS } from '../config/soundStudio.js';
import { ensureColour } from './luts.js';

cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET });

const layerId = (publicId) => publicId.replace(/\//g, ':');
const CLIP_AUDIO = { keep: null, low: 'volume:-70', mute: 'volume:mute' };

/** Puts a clip or audio file on our Cloudinary (if it isn't) and returns its public id. */
export async function ensureOnCloudinary(url, folder = 'bookofmemes/video-studio') {
  const m = String(url).match(new RegExp(`res\\.cloudinary\\.com/${process.env.CLOUDINARY_CLOUD_NAME}/video/upload/(?:[^/]+/)*?(?:v\\d+/)(.+?)\\.[a-z0-9]+$`, 'i'));
  if (m) return m[1];
  const up = await cloudinary.uploader.upload(url, { resource_type: 'video', folder });
  return up.public_id;
}

async function fetchBuilt(url) {
  let r = await fetch(url, { method: 'HEAD' });
  for (let i = 0; r.status === 423 && i < 45; i++) { await new Promise((x) => setTimeout(x, 4000)); r = await fetch(url, { method: 'HEAD' }); }
  if (!r.ok) throw new Error(`Cloudinary could not build it (${r.status}: ${r.headers.get('x-cld-error') || 'no detail'})`);
}

/** The shot's look/grade: its own, else the video's ("none" = no colour on this shot). */
export function shotColour(shot, project) {
  const e = shot.edit || {};
  const f = project.finish || {};
  if (e.look === 'none') return { look: null, grade: e.grade || null };
  return { look: e.look || f.look || null, strength: e.look ? (e.strength || 'full') : (f.strength || 'full'), grade: e.grade || f.grade || null };
}

/** Transformation (array) for one shot's edited clip. */
export async function shotTransformation(shot, project) {
  const e = shot.edit || {};
  const [width, height] = ASPECTS[project.aspect] || ASPECTS.landscape;
  const t = [];
  const trim = { ...(Number(shot.trim_start) > 0 ? { start_offset: Number(shot.trim_start) } : {}), ...(shot.trim_end ? { end_offset: Number(shot.trim_end) } : {}) };
  if (Object.keys(trim).length) t.push(trim);
  const c = cropRect(e);
  if (c) t.push({ crop: 'crop', x: c.x, y: c.y, width: c.w, height: c.h });
  t.push({ width, height, crop: 'fill' });
  const lut = await ensureColour(shotColour(shot, project));
  if (lut) t.push({ overlay: lut });
  if ((project.finish || {}).vignette) t.push({ effect: 'vignette:35' });
  // Episodes (084): captions from the script, so names are always spelled right; fades between scenes.
  const caption = (project.finish || {}).captions ? captionText(shot) : '';
  if (caption) {
    t.push({ overlay: { font_family: 'Arial', font_size: Math.round(width / 30), font_weight: 'bold', text: caption, text_align: 'center' }, color: 'white', background: 'rgb:00000099', width: Math.round(width * 0.88), crop: 'fit' });
    t.push({ flags: 'layer_apply', gravity: 'south', y: Math.round(height * 0.06) });
  }
  if (e.fade_in) t.push({ effect: 'fade:400' });
  if (e.fade_out) t.push({ effect: 'fade:-400' });
  if (CLIP_AUDIO[e.clip_audio]) t.push({ effect: CLIP_AUDIO[e.clip_audio] });
  return t;
}

/** A playable link of the edited shot (built by Cloudinary on first view; nothing is charged). */
export async function editedPreview(shot, project) {
  if (!shot.clip_public_id) return null;
  const t = await shotTransformation(shot, project);
  return {
    video: cloudinary.url(shot.clip_public_id, { resource_type: 'video', format: 'mp4', secure: true, transformation: t }),
    frame: cloudinary.url(shot.clip_public_id, { resource_type: 'video', format: 'jpg', secure: true, transformation: [...t, { start_offset: Math.max(0.5, Number(shot.trim_start) || 0) + 0.5 }, { width: 480, crop: 'scale' }] }),
  };
}

/** Builds (or reuses) the edited clip. Returns { publicId, seconds, cache }. */
export async function prepareShot(shot, project) {
  const t = await shotTransformation(shot, project);
  const key = crypto.createHash('md5').update(JSON.stringify([shot.clip_public_id, t])).digest('hex');
  if (shot.edit_cache?.key === key && shot.edit_cache.public_id) return { publicId: shot.edit_cache.public_id, seconds: shot.edit_cache.seconds, cache: shot.edit_cache, reused: true };
  const url = cloudinary.url(shot.clip_public_id, { resource_type: 'video', format: 'mp4', transformation: t });
  await fetchBuilt(url);
  const up = await cloudinary.uploader.upload(url, { resource_type: 'video', folder: 'bookofmemes/video-studio/edited' });
  const cache = { key, public_id: up.public_id, seconds: Number(up.duration) || 0, has_audio: !!up.audio?.codec };
  return { publicId: up.public_id, seconds: cache.seconds, cache, reused: false };
}

/** The words shown under a shot: its lines (narration and dialogue), at most ~18 words. */
export function captionText(shot) {
  const text = (shot.lines || []).map((l) => l.text).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const w = text.split(' ');
  return w.length > 18 ? `${w.slice(0, 18).join(' ')}…` : text;
}

const audioLayer = (publicId, { volume = null, leadIn = 0, length = null, fadeOut = 0 } = {}) => {
  const layer = { overlay: `audio:${layerId(publicId)}` };
  const effects = [];
  if (volume !== null && volume !== 0) effects.push({ effect: `volume:${volume}` });
  if (leadIn > 0.05) layer.start_offset = Number(leadIn.toFixed(2));
  if (length) layer.duration = Number(length.toFixed(2));
  if (fadeOut) effects.push({ effect: `fade:-${Math.round(fadeOut * 1000)}` });
  return [layer, ...effects];
};

/**
 * shots: included shots with clip_public_id, in order (each may have edit, voice_*, sfx).
 * project: aspect, finish, music_url/public id, voiceover (legacy single track).
 * Returns { url, seconds, publicId, timeline, caches: { shotId: cache } }.
 */
export async function renderFilm({ shots, project, musicPublicId = null, voiceoverPublicId = null, folder = 'bookofmemes/video-studio/renders' }) {
  if (!shots.length) throw Object.assign(new Error('Add at least one ready clip first.'), { status: 400 });
  const prepared = [];
  for (let i = 0; i < shots.length; i += 3) { // three at a time
    prepared.push(...await Promise.all(shots.slice(i, i + 3).map((s) => prepareShot(s, project))));
  }
  // Timeline: where each shot starts in the finished video.
  let at = 0;
  const timeline = shots.map((s, i) => { const start = at; at += prepared[i].seconds; return { shot_id: s.id, number: s.number, start: +start.toFixed(2), seconds: prepared[i].seconds }; });
  const total = at;

  const t = [];
  for (const p of prepared.slice(1)) { t.push({ overlay: `video:${layerId(p.publicId)}`, flags: 'splice' }); t.push({ flags: 'layer_apply' }); }

  // Voice lines (per shot) and sound effects, at their exact second.
  shots.forEach((s, i) => {
    const start = timeline[i].start;
    // Episode shots (084) carry several lines (dialogue + narration): one after another.
    const spoken = (s.lines || []).filter((l) => l.public_id);
    if (spoken.length) {
      let at = start + 0.2;
      for (const l of spoken) {
        if (at >= total - 0.3) break;
        t.push(...audioLayer(l.public_id, { leadIn: Number(l.lead_in) || 0 }));
        t.push({ flags: 'layer_apply', start_offset: +at.toFixed(2) });
        at += Math.max(0.5, (Number(l.seconds) || 2) - (Number(l.lead_in) || 0)) + 0.25;
      }
    } else if (s.voice_public_id) {
      const offset = start + Math.max(0, Number(s.voice_offset ?? 0.2));
      if (offset < total - 0.3) { t.push(...audioLayer(s.voice_public_id, { leadIn: Number(s.voice_lead_in) || 0 })); t.push({ flags: 'layer_apply', start_offset: +offset.toFixed(2) }); }
    }
    for (const fx of s.sfx || []) {
      if (!fx.public_id) continue;
      const offset = start + Math.min(Number(fx.at) || 0, timeline[i].seconds);
      if (offset >= total - 0.1) continue;
      t.push(...audioLayer(fx.public_id, { leadIn: Number(fx.lead_in) || 0, volume: SFX_LEVELS[fx.level] ?? 0 }));
      t.push({ flags: 'layer_apply', start_offset: +offset.toFixed(2) });
    }
  });
  if (voiceoverPublicId) { t.push(...audioLayer(voiceoverPublicId, { length: total })); t.push({ flags: 'layer_apply' }); }
  if (musicPublicId) {
    const level = MUSIC_LEVELS[project.finish?.music_level] ?? MUSIC_LEVELS.low;
    t.push(...audioLayer(musicPublicId, { volume: level, length: total, fadeOut: total > 6 ? 2 : 0 }));
    t.push({ flags: 'layer_apply' });
  }

  const url = cloudinary.url(prepared[0].publicId, { resource_type: 'video', format: 'mp4', transformation: t });
  await fetchBuilt(url);
  const up = await cloudinary.uploader.upload(url, { resource_type: 'video', folder });
  return {
    url: up.secure_url, seconds: up.duration, publicId: up.public_id, timeline,
    caches: Object.fromEntries(shots.map((s, i) => [s.id, prepared[i].cache])),
  };
}

/**
 * Joins finished parts (title card, scene renders, end card) into one video, with the
 * music under all of it. Parts are already edited, so this is a plain splice; it keeps
 * each Cloudinary URL short (a whole episode in one URL would be too long).
 */
export async function joinParts({ parts, musicPublicId = null, musicLevel = 'low', folder = 'bookofmemes/video-studio/episodes' }) {
  if (!parts.length) throw new Error('Nothing to join');
  const total = parts.reduce((n, p) => n + (Number(p.seconds) || 0), 0);
  const t = [];
  for (const p of parts.slice(1)) { t.push({ overlay: `video:${layerId(p.publicId)}`, flags: 'splice' }); t.push({ flags: 'layer_apply' }); }
  if (musicPublicId) {
    t.push(...audioLayer(musicPublicId, { volume: MUSIC_LEVELS[musicLevel] ?? MUSIC_LEVELS.low, length: total, fadeOut: total > 6 ? 2.5 : 0 }));
    t.push({ flags: 'layer_apply' });
  }
  const url = cloudinary.url(parts[0].publicId, { resource_type: 'video', format: 'mp4', transformation: t });
  await fetchBuilt(url);
  const up = await cloudinary.uploader.upload(url, { resource_type: 'video', folder });
  return { url: up.secure_url, seconds: Number(up.duration) || total, publicId: up.public_id };
}

/** A card (title, "next episode") as a short video: white words on black, a slow push-in. */
export async function makeCard({ baseImageId, lines, seconds = 3, aspect = 'landscape', folder = 'bookofmemes/video-studio/cards' }) {
  const [width, height] = ASPECTS[aspect] || ASPECTS.landscape;
  const t = [{ width, height, crop: 'fill' }, { effect: 'brightness:-100' }, { effect: 'colorize:100', color: 'black' }];
  const shown = lines.filter(Boolean).slice(0, 3);
  shown.forEach((text, i) => {
    const big = i === 0;
    t.push({ overlay: { font_family: 'Arial', font_size: Math.round(width / (big ? 16 : 28)), font_weight: big ? 'bold' : 'normal', text: String(text).slice(0, 80), text_align: 'center' }, color: big ? 'white' : '#F59E0B', width: Math.round(width * 0.85), crop: 'fit' });
    t.push({ flags: 'layer_apply', gravity: 'center', y: Math.round((i - (shown.length - 1) / 2) * height * 0.12) });
  });
  t.push({ effect: `zoompan:du_${seconds};from_(g_center;zoom_1);to_(g_center;zoom_1.06)` });
  const url = cloudinary.url(baseImageId, { resource_type: 'image', format: 'mp4', transformation: t });
  await fetchBuilt(url);
  const up = await cloudinary.uploader.upload(url, { resource_type: 'video', folder });
  return { url: up.secure_url, seconds: Number(up.duration) || seconds, publicId: up.public_id };
}

/** An animated still: a keyframe with a slow camera move, exactly `seconds` long. */
export async function animateStill({ imageId, seconds, move = 'push', aspect = 'landscape', folder = 'bookofmemes/video-studio/stills-motion' }) {
  const [width, height] = ASPECTS[aspect] || ASPECTS.landscape;
  const du = Math.max(2, Math.min(12, Math.round(seconds * 10) / 10));
  const moves = {
    push: 'from_(g_center;zoom_1);to_(g_center;zoom_1.18)',
    pull: 'from_(g_center;zoom_1.25);to_(g_center;zoom_1)',
    pan: 'from_(g_west;zoom_1.2);to_(g_east;zoom_1.2)',
    tilt: 'from_(g_north;zoom_1.2);to_(g_south;zoom_1.2)',
    close: 'from_(g_center;zoom_1.1);to_(g_center;zoom_1.4)',
  };
  const t = [{ width, height, crop: 'fill' }, { effect: `zoompan:du_${du};${moves[move] || moves.push}` }, { width, height, crop: 'fill' }];
  const url = cloudinary.url(imageId, { resource_type: 'image', format: 'mp4', transformation: t });
  await fetchBuilt(url);
  const up = await cloudinary.uploader.upload(url, { resource_type: 'video', folder });
  return { url: up.secure_url, seconds: Number(up.duration) || du, publicId: up.public_id };
}

/** Public id of an image on our Cloudinary (or null). */
export function imagePublicId(url) {
  const m = String(url || '').match(new RegExp(`res\\.cloudinary\\.com/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload/(?:[^/]+/)*?(?:v\\d+/)(.+?)\\.[a-z0-9]+$`, 'i'));
  return m ? m[1] : null;
}
