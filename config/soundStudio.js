// Bascardo Video Studio: sound and picture finishing (migration 083).
//
//   Voices   Fish Audio S2.1 Pro on Runware (the only working voice there that is
//            both good and cheap: measured $0.0015 a line, 2026-11-23). ElevenLabs
//            shows up in Runware's model search but inference answers
//            "invalidModel" (tested 2026-11-23), so it can't be used.
//            Presets are Runware's 8 + chosen public Fish Audio library voices
//            (accepted by Runware, tested). No cloned celebrities or characters.
//   Tones    Fish S2 reads bracket cues inline ("[whispering]", "[sad]"), plus
//            speed and temperature (expressiveness).
//   Music    ACE-Step 1.5 XL turbo (utils/music.js): themes → prompt.
//   Sounds   Mirelo SFX 1.5 (mirelo:1@1): text → sound (1-10 s) or a clip → the
//            same clip with matching sound. Measured $0.01 a second.
//   Looks    colour grades as 3D LUTs on Cloudinary (utils/luts.js).
//   Shape    landscape 16:9, portrait 9:16, square; per-shot crop/zoom.

// ── Voices ──────────────────────────────────────────────────────────────────
export const VOICE_MODEL = 'fishaudio:s2.1@pro';
export const DEFAULT_VOICE = 'adrian';

export const VOICES = [
  // Narrators
  { id: 'adrian', fish: 'bf322df2096a46f18c579d0baa36f41d', name: 'Adrian', gender: 'male', age: 'adult', accent: 'American', group: 'Narrators', about: 'Deep, steady storyteller' },
  { id: 'laura', fish: 'e3cd384158934cc9a01029cd7d278634', name: 'Laura', gender: 'female', age: 'adult', accent: 'American', group: 'Narrators', about: 'Warm, confident narrator' },
  { id: 'ethan', fish: '536d3a5e000945adb7038665781a4aca', name: 'Ethan', gender: 'male', age: 'adult', accent: 'American', group: 'Narrators', about: 'Calm documentary explainer' },
  { id: 'adaeze', fish: 'f248b08382a244a087ab5ee5fda8f6c2', name: 'Adaeze', gender: 'female', age: 'adult', accent: 'Nigerian', group: 'Narrators', about: 'Clear, expressive Nigerian storyteller' },
  { id: 'tunde', fish: '502e143036d64df082b70b626058d9ed', name: 'Tunde', gender: 'male', age: 'adult', accent: 'Nigerian', group: 'Narrators', about: 'Smooth Nigerian voice-over' },
  { id: 'chidi', fish: '4287969fde684ef68a6a72a314d773cf', name: 'Chidi', gender: 'male', age: 'young', accent: 'Nigerian', group: 'Narrators', about: 'Deep, calm and reflective' },
  { id: 'edmund', fish: 'beb44e5fac1e4b33a15dfcdcc2a9421d', name: 'Edmund', gender: 'male', age: 'adult', accent: 'British', group: 'Narrators', about: 'Calm British historian' },
  { id: 'trailer', fish: 'fd176117735446968cca7911ee4da42b', name: 'Trailer', gender: 'male', age: 'older', accent: 'American', group: 'Narrators', about: 'Deep cinematic movie-trailer voice' },
  { id: 'silas', fish: 'f8dfe9c83081432386f143e2fe9767ef', name: 'Silas', gender: 'male', age: 'older', accent: 'American', group: 'Narrators', about: 'Raspy, gravelly old storyteller' },
  { id: 'mama-ngozi', fish: 'b03092d6ba3144689ad79331b9a836b2', name: 'Mama Ngozi', gender: 'female', age: 'older', accent: 'African', group: 'Narrators', about: 'Wise, slow folktale teller' },
  { id: 'kwame', fish: '648302ff56f54b05a5f3524fbadfb333', name: 'Kwame', gender: 'male', age: 'older', accent: 'African', group: 'Narrators', about: 'Deep, commanding and wise' },
  // Characters
  { id: 'sarah', fish: '933563129e564b19a115bedd57b7406a', name: 'Sarah', gender: 'female', age: 'young', accent: 'American', group: 'Characters', about: 'Soft, sincere young woman' },
  { id: 'zara', fish: 'b545c585f631496c914815291da4e893', name: 'Zara', gender: 'female', age: 'young', accent: 'American', group: 'Characters', about: 'Bright and energetic' },
  { id: 'hannah', fish: '9a9cf47702da476aa4629e2506d4a857', name: 'Hannah', gender: 'female', age: 'adult', accent: 'American', group: 'Characters', about: 'Confident and friendly' },
  { id: 'selene', fish: 'b347db033a6549378b48d00acb0d06cd', name: 'Selene', gender: 'female', age: 'adult', accent: 'American', group: 'Characters', about: 'Soft, breathy and calm' },
  { id: 'max', fish: '802e3bc2b27e49c2995d23ef70e6ac89', name: 'Max', gender: 'male', age: 'young', accent: 'American', group: 'Characters', about: 'Energetic, upbeat (ads, hype)' },
  { id: 'jordan', fish: '79d0bd3e4e5444b18f7b6d89b5927bf1', name: 'Jordan', gender: 'male', age: 'older', accent: 'American', group: 'Characters', about: 'Measured, motivational' },
  { id: 'oga', fish: '36956e5f10e64147a93a298ae97b4590', name: 'Oga', gender: 'male', age: 'adult', accent: 'Nigerian Pidgin', group: 'Characters', about: 'Lively Pidgin English' },
  { id: 'night', fish: 'ef9c79b62ef34530bf452c0e50e3c260', name: 'Night', gender: 'male', age: 'adult', accent: 'American', group: 'Characters', about: 'Low, mysterious (horror, thriller)' },
  { id: 'villain', fish: '1f153d61b0ae4095b28c786ddeaec347', name: 'Villain', gender: 'male', age: 'adult', accent: 'American', group: 'Characters', about: 'Deep, raspy antagonist' },
  { id: 'grandma', fish: '0b6770770baf4db5b13c78c3091584a0', name: 'Grandma', gender: 'female', age: 'older', accent: 'American', group: 'Characters', about: 'Warm, gentle grandmother' },
  { id: 'grandpa', fish: 'e223051b34524a48940561e9a18a2203', name: 'Grandpa', gender: 'male', age: 'older', accent: 'American', group: 'Characters', about: 'Warm, raspy and wise' },
  { id: 'kiki', fish: '4fcb3a423c61415fb35604eba567d95f', name: 'Kiki', gender: 'child', age: 'child', accent: 'American', group: 'Characters', about: 'Bright, playful child' },
  { id: 'amara', fish: '60ae5c99efb0425bb50586aff16d3c58', name: 'Amara', gender: 'child', age: 'child', accent: 'American', group: 'Characters', about: 'Soft, gentle child' },
  { id: 'robot', fish: '86c3dd42c08f4082a2ad9ba59441c743', name: 'Robot', gender: 'male', age: 'adult', accent: 'Robotic', group: 'Characters', about: 'Cold, mechanical sci-fi voice' },
];
const VOICE_BY_ID = Object.fromEntries(VOICES.map((v) => [v.id, v]));
export const voiceById = (id) => VOICE_BY_ID[id] || VOICE_BY_ID[DEFAULT_VOICE];
// A library voice its owner deletes would fail: fall back to a Runware preset of the same kind.
export const FALLBACK_FISH = { male: 'bf322df2096a46f18c579d0baa36f41d', female: 'e3cd384158934cc9a01029cd7d278634', child: '933563129e564b19a115bedd57b7406a' };

// ── Tones: the way the words are said ───────────────────────────────────────
export const TONES = [
  { id: 'natural', label: 'Natural', cue: '', speed: 1, temperature: 0.7 },
  { id: 'warm', label: 'Warm', cue: '[warm, gentle]', speed: 0.97, temperature: 0.7 },
  { id: 'excited', label: 'Excited', cue: '[excited]', speed: 1.06, temperature: 0.85 },
  { id: 'cheerful', label: 'Cheerful', cue: '[cheerful]', speed: 1.03, temperature: 0.8 },
  { id: 'dramatic', label: 'Dramatic', cue: '[dramatic, intense]', speed: 0.95, temperature: 0.85 },
  { id: 'suspense', label: 'Suspense', cue: '[tense, low voice]', speed: 0.9, temperature: 0.8 },
  { id: 'mysterious', label: 'Mysterious', cue: '[mysterious]', speed: 0.92, temperature: 0.8 },
  { id: 'sad', label: 'Sad', cue: '[sad]', speed: 0.9, temperature: 0.8 },
  { id: 'angry', label: 'Angry', cue: '[angry]', speed: 1.02, temperature: 0.85 },
  { id: 'scared', label: 'Scared', cue: '[scared, trembling]', speed: 1.02, temperature: 0.85 },
  { id: 'whisper', label: 'Whisper', cue: '[whispering]', speed: 0.95, temperature: 0.7 },
  { id: 'shout', label: 'Shout', cue: '[shouting]', speed: 1.02, temperature: 0.85 },
  { id: 'calm', label: 'Calm', cue: '[calm, soothing]', speed: 0.92, temperature: 0.65 },
  { id: 'laughing', label: 'Laughing', cue: '[laughing]', speed: 1.02, temperature: 0.85 },
  { id: 'authority', label: 'Commanding', cue: '[confident, authoritative]', speed: 0.97, temperature: 0.7 },
];
const TONE_BY_ID = Object.fromEntries(TONES.map((t) => [t.id, t]));
export const toneById = (id) => TONE_BY_ID[id] || TONE_BY_ID.natural;
export const SPEEDS = [0.8, 0.9, 1, 1.1, 1.2];
export const MAX_LINE_CHARS = 400; // a shot's narration (≈27 s of speech)

/** The text sent to the voice: the tone cue in front of every sentence, so it holds for the whole line. */
export function tonedText(text, toneId) {
  const t = toneById(toneId);
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t.cue) return clean;
  const sentences = clean.match(/[^.!?]+[.!?]*["')\]]*\s*/g) || [clean];
  return sentences.map((s) => `${t.cue} ${s.trim()}`).join(' ');
}

// Custom voices (migration 086): "custom:<uuid>", a user's own recorded voice. Fish Audio
// speaks any line in it from the sample + its transcript (inputs.referenceVoices).
export const CUSTOM_VOICE_RE = /^custom:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isCustomVoice = (id) => CUSTOM_VOICE_RE.test(String(id || ''));
/** A voice id the app may send: a built-in voice or a custom one (ownership is checked when it speaks). */
export const validVoiceId = (id) => !!VOICE_BY_ID[id] || isCustomVoice(id);
export const CUSTOM_SAMPLE_SCRIPT = 'The rain had stopped, but the street still remembered it. Somewhere a door creaked open, and someone called my name. I took a deep breath, smiled, and stepped out into the morning light. Whatever happens today, I am ready for it.';

/**
 * Runware task fields for one line. speed: the user's choice × the tone's own pace.
 * custom: { id, name, gender, sample_url, transcript } for a custom voice (then no preset voice is sent).
 */
export function voiceTask(text, { voiceId, tone, speed = 1, custom = null } = {}) {
  const t = toneById(tone);
  const pace = Math.min(2, Math.max(0.5, Number((Number(speed || 1) * t.speed).toFixed(2))));
  if (custom) {
    return {
      voice: { id: `custom:${custom.id}`, name: custom.name, gender: custom.gender || 'male', custom: true },
      speech: { text: tonedText(text, t.id), speed: pace }, settings: { temperature: t.temperature },
      inputs: { referenceVoices: [{ audio: custom.sample_url, text: custom.transcript }] },
    };
  }
  const v = voiceById(voiceId);
  return { voice: v, speech: { text: tonedText(text, t.id), voice: v.fish, speed: pace }, settings: { temperature: t.temperature } };
}

/**
 * Naming convention for who says a line: "NAME: words". A shot's narration may hold several,
 * e.g. "ELLIE: Another day. NARRATOR: She didn't know yet." Only known names count as speakers
 * (so "Note: ..." stays plain narration). Returns [{ speaker, text }] (speaker null = narrator).
 */
export function parseSpeakers(text, knownNames = []) {
  const src = String(text || '').trim();
  if (!src) return [];
  const names = [...new Set(['NARRATOR', ...knownNames].map((n) => String(n || '').trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[\\s.!?"'])(${names.map(esc).join('|')})\\s*:\\s*`, 'gi');
  const out = [];
  let last = 0, speaker = null, m;
  while ((m = re.exec(src))) {
    const start = m.index + m[1].length;
    const before = src.slice(last, start).trim();
    if (before) out.push({ speaker, text: before });
    const found = names.find((n) => n.toLowerCase() === m[2].toLowerCase());
    speaker = found && found.toUpperCase() !== 'NARRATOR' ? found : null;
    last = re.lastIndex;
  }
  const rest = src.slice(last).trim();
  if (rest) out.push({ speaker, text: rest });
  return out;
}

export function cleanVoice(input = {}, prev = {}) {
  const voice_id = validVoiceId(input.voice_id) ? input.voice_id : (prev.voice_id || DEFAULT_VOICE);
  const tone = TONE_BY_ID[input.tone] ? input.tone : (prev.tone || 'natural');
  const sp = Number(input.speed ?? prev.speed ?? 1);
  // cast: who speaks with which voice, by the name used in "NAME: line" (naming convention).
  const castIn = input.cast && typeof input.cast === 'object' ? input.cast : prev.cast || {};
  const cast = Object.fromEntries(Object.entries(castIn)
    .map(([name, id]) => [String(name).trim().slice(0, 40), id])
    .filter(([name, id]) => name && !/^narrator$/i.test(name) && validVoiceId(id)).slice(0, 12));
  return { voice_id, tone, speed: SPEEDS.includes(sp) ? sp : 1, ...(Object.keys(cast).length ? { cast } : {}) };
}

// ── Music ───────────────────────────────────────────────────────────────────
// Each theme is a prompt for ACE-Step (instrumental only). The stock library
// (config/soundLibrary.json) holds one made-by-us track per theme, free to use.
export const MUSIC_THEMES = [
  { id: 'suspense', label: 'Suspense', prompt: 'tense suspenseful film score, pulsing low strings, ticking percussion, rising tension, dark synth drones' },
  { id: 'epic', label: 'Epic orchestral', prompt: 'epic orchestral film score, full orchestra, powerful brass, choir pads, big taiko drums, heroic and triumphant' },
  { id: 'horror', label: 'Horror', prompt: 'creepy horror film score, dissonant strings, eerie music box, deep drones, sudden stingers, unsettling' },
  { id: 'action', label: 'Action chase', prompt: 'fast action chase film score, driving drums, staccato strings, aggressive brass hits, high energy' },
  { id: 'romance', label: 'Romance', prompt: 'romantic film score, soft piano, warm strings, gentle and tender, emotional' },
  { id: 'sad', label: 'Sad piano', prompt: 'sad emotional solo piano with soft strings, slow, melancholic, heartfelt' },
  { id: 'hopeful', label: 'Hopeful', prompt: 'hopeful inspiring cinematic music, uplifting piano and strings, building to a warm climax' },
  { id: 'mystery', label: 'Mystery noir', prompt: 'mysterious noir jazz, muted trumpet, brushed drums, upright bass, smoky and slow' },
  { id: 'adventure', label: 'Adventure', prompt: 'adventurous orchestral score, sweeping strings, french horns, playful woodwinds, journey and discovery' },
  { id: 'comedy', label: 'Comedy', prompt: 'quirky comedic music, pizzicato strings, bassoon, xylophone, bouncy and playful' },
  { id: 'scifi', label: 'Sci-fi', prompt: 'futuristic sci-fi score, analog synthesizers, arpeggios, deep pulses, spacious and cold' },
  { id: 'fantasy', label: 'Fantasy', prompt: 'magical fantasy score, celesta, harp, flutes, soft choir, enchanted and wondrous' },
  { id: 'battle', label: 'Battle drums', prompt: 'war battle music, massive tribal drums, low brass, intense and aggressive rhythm' },
  { id: 'nollywood', label: 'Nollywood drama', prompt: 'African drama film score, emotional strings with talking drum and shekere, soulful and dramatic' },
  { id: 'afrobeat', label: 'Afrobeat', prompt: 'instrumental afrobeat groove, highlife guitars, horns, shekere, talking drum, energetic dance' },
  { id: 'highlife', label: 'Highlife', prompt: 'instrumental Ghanaian and Nigerian highlife, bright palm-wine guitar, light percussion, joyful' },
  { id: 'hiphop', label: 'Hip-hop beat', prompt: 'instrumental hip-hop beat, boom bap drums, deep bass, dusty samples, head-nodding' },
  { id: 'lofi', label: 'Lo-fi chill', prompt: 'lo-fi chill instrumental, mellow electric piano, vinyl crackle, soft drums, relaxed' },
  { id: 'ambient', label: 'Ambient', prompt: 'calm ambient soundscape, warm pads, slow evolving textures, peaceful' },
  { id: 'celebration', label: 'Celebration', prompt: 'joyful celebration music, upbeat brass, claps, bright percussion, festive party' },
  { id: 'documentary', label: 'Documentary', prompt: 'documentary background music, light piano, soft strings, steady pulse, thoughtful and neutral' },
  { id: 'kids', label: 'Kids', prompt: 'cheerful playful children music, ukulele, glockenspiel, whistles, happy and light' },
  { id: 'western', label: 'Western', prompt: 'spaghetti western film score, twangy guitar, whistling, harmonica, lonely desert' },
  { id: 'gospel', label: 'Gospel', prompt: 'instrumental gospel, hammond organ, piano, warm choir pads, uplifting and soulful' },
];
export const MOODS = ['dark', 'tense', 'sad', 'calm', 'warm', 'hopeful', 'joyful', 'playful', 'heroic', 'mysterious', 'romantic', 'intense'];
export const TEMPOS = { slow: 'slow tempo', medium: 'medium tempo', fast: 'fast tempo' };
export const MUSIC_LEVELS = { quiet: -85, low: -70, medium: -50, loud: -25 }; // Cloudinary e_volume (percent change)

export function musicPrompt({ theme, mood, tempo, instruments, custom } = {}) {
  const th = MUSIC_THEMES.find((t) => t.id === theme);
  const parts = [
    custom && String(custom).trim().slice(0, 300),
    th?.prompt,
    MOODS.includes(mood) && `${mood} mood`,
    TEMPOS[tempo],
    instruments && `featuring ${String(instruments).trim().slice(0, 150)}`,
    'instrumental, no vocals, film soundtrack',
  ].filter(Boolean);
  return parts.join(', ').slice(0, 900);
}

// ── Sound effects ───────────────────────────────────────────────────────────
export const SFX_MAX_SECONDS = 10;
export const SFX_PER_SHOT = 6;
export const SFX_LEVELS = { soft: -60, normal: 0, loud: 60 };
// Stock library: made once by scripts/buildSoundLibrary.js, free for every user.
export const SFX_LIBRARY = [
  ['household', 'Water poured into a cup', 'water poured from a jug into a ceramic cup, close up', 3],
  ['household', 'Cutlery on a plate', 'metal fork and knife scraping and clinking on a ceramic plate', 3],
  ['household', 'Door creak', 'old wooden door slowly creaking open', 3],
  ['household', 'Door slam', 'a wooden door slammed shut hard', 2],
  ['household', 'Knock on door', 'three firm knocks on a wooden door', 2],
  ['household', 'Glass breaking', 'a glass bottle shattering on a hard floor', 2],
  ['household', 'Phone ringing', 'an old mobile phone ringing', 4],
  ['household', 'Kettle whistle', 'a kettle boiling and whistling on a stove', 4],
  ['footsteps', 'Footsteps on wood', 'footsteps walking on a wooden floor, indoors', 4],
  ['footsteps', 'Footsteps on gravel', 'footsteps walking slowly on gravel', 4],
  ['footsteps', 'Running footsteps', 'someone running fast on pavement', 4],
  ['footsteps', 'High heels', 'high heels walking on a marble floor', 4],
  ['action', 'Gunshot', 'a single pistol gunshot echoing in a street', 2],
  ['action', 'Gunfire burst', 'automatic rifle gunfire burst', 3],
  ['action', 'Punch', 'a heavy punch hitting a body, movie fight', 1],
  ['action', 'Sword clash', 'two metal swords clashing', 2],
  ['action', 'Explosion', 'a big explosion with debris falling', 4],
  ['action', 'Whoosh', 'a fast cinematic whoosh', 1],
  ['vehicles', 'Tire screech', 'car tires screeching on asphalt', 3],
  ['vehicles', 'Car crash', 'a car crash with crunching metal and breaking glass', 3],
  ['vehicles', 'Car engine start', 'a car engine starting and idling', 4],
  ['vehicles', 'Police siren', 'police siren passing by', 5],
  ['vehicles', 'Car horn', 'a car horn honking twice', 2],
  ['vehicles', 'Motorcycle pass', 'a motorcycle passing by fast', 4],
  ['people', 'Scream', 'a woman screaming in fear', 2],
  ['people', 'Man shouting', 'a man shouting angrily', 2],
  ['people', 'Crowd cheering', 'a big crowd cheering and clapping', 5],
  ['people', 'Laughter', 'a small group of people laughing', 3],
  ['people', 'Baby crying', 'a baby crying', 4],
  ['people', 'Gasp', 'a person gasping in shock', 1],
  ['people', 'Heartbeat', 'a slow loud heartbeat', 4],
  ['nature', 'Rain', 'steady rain falling on a roof', 6],
  ['nature', 'Thunder', 'a loud thunder crack and rumble', 4],
  ['nature', 'Wind', 'strong wind howling', 6],
  ['nature', 'Birds morning', 'birds singing in the morning', 6],
  ['nature', 'Ocean waves', 'ocean waves on a beach', 6],
  ['nature', 'Fire crackling', 'a wood fire crackling', 6],
  ['nature', 'Night crickets', 'crickets at night', 6],
  ['nature', 'Dog barking', 'a dog barking', 3],
  ['ambience', 'Busy market', 'a busy African open market, people talking, distant traffic', 6],
  ['ambience', 'City traffic', 'busy city traffic with horns', 6],
  ['ambience', 'Office', 'quiet office with typing and distant phones', 6],
  ['ambience', 'Restaurant', 'restaurant chatter with cutlery', 6],
  ['ambience', 'Church bells', 'church bells ringing', 5],
  ['cinematic', 'Boom hit', 'deep cinematic boom impact for a trailer', 3],
  ['cinematic', 'Riser', 'cinematic tension riser building up', 5],
  ['cinematic', 'Horror sting', 'a sharp horror stinger, screeching violins', 2],
  ['cinematic', 'Magic sparkle', 'a magical sparkle chime', 2],
  ['cinematic', 'Camera shutter', 'a camera shutter click', 1],
  ['cinematic', 'Clock ticking', 'a clock ticking', 5],
].map(([category, label, prompt, seconds]) => ({ id: label.toLowerCase().replace(/[^a-z0-9]+/g, '-'), category, label, prompt, seconds }));
export const SFX_CATEGORIES = ['household', 'footsteps', 'action', 'vehicles', 'people', 'nature', 'ambience', 'cinematic'];

// ── Looks (colour grades) ───────────────────────────────────────────────────
// Each look is a function of (r, g, b) in 0..1 → [r, g, b]; utils/luts.js
// writes it as a 3D LUT and Cloudinary applies it to every frame.
const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const clamp = (v) => Math.max(0, Math.min(1, v));
const sat = (r, g, b, s) => { const l = lum(r, g, b); return [l + (r - l) * s, l + (g - l) * s, l + (b - l) * s]; };
const contrast = (v, c) => (v - 0.5) * c + 0.5;
const curve = (v, c) => clamp(contrast(v, c));
export const LOOKS = {
  cinematic: { label: 'Cinematic', about: 'Teal shadows, warm skin', fn: (r, g, b) => { const l = lum(r, g, b); const t = 1 - l; return [curve(r + 0.08 * l - 0.05 * t, 1.12), curve(g + 0.02 * l + 0.02 * t, 1.1), curve(b - 0.06 * l + 0.1 * t, 1.1)]; } },
  noir: { label: 'Noir', about: 'Black and white, hard contrast', fn: (r, g, b) => { const l = curve(lum(r, g, b), 1.45); return [l, l, l]; } },
  bw: { label: 'Black & white', about: 'Soft monochrome', fn: (r, g, b) => { const l = lum(r, g, b); return [l, l, l]; } },
  sepia: { label: 'Sepia', about: 'Old photograph', fn: (r, g, b) => [r * 0.393 + g * 0.769 + b * 0.189, r * 0.349 + g * 0.686 + b * 0.168, r * 0.272 + g * 0.534 + b * 0.131].map(clamp) },
  vintage: { label: 'Vintage film', about: 'Faded, warm, lifted blacks', fn: (r, g, b) => { const [a, c, d] = sat(r, g, b, 0.75); return [clamp(0.08 + a * 0.88 + 0.03), clamp(0.07 + c * 0.86), clamp(0.1 + d * 0.78)]; } },
  golden: { label: 'Golden hour', about: 'Warm sunset glow', fn: (r, g, b) => [clamp(r * 1.12 + 0.04), clamp(g * 1.02 + 0.02), clamp(b * 0.82)] },
  night: { label: 'Cold night', about: 'Blue moonlight', fn: (r, g, b) => { const [a, c, d] = sat(r, g, b, 0.6); return [clamp(a * 0.75), clamp(c * 0.88), clamp(d * 1.1 + 0.06)]; } },
  blue: { label: 'Blue screen', about: 'Whole picture tinted blue', fn: (r, g, b) => { const l = lum(r, g, b); return [clamp(l * 0.25), clamp(l * 0.45), clamp(0.15 + l * 1.0)]; } },
  red: { label: 'Red alert', about: 'Whole picture tinted red', fn: (r, g, b) => { const l = lum(r, g, b); return [clamp(0.12 + l * 1.0), clamp(l * 0.25), clamp(l * 0.22)]; } },
  green: { label: 'Matrix green', about: 'Green digital tint', fn: (r, g, b) => { const l = curve(lum(r, g, b), 1.2); return [clamp(l * 0.3), clamp(0.05 + l * 1.0), clamp(l * 0.35)]; } },
  horror: { label: 'Horror', about: 'Sickly, drained, crushed blacks', fn: (r, g, b) => { const [a, c, d] = sat(r, g, b, 0.35); return [curve(a * 0.9, 1.3), curve(c * 1.02 + 0.02, 1.3), curve(d * 0.95 + 0.02, 1.3)]; } },
  bleach: { label: 'Bleach bypass', about: 'Gritty, silvery war film', fn: (r, g, b) => { const [a, c, d] = sat(r, g, b, 0.45); return [curve(a, 1.35), curve(c, 1.35), curve(d, 1.35)]; } },
  dream: { label: 'Dreamy', about: 'Soft pastel haze', fn: (r, g, b) => [clamp(0.12 + r * 0.85 + 0.03), clamp(0.1 + g * 0.82), clamp(0.14 + b * 0.84)] },
  vivid: { label: 'Vivid', about: 'Punchy, saturated colour', fn: (r, g, b) => sat(r, g, b, 1.45).map((v) => curve(v, 1.08)) },
  sunset: { label: 'Magenta dusk', about: 'Pink and purple evening', fn: (r, g, b) => [clamp(r * 1.08 + 0.05), clamp(g * 0.85), clamp(b * 1.05 + 0.06)] },
};
export const LOOK_STRENGTHS = { light: 0.4, medium: 0.7, full: 1 };

// ── Light & colour BEFORE generation: words in the shot's prompt ────────────
export const LIGHTING = [
  { id: 'daylight', label: 'Bright daylight', text: 'bright natural daylight, soft shadows' },
  { id: 'golden', label: 'Golden hour', text: 'warm golden-hour sunlight, long soft shadows, glowing rim light' },
  { id: 'bluehour', label: 'Blue hour', text: 'cool blue-hour twilight, soft even light, city lights coming on' },
  { id: 'overcast', label: 'Overcast', text: 'flat overcast light, muted colours, soft and grey' },
  { id: 'moonlight', label: 'Moonlight', text: 'cold blue moonlight, deep shadows, night' },
  { id: 'candle', label: 'Candlelight', text: 'warm flickering candlelight, dark surroundings, orange glow on faces' },
  { id: 'neon', label: 'Neon night', text: 'neon lights in magenta and cyan, wet reflective streets, night' },
  { id: 'lowkey', label: 'Low-key drama', text: 'low-key dramatic lighting, one hard side light, deep black shadows (chiaroscuro)' },
  { id: 'highkey', label: 'High-key bright', text: 'high-key lighting, bright and airy, almost no shadows' },
  { id: 'backlit', label: 'Backlit silhouette', text: 'strong backlight, subject in silhouette, glowing edges' },
  { id: 'fire', label: 'Firelight', text: 'flickering orange firelight from below, smoke in the air' },
  { id: 'storm', label: 'Stormy', text: 'dark stormy light, lightning flashes, rain' },
  { id: 'studio', label: 'Studio soft', text: 'soft three-point studio lighting, clean and even' },
  { id: 'police', label: 'Police lights', text: 'flashing red and blue police lights at night' },
  { id: 'underwater', label: 'Underwater', text: 'underwater light, blue-green rays from above, floating particles' },
];
export const LIGHT_COLOURS = [
  { id: 'warm', label: 'Warm orange', text: 'warm orange key light' },
  { id: 'cool', label: 'Cool blue', text: 'cool blue key light' },
  { id: 'red', label: 'Red', text: 'deep red light' },
  { id: 'green', label: 'Green', text: 'eerie green light' },
  { id: 'purple', label: 'Purple', text: 'purple and violet light' },
  { id: 'pink', label: 'Pink', text: 'soft pink light' },
  { id: 'teal', label: 'Teal', text: 'teal and cyan light' },
  { id: 'gold', label: 'Gold', text: 'rich golden light' },
  { id: 'white', label: 'Clean white', text: 'clean neutral white light' },
];
const LIGHT_BY_ID = Object.fromEntries(LIGHTING.map((l) => [l.id, l]));
const COLOUR_BY_ID = Object.fromEntries(LIGHT_COLOURS.map((l) => [l.id, l]));
export function cleanLight(input) {
  if (!input || typeof input !== 'object') return null;
  const preset = LIGHT_BY_ID[input.preset] ? input.preset : null;
  const colour = COLOUR_BY_ID[input.colour] ? input.colour : null;
  return preset || colour ? { preset, colour } : null;
}
/** Words for the prompt: "Lighting: warm golden-hour sunlight…, rich golden light." */
export function lightText(light) {
  if (!light) return '';
  const words = [LIGHT_BY_ID[light.preset]?.text, COLOUR_BY_ID[light.colour]?.text].filter(Boolean).join(', ');
  return words ? `Lighting: ${words}.` : '';
}

// ── Colour grade AFTER generation: fine-tuning on top of a look ──────────────
// Every value is -100..100 (0 = unchanged). Applied inside the same LUT as the look.
export const GRADE_KEYS = ['warmth', 'tint', 'hue', 'brightness', 'contrast', 'saturation'];
export function cleanGrade(input) {
  if (!input || typeof input !== 'object') return null;
  const g = {};
  for (const k of GRADE_KEYS) {
    const v = Math.round(Math.max(-100, Math.min(100, Number(input[k]) || 0)) / 5) * 5;
    if (v) g[k] = v;
  }
  return Object.keys(g).length ? g : null;
}
function hueRotate(r, g, b, deg) {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  // Rotation around the grey axis (luminance-preserving matrix).
  return [
    r * (0.213 + c * 0.787 - s * 0.213) + g * (0.715 - c * 0.715 - s * 0.715) + b * (0.072 - c * 0.072 + s * 0.928),
    r * (0.213 - c * 0.213 + s * 0.143) + g * (0.715 + c * 0.285 + s * 0.14) + b * (0.072 - c * 0.072 - s * 0.283),
    r * (0.213 - c * 0.213 - s * 0.787) + g * (0.715 - c * 0.715 + s * 0.715) + b * (0.072 + c * 0.928 + s * 0.072),
  ];
}
export function gradeFn(grade) {
  const g = grade || {};
  const w = (g.warmth || 0) / 100, t = (g.tint || 0) / 100, h = (g.hue || 0) * 1.8; // ±180°
  const br = (g.brightness || 0) / 100, ct = 1 + (g.contrast || 0) / 150, st = 1 + (g.saturation || 0) / 100;
  return (r, gg, b) => {
    let c = [r + 0.12 * w, gg, b - 0.12 * w];
    if (t > 0) { c[0] += 0.06 * t; c[1] -= 0.04 * t; c[2] += 0.06 * t; } // positive tint = magenta
    else if (t < 0) c[1] += 0.1 * -t; // negative = green
    if (h) c = hueRotate(...c, h);
    c = sat(...c, st);
    return c.map((v) => clamp(contrast(v + br * 0.25, ct)));
  };
}
export const ASPECTS = { landscape: [1280, 720], portrait: [720, 1280], square: [1080, 1080] };

// Crop: zoom into the clip and choose where (3×3 anchor). Stored as fractions.
export const ZOOMS = [1, 1.25, 1.5, 2];
export const ANCHORS = ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right'];
export function cropRect({ zoom = 1, anchor = 'center' } = {}) {
  const z = ZOOMS.includes(Number(zoom)) ? Number(zoom) : 1;
  if (z === 1) return null;
  const w = 1 / z, free = 1 - w;
  const a = ANCHORS.includes(anchor) ? anchor : 'center';
  const x = a.includes('left') ? 0 : a.includes('right') ? free : free / 2;
  const y = a.startsWith('top') ? 0 : a.startsWith('bottom') ? free : free / 2;
  return { x: +x.toFixed(4), y: +y.toFixed(4), w: +w.toFixed(4), h: +w.toFixed(4) };
}

/** A shot's picture edit: { zoom, anchor, look|null ('none' = no look even if the video has one), strength, clip_audio }. */
export function cleanEdit(input = {}, prev = {}) {
  const e = { ...prev };
  if (input.zoom !== undefined) e.zoom = ZOOMS.includes(Number(input.zoom)) ? Number(input.zoom) : 1;
  if (input.anchor !== undefined) e.anchor = ANCHORS.includes(input.anchor) ? input.anchor : 'center';
  if (input.look !== undefined) e.look = input.look === 'none' || LOOKS[input.look] ? input.look : null;
  if (input.strength !== undefined) e.strength = LOOK_STRENGTHS[input.strength] ? input.strength : 'full';
  if (input.clip_audio !== undefined) e.clip_audio = ['keep', 'low', 'mute'].includes(input.clip_audio) ? input.clip_audio : 'keep';
  if (input.grade !== undefined) e.grade = cleanGrade(input.grade);
  return e;
}

/** The whole video's finish: { look, strength, grade, vignette, music_level }. */
export function cleanFinish(input = {}, prev = {}) {
  const f = { ...prev };
  if (input.look !== undefined) f.look = LOOKS[input.look] ? input.look : null;
  if (input.strength !== undefined) f.strength = LOOK_STRENGTHS[input.strength] ? input.strength : 'full';
  if (input.grade !== undefined) f.grade = cleanGrade(input.grade);
  if (input.vignette !== undefined) f.vignette = !!input.vignette;
  if (input.music_level !== undefined) f.music_level = MUSIC_LEVELS[input.music_level] !== undefined ? input.music_level : 'low';
  return f;
}

/** A shot's sound effects: [{ id, label, url, public_id, seconds, lead_in, at, level }]. */
export function cleanSfx(list, shotSeconds = 15) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, SFX_PER_SHOT).map((x) => ({
    id: String(x?.id || '').slice(0, 80) || null,
    label: String(x?.label || 'Sound').slice(0, 60),
    url: /^https:\/\/res\.cloudinary\.com\//.test(String(x?.url || '')) ? String(x.url) : null,
    public_id: x?.public_id ? String(x.public_id).slice(0, 200) : null,
    seconds: Math.max(0, Math.min(30, Number(x?.seconds) || 0)),
    lead_in: Math.max(0, Math.min(10, Number(x?.lead_in) || 0)),
    at: Math.max(0, Math.min(shotSeconds, Math.round((Number(x?.at) || 0) * 10) / 10)),
    level: SFX_LEVELS[x?.level] !== undefined ? x.level : 'normal',
  })).filter((x) => x.url);
}
