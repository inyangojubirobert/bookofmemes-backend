// node src/tests/videoFinish.test.js — Video Studio finishing rules (config/soundStudio.js, utils/luts.js,
// utils/audioOnset.js, config/aiPlans.js). No network.
import assert from 'assert';
import zlib from 'zlib';
import {
  cropRect, cleanEdit, cleanFinish, cleanSfx, cleanVoice, cleanLight, lightText, cleanGrade, gradeFn, tonedText, voiceTask, musicPrompt,
  VOICES, TONES, LOOKS, SFX_LIBRARY, MUSIC_THEMES,
} from '../../config/soundStudio.js';
import { colourKey, lutText } from '../../utils/luts.js';
import { decodePng } from '../../utils/audioOnset.js';
import { creditsFor, ACTION_COSTS, ACTION_COST_USD, CREDIT_COST_CEILING_USD } from '../../config/aiPlans.js';

// 1. Crop: zoom 2 at top-right keeps the top-right quarter; zoom 1 is no crop.
assert.strictEqual(cropRect({ zoom: 1 }), null);
assert.deepStrictEqual(cropRect({ zoom: 2, anchor: 'top-right' }), { x: 0.5, y: 0, w: 0.5, h: 0.5 });
assert.deepStrictEqual(cropRect({ zoom: 1.25, anchor: 'center' }), { x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
assert.deepStrictEqual(cropRect({ zoom: 3 }), null, 'unknown zoom → none');

// 2. Edits are cleaned: unknown look dropped, 'none' kept, grade rounded to 5 and clamped.
const e = cleanEdit({ zoom: 1.5, anchor: 'nowhere', look: 'teal', clip_audio: 'loud', grade: { warmth: 33, hue: 500, junk: 9 } });
assert.deepStrictEqual(e, { zoom: 1.5, anchor: 'center', look: null, clip_audio: 'keep', grade: { warmth: 35, hue: 100 } });
assert.strictEqual(cleanEdit({ look: 'none' }).look, 'none');
assert.strictEqual(cleanGrade({ warmth: 0 }), null);
assert.deepStrictEqual(cleanFinish({ look: 'noir', vignette: 1, music_level: 'deafening' }), { look: 'noir', vignette: true, music_level: 'low' });

// 3. Sound effects: only our Cloudinary, at most 6, placed inside the shot.
const fx = cleanSfx([
  { url: 'https://res.cloudinary.com/x/video/upload/a.mp3', label: 'Door', at: 99, level: 'loud' },
  { url: 'https://evil.example/a.mp3', label: 'Bad' },
  ...Array.from({ length: 8 }, (_, i) => ({ url: `https://res.cloudinary.com/x/video/upload/${i}.mp3`, at: 1.26 })),
], 5);
assert.strictEqual(fx.length, 5, 'the 7th+ are cut first (6 max), then the non-Cloudinary one is dropped');
assert.strictEqual(fx[0].at, 5); assert.strictEqual(fx[0].level, 'loud'); assert.strictEqual(fx[1].at, 1.3);

// 4. Voices and tones: every tone cue repeats per sentence; pace = choice × tone.
assert.strictEqual(new Set(VOICES.map((v) => v.id)).size, VOICES.length);
assert.ok(VOICES.every((v) => /^[0-9a-f]{32}$/.test(v.fish)));
assert.strictEqual(tonedText('Run. Now!', 'whisper'), '[whispering] Run. [whispering] Now!');
assert.strictEqual(tonedText('  Hello  there. ', 'natural'), 'Hello there.');
const t = voiceTask('Hello.', { voiceId: 'adaeze', tone: 'suspense', speed: 1.2 });
assert.strictEqual(t.speech.voice, VOICES.find((v) => v.id === 'adaeze').fish);
assert.strictEqual(t.speech.speed, 1.08);
assert.deepStrictEqual(cleanVoice({ voice_id: 'nobody', tone: 'sad', speed: 7 }), { voice_id: 'adrian', tone: 'sad', speed: 1 });
assert.ok(TONES.length >= 12);

// 5. Lighting before generation becomes prompt words.
assert.strictEqual(cleanLight({ preset: 'x', colour: 'y' }), null);
assert.match(lightText(cleanLight({ preset: 'golden', colour: 'teal' })), /^Lighting: warm golden-hour sunlight.*teal and cyan light\.$/);

// 6. Music prompts are instrumental; every theme has stock-library material.
assert.match(musicPrompt({ theme: 'suspense', mood: 'dark', tempo: 'slow', instruments: 'talking drum' }), /tense suspenseful.*dark mood.*slow tempo.*talking drum.*no vocals/);
assert.ok(MUSIC_THEMES.length >= 20 && SFX_LIBRARY.length >= 40);
assert.strictEqual(new Set(SFX_LIBRARY.map((s) => s.id)).size, SFX_LIBRARY.length);

// 7. LUTs: 17³ entries + header; identity when nothing is set; grade changes it; names are stable.
assert.strictEqual(colourKey({}), null);
const k1 = colourKey({ look: 'noir', strength: 'medium', grade: { warmth: 20 } });
assert.strictEqual(k1.publicId, colourKey({ look: 'noir', strength: 'medium', grade: { warmth: 20 } }).publicId);
assert.notStrictEqual(k1.publicId, colourKey({ look: 'noir', strength: 'medium', grade: { warmth: 25 } }).publicId);
const lines = lutText({ look: 'blue', strength: 'full', grade: null }).trim().split('\n');
assert.strictEqual(lines.length, 1 + 17 ** 3);
assert.ok(lines.slice(1).every((l) => l.split(' ').every((v) => +v >= 0 && +v <= 4095)));
const white = lines[lines.length - 1].split(' ').map(Number);
assert.ok(white[2] > white[0], 'blue screen: white turns blue');
const warm = gradeFn({ warmth: 100 })(0.5, 0.5, 0.5);
assert.ok(warm[0] > 0.5 && warm[2] < 0.5, 'warmth: more red, less blue');
for (const id of Object.keys(LOOKS)) assert.strictEqual(LOOKS[id].fn(0.4, 0.5, 0.6).length, 3);

// 8. PNG reader (1-bit grayscale, like Cloudinary's waveform).
function png1bit(width, height, pixel) {
  const stride = Math.ceil(width / 8);
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (pixel(x, y)) raw[y * (stride + 1) + 1 + (x >> 3)] |= 0x80 >> (x & 7);
  const chunk = (type, data) => { const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length, 0); b.write(type, 4, 'latin1'); data.copy(b, 8); return b; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 1; ihdr[9] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const img = decodePng(png1bit(20, 4, (x, y) => x === 13 && y === 2)); // white = 1 = not dark
assert.strictEqual(img.dark(13, 2), false); assert.strictEqual(img.dark(3, 1), true);

// 9. Prices: sound per second, voice lines per line; both within the credit cost ceiling.
assert.strictEqual(creditsFor('sfx', { seconds: 2.2 }), 6);
assert.strictEqual(creditsFor('voiceLine', { premium: true, units: 4 }), 4);
for (const a of ['sfxPerSecond', 'voiceLine']) assert.ok(ACTION_COST_USD[a].premium / ACTION_COSTS[a].premium <= CREDIT_COST_CEILING_USD);

console.log('videoFinish: all 9 groups passed');
