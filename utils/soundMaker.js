// Voices, sound effects and "sound from the clip" for the Video Studio.
// All on Runware; results are copied to our Cloudinary (provider links expire).
//   voice lines   Fish Audio S2.1 Pro, ≈$0.0015 a line (measured 2026-11-23)
//   sound effects Mirelo SFX 1.5, $0.01 a second (measured: 2 s $0.02, 10 s $0.10)
//   clip sound    Mirelo SFX 1.5 video mode, same price per second of clip
import crypto from 'crypto';
import { v2 as cloudinary } from 'cloudinary';
import { callRunwareTasks } from './runwareClient.js';
import { silenceBounds } from './audioOnset.js';
import { VOICE_MODEL, FALLBACK_FISH, voiceTask, SFX_MAX_SECONDS } from '../config/soundStudio.js';

cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET });

export const SFX_MODEL = process.env.RUNWARE_SFX_MODEL || 'mirelo:1@1';
const known = (message, status = 400) => Object.assign(new Error(message), { status });

async function keep(url, folder) {
  // Cloudinary rejects with { error: { message } }, not an Error: make it readable.
  const up = await cloudinary.uploader.upload(url, { resource_type: 'video', folder })
    .catch((e) => { throw new Error(`Keeping the sound failed: ${e?.error?.message || e?.message || 'upload error'}`); });
  return { url: up.secure_url, public_id: up.public_id, seconds: Number(up.duration) || 0 };
}

/** One spoken line. Returns { url, public_id, seconds, lead_in, cost, model, voice }. */
export async function speakLine(text, { voiceId, tone, speed, folder = 'bookofmemes/video-studio/voice' } = {}) {
  const clean = String(text || '').trim();
  if (clean.length < 2) throw known('This line has no words to say.');
  const t = voiceTask(clean, { voiceId, tone, speed });
  const run = (voice) => callRunwareTasks([{
    taskType: 'audioInference', taskUUID: crypto.randomUUID(), model: VOICE_MODEL, outputFormat: 'MP3', includeCost: true,
    speech: { ...t.speech, voice }, settings: t.settings,
  }]);
  let data;
  try { ({ data } = await run(t.speech.voice)); }
  catch (err) {
    // A community voice can be removed by its owner: use the matching preset.
    const fb = FALLBACK_FISH[t.voice.gender] || FALLBACK_FISH.male;
    if (!err.permanent || fb === t.speech.voice) throw err;
    console.warn(`[voice] ${t.voice.id} failed (${err.message}); using the preset voice`);
    ({ data } = await run(fb));
  }
  const r = data?.[0];
  if (!r?.audioURL) throw new Error('No voice came back');
  const kept = await keep(r.audioURL, folder);
  const { leadIn } = await silenceBounds(kept.public_id, kept.seconds);
  return { ...kept, lead_in: leadIn, cost: r.cost ?? null, model: VOICE_MODEL, voice: t.voice.id };
}

/** A sound effect from words. Returns { url, public_id, seconds, lead_in, cost }. */
export async function makeSoundEffect(prompt, seconds = 3, folder = 'bookofmemes/video-studio/sfx') {
  const p = String(prompt || '').trim();
  if (p.length < 3) throw known('Describe the sound (e.g. "water poured into a cup").');
  const duration = Math.max(1, Math.min(SFX_MAX_SECONDS, Math.round(Number(seconds) || 3)));
  const { data } = await callRunwareTasks([{
    taskType: 'audioInference', taskUUID: crypto.randomUUID(), model: SFX_MODEL, outputFormat: 'MP3', includeCost: true,
    positivePrompt: p.slice(0, 1000), duration, numberResults: 1, // the default gave 2 results (and 2 charges)
  }]);
  const r = data?.[0];
  if (!r?.audioURL) throw new Error('No sound came back');
  const kept = await keep(r.audioURL, folder);
  const { leadIn } = await silenceBounds(kept.public_id, kept.seconds);
  return { ...kept, lead_in: leadIn, cost: r.cost ?? null, model: SFX_MODEL };
}

/** The same clip with sound made to match what happens in it. Returns { url, public_id, seconds, cost }. */
export async function soundForClip(clipUrl, folder = 'bookofmemes/video-studio') {
  const { data } = await callRunwareTasks([{
    taskType: 'audioInference', taskUUID: crypto.randomUUID(), model: SFX_MODEL, outputFormat: 'MP4', includeCost: true,
    inputs: { video: clipUrl }, numberResults: 1,
  }]);
  const r = data?.[0];
  const url = r?.videoURL || r?.audioURL || r?.mediaURL;
  if (!url) throw new Error('No clip came back');
  return { ...(await keep(url, folder)), cost: r.cost ?? null, model: SFX_MODEL };
}
