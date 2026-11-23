// Narrates a whole podcast script as one audio file for the Content Studio.
// The voice model takes at most MAX_CHARS_PER_REQUEST characters per call, so
// the script is split at sentence ends, each part is narrated (same models as
// /api/ai/voice/narrate), and the MP3 parts are joined and uploaded to
// Cloudinary. MP3 is a stream of independent frames, so joining parts back to
// back plays as one file once the ID3 headers of the later parts are removed.
import { Readable } from 'stream';
import { v2 as cloudinary } from 'cloudinary';
import crypto from 'crypto';
import { synthesizeSpeech, CHARS_PER_SECOND, MAX_CHARS_PER_REQUEST } from '../routes/voiceRoutes.js';
import { voiceTask, isCustomVoice, validVoiceId, VOICE_MODEL } from '../config/soundStudio.js';
import { getCustomVoice } from './customVoices.js';
import { callRunwareTasks } from './runwareClient.js';

// A part in a chosen voice (built-in, or the user's own custom voice: migration 086).
async function synthPart(text, { voiceId, custom }) {
  const t = voiceTask(text, { voiceId, custom });
  const { data } = await callRunwareTasks([{
    taskType: 'audioInference', taskUUID: crypto.randomUUID(), model: VOICE_MODEL, outputFormat: 'MP3', includeCost: true,
    speech: t.speech, settings: t.settings, ...(custom ? { inputs: t.inputs } : {}),
  }]);
  if (!data?.[0]?.audioURL) throw new Error('Runware returned no audio');
  return { audioUrl: data[0].audioURL, providerCost: data[0].cost ?? null, modelUsed: VOICE_MODEL };
}

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

export const MAX_SCRIPT_CHARS = 9000; // about 10 minutes of speech

// Stage cues like [MUSIC] or [PAUSE] are for the host, not to be read out.
export function speakableText(script) {
  return String(script || '')
    .replace(/\[[^\]]{1,40}\]/g, ' ')
    .replace(/^\s*(host|narrator)\s*:\s*/gim, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const estimateSeconds = (text) => Math.ceil(text.length / CHARS_PER_SECOND);

export function splitForSpeech(text, max = MAX_CHARS_PER_REQUEST) {
  const sentences = text.match(/[^.!?\n]+[.!?]*["')\]]*\s*|\n+/g) || [text];
  const parts = [];
  let cur = '';
  for (let sentence of sentences) {
    // A single sentence longer than the limit is cut at the last space.
    while (sentence.length > max) {
      const cut = sentence.lastIndexOf(' ', max) > max / 2 ? sentence.lastIndexOf(' ', max) : max;
      if (cur.trim()) { parts.push(cur.trim()); cur = ''; }
      parts.push(sentence.slice(0, cut).trim());
      sentence = sentence.slice(cut);
    }
    if ((cur + sentence).length > max) { if (cur.trim()) parts.push(cur.trim()); cur = sentence; } else cur += sentence;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts.filter(Boolean);
}

// Removes a leading ID3v2 tag (its size is a 4-byte "synchsafe" integer).
export function stripId3(buf) {
  if (buf.length > 10 && buf.toString('latin1', 0, 3) === 'ID3') {
    const size = (buf[6] << 21) | (buf[7] << 14) | (buf[8] << 7) | buf[9];
    const footer = buf[5] & 0x10 ? 10 : 0;
    return buf.subarray(10 + size + footer);
  }
  return buf;
}

async function fetchBuffer(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Could not download narration part (${r.status})`);
  return Buffer.from(await r.arrayBuffer());
}

const upload = (buffer, options) => new Promise((resolve, reject) => {
  const stream = cloudinary.uploader.upload_stream(options, (err, result) => (err ? reject(err) : resolve(result)));
  Readable.from(buffer).pipe(stream);
});

/** Narrates the script; returns { audioUrl, seconds, parts, providerCost, model }. */
/** voiceId (optional): a built-in voice id or the user's custom voice ("custom:<uuid>"). */
export async function narrateScript(script, { useHdModel, userId, voiceId = null }) {
  const text = speakableText(script);
  if (text.length < 50) throw Object.assign(new Error('The script is too short to narrate.'), { status: 400 });
  if (text.length > MAX_SCRIPT_CHARS) throw Object.assign(new Error(`The script is too long to narrate (${MAX_SCRIPT_CHARS.toLocaleString()} characters at most). Shorten it and try again.`), { status: 400 });
  const pieces = splitForSpeech(text);
  let custom = null;
  if (isCustomVoice(voiceId)) {
    custom = await getCustomVoice(userId, voiceId);
    if (!custom) throw Object.assign(new Error('That custom voice was removed. Choose another voice.'), { status: 400 });
  }
  const chosen = validVoiceId(voiceId);

  // Three at a time: quick, without flooding the provider.
  const results = new Array(pieces.length);
  for (let i = 0; i < pieces.length; i += 3) {
    const batch = await Promise.all(pieces.slice(i, i + 3).map((p) => (chosen ? synthPart(p, { voiceId, custom }) : synthesizeSpeech(p, { useHdModel }))));
    batch.forEach((r, k) => { results[i + k] = r; });
  }
  const buffers = await Promise.all(results.map((r) => fetchBuffer(r.audioUrl)));
  const joined = Buffer.concat(buffers.map((b, i) => (i === 0 ? b : stripId3(b))));
  const up = await upload(joined, { resource_type: 'video', folder: `podcast_narration/${userId}`, format: 'mp3' });
  const providerCost = results.reduce((sum, r) => sum + (Number(r.providerCost) || 0), 0);
  return {
    audioUrl: up.secure_url,
    seconds: Math.round(up.duration || estimateSeconds(text)),
    estimatedSeconds: estimateSeconds(text),
    parts: pieces.length,
    providerCost: providerCost || null,
    model: results[0]?.modelUsed || null,
  };
}
