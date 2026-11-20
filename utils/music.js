// Songs and instrumentals for the Music studio and video soundtracks.
// ACE-Step 1.5 XL turbo on Runware: measured 2026-11-20 at $0.00225 for a
// 60 s song with vocals, about 20 s to make (config/mediaCapabilities.js).
// The result is copied to our Cloudinary (provider links don't last).
import crypto from 'crypto';
import { v2 as cloudinary } from 'cloudinary';
import { RETIRED_MODELS } from '../config/aiModels.js';

const MODEL = (process.env.RUNWARE_MUSIC_MODEL && !RETIRED_MODELS[process.env.RUNWARE_MUSIC_MODEL] ? process.env.RUNWARE_MUSIC_MODEL : null) || 'runware:ace-step@v1.5-xl-turbo';
const KEY = () => process.env.RUNWARE_API_KEY;
export const SONG_SECONDS = [30, 60, 120];
export const MUSIC_MODEL = MODEL;

cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET });

async function call(tasks) {
  const r = await fetch('https://api.runware.ai/v1', { method: 'POST', headers: { Authorization: `Bearer ${KEY()}`, 'Content-Type': 'application/json' }, body: JSON.stringify(tasks) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.errors?.length) throw Object.assign(new Error(j.errors?.[0]?.message || `Runware ${r.status}`), { providerHttpStatus: r.status });
  return j.data || [];
}

/** Makes a song (lyrics) or an instrumental (no lyrics). Returns { audioUrl, seconds, cost, model }. */
export async function generateSong({ style, lyrics = null, seconds = 60, folder = 'bookofmemes/music' }) {
  if (!KEY()) throw Object.assign(new Error('Music is not available yet'), { status: 501 });
  const duration = SONG_SECONDS.includes(Number(seconds)) ? Number(seconds) : 60;
  const taskUUID = crypto.randomUUID();
  await call([{
    taskType: 'audioInference', taskUUID, model: MODEL, outputFormat: 'MP3', deliveryMethod: 'async', includeCost: true,
    positivePrompt: String(style || 'warm, catchy pop song').slice(0, 1000), duration,
    settings: { lyrics: lyrics ? String(lyrics).slice(0, 3500) : '[Instrumental]' },
  }]);
  const until = Date.now() + 150000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 4000));
    const [res] = await call([{ taskType: 'getResponse', taskUUID }]);
    if (res?.status === 'error') throw new Error(res.errorMessage || 'The song could not be made');
    if (res?.status === 'success' && res.audioURL) {
      const up = await cloudinary.uploader.upload(res.audioURL, { resource_type: 'video', folder });
      return { audioUrl: up.secure_url, seconds: Math.round(up.duration || duration), cost: res.cost ?? null, model: MODEL };
    }
  }
  throw new Error('The song took too long. Please try again (you were not charged).');
}
