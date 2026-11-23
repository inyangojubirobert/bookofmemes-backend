// Builds the free stock library of the Video Studio once (config/soundLibrary.json):
//   * a sample of every voice (config/soundStudio.js VOICES)     ≈ $0.0015 each
//   * one 60-second instrumental per music theme (ACE-Step)      ≈ $0.0023 each
//   * every stock sound effect (Mirelo SFX 1.5, $0.01 a second)  ≈ $1.80 for all
// All made by us on Runware and kept on our Cloudinary, so they're free to use
// in any user's video. Resumable: items already in the file are skipped.
// Run from Backend/:  node scripts/buildSoundLibrary.js [voices|music|sfx]
import 'dotenv/config';
import fs from 'fs';
import { VOICES, MUSIC_THEMES, SFX_LIBRARY, musicPrompt } from '../config/soundStudio.js';
import { speakLine, makeSoundEffect } from '../utils/soundMaker.js';
import { generateSong } from '../utils/music.js';

const FILE = new URL('../config/soundLibrary.json', import.meta.url);
const lib = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : {};
lib.voices ||= {}; lib.music ||= []; lib.sfx ||= [];
const save = () => fs.writeFileSync(FILE, `${JSON.stringify({ ...lib, built_at: new Date().toISOString() }, null, 1)}\n`);
const only = process.argv[2];
let spent = 0;

async function pool(items, n, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: n }, async () => {
    while (queue.length) {
      const item = queue.shift();
      try { await fn(item); save(); } catch (err) { console.error(`  ✘ ${item.id}: ${err.message}`); }
    }
  }));
}

const SAMPLE = 'Every story starts somewhere. Tonight, this one starts with you.';
if (!only || only === 'voices') {
  await pool(VOICES.filter((v) => !lib.voices[v.id]), 4, async (v) => {
    const r = await speakLine(SAMPLE, { voiceId: v.id, folder: 'bookofmemes/sound-library/voices' });
    if (r.voice !== v.id) throw new Error('voice fell back to a preset (removed from Fish Audio?)');
    lib.voices[v.id] = r.url; spent += Number(r.cost) || 0;
    console.log(`  ✔ voice ${v.id}`);
  });
}
if (!only || only === 'music') {
  const have = new Set(lib.music.map((m) => m.id));
  await pool(MUSIC_THEMES.filter((t) => !have.has(t.id)), 3, async (t) => {
    const r = await generateSong({ style: musicPrompt({ theme: t.id }), seconds: 60, folder: 'bookofmemes/sound-library/music' });
    lib.music.push({ id: t.id, theme: t.id, title: t.label, url: r.audioUrl, seconds: r.seconds });
    spent += Number(r.cost) || 0;
    console.log(`  ✔ music ${t.id}`);
  });
}
if (!only || only === 'sfx') {
  const have = new Set(lib.sfx.map((s) => s.id));
  await pool(SFX_LIBRARY.filter((s) => !have.has(s.id)), 4, async (s) => {
    const r = await makeSoundEffect(s.prompt, s.seconds, 'bookofmemes/sound-library/sfx');
    lib.sfx.push({ id: s.id, category: s.category, label: s.label, url: r.url, public_id: r.public_id, seconds: r.seconds, lead_in: r.lead_in });
    spent += Number(r.cost) || 0;
    console.log(`  ✔ sfx ${s.id} (lead-in ${r.lead_in}s)`);
  });
}
lib.music.sort((a, b) => MUSIC_THEMES.findIndex((t) => t.id === a.id) - MUSIC_THEMES.findIndex((t) => t.id === b.id));
lib.sfx.sort((a, b) => SFX_LIBRARY.findIndex((t) => t.id === a.id) - SFX_LIBRARY.findIndex((t) => t.id === b.id));
save();
console.log(`Done: ${Object.keys(lib.voices).length}/${VOICES.length} voices, ${lib.music.length}/${MUSIC_THEMES.length} tracks, ${lib.sfx.length}/${SFX_LIBRARY.length} sounds. Spent $${spent.toFixed(3)}.`);
