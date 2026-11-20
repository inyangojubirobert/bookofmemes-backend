// Re-measures real cost, wait and output length of media models on Runware,
// to keep config/mediaCapabilities.js honest. Costs real money (≈ $0.20 per
// video clip, $0.002–0.15 per song), so run only what you need:
//
//   node --env-file=.env scripts/measureMedia.js video bytedance:seedance@2.0-mini 864x496 5
//   node --env-file=.env scripts/measureMedia.js music runware:ace-step@v1.5-xl-turbo 60
//
// Prints one line per run; copy the numbers into mediaCapabilities.js with today's date.
import crypto from 'crypto';

const KEY = process.env.RUNWARE_API_KEY;
if (!KEY) { console.error('RUNWARE_API_KEY is not set'); process.exit(1); }
const call = async (tasks) => (await fetch('https://api.runware.ai/v1', {
  method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(tasks),
})).json();

const [kind, model, a, b] = process.argv.slice(2);
let task;
if (kind === 'video') {
  const [width, height] = String(a || '864x496').split('x').map(Number);
  task = { taskType: 'videoInference', model, width, height, duration: Number(b) || 5, positivePrompt: 'A golden retriever in sunglasses skateboards down a sunny street, camera tracking alongside, cinematic' };
} else if (kind === 'music') {
  task = { taskType: 'audioInference', model, outputFormat: 'MP3', positivePrompt: 'Afrobeats love song, warm female vocals, 105 bpm', settings: { lyrics: '[Verse]\nMiles between us, phone light in the dark\n[Chorus]\nHeartbeat miles, I am counting every one' } };
  if (a) task.duration = Number(a);
} else {
  console.error('usage: measureMedia.js video|music <model> [...]'); process.exit(1);
}

const uuid = crypto.randomUUID();
const t0 = Date.now();
const sub = await call([{ ...task, taskUUID: uuid, numberResults: 1, deliveryMethod: 'async', includeCost: true }]);
if (sub.errors?.length) { console.log(`${model}: rejected: ${sub.errors[0].message}`); process.exit(1); }
for (let i = 0; i < 120; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const g = await call([{ taskType: 'getResponse', taskUUID: uuid }]);
  if (g.errors?.length) { console.log(`${model}: failed: ${g.errors[0].message}`); process.exit(1); }
  const r = g.data?.[0];
  if (r?.status === 'success') {
    console.log(`${model} ${kind} ${a || ''} ${b || ''}: cost $${r.cost}, wait ${Math.round((Date.now() - t0) / 1000)}s, ${r.videoURL || r.audioURL}`);
    console.log('Check the real length by uploading it to Cloudinary (it reports duration) or opening it in a player.');
    process.exit(0);
  }
}
console.log(`${model}: timed out after 10 minutes`);
process.exit(1);
