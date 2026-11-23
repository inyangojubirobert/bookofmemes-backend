// Auto Episode Engine pipeline (Mode 2). One episode = one video_projects row with
// mode 'auto'; its state lives in project.pipeline, so a server restart resumes it.
// A timer advances each running episode one unit of work at a time.
//
//   breakdown   script → title, cast, places, props, scenes, shots, lines, sounds   (episodeBreakdown)
//   cast        every name → a cast template; new ones get a reference picture       (image per picture)
//   keyframes   each shot drawn from its cast references, then checked against them  (keyframe per try, ≤3 tries)
//   storyboard  optional pause: the user reviews the keyframes before costly video
//   motion      clip shots → image-to-video jobs (from the keyframe); still shots → slow zoom/pan
//   voices      every line in its character's voice and tone (pronunciations applied) (voiceLine)
//   assemble    scenes rendered in parts (captions, fades, sounds), title + end cards, music (episodeRender)
//   ledger      the series' continuity ledger updated for the next episode            (episodeLedger)
//
// Credits are reserved before each paid call and committed only after it worked;
// a failure releases them. Out of credits → the episode waits ("needs_credits").
import fs from 'fs';
import crypto from 'crypto';
import { v2 as cloudinary } from 'cloudinary';
import { supabase } from '../config/db.js';
import { creditStatus, reserveCredits, commitCredits, releaseCredits } from './aiCredits.js';
import { creditsFor } from '../config/aiPlans.js';
import { callRunwareTasks } from './runwareClient.js';
import { createJob } from './studioJobs.js';
import { saveToGallery } from './gallery.js';
import { logGeneration } from './aiGenerationLog.js';
import { speakLine } from './soundMaker.js';
import { renderFilm, joinParts, makeCard, animateStill, imagePublicId } from './renderVideo.js';
import { AI_MODELS } from '../config/aiModels.js';
import { assembleShot, cleanAsset } from '../config/videoCast.js';
import { lightText, VOICES } from '../config/soundStudio.js';
import { breakdownScript, updateLedger, checkKeyframe, GENRE_PACKS, ART_STYLES, EPISODE_MODEL } from '../config/episodeEngine.js';

cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET });

let LIBRARY = { music: [], sfx: [] };
try { LIBRARY = JSON.parse(fs.readFileSync(new URL('../config/soundLibrary.json', import.meta.url), 'utf8')); } catch { /* library missing: no stock sounds */ }

export const STAGES = [
  { id: 'breakdown', label: 'Reading the script' },
  { id: 'cast', label: 'Casting characters and places' },
  { id: 'keyframes', label: 'Drawing and checking the keyframes' },
  { id: 'storyboard', label: 'Storyboard review' },
  { id: 'motion', label: 'Bringing the shots to life' },
  { id: 'voices', label: 'Recording the voices' },
  { id: 'assemble', label: 'Editing the episode' },
  { id: 'ledger', label: 'Updating the story bible' },
];
const NEXT = Object.fromEntries(STAGES.map((s, i) => [s.id, STAGES[i + 1]?.id || 'done']));
const now = () => new Date().toISOString();
const IMAGE_SIZE = { landscape: [1024, 576], portrait: [576, 1024], square: [1024, 1024] };
const MAX_KEYFRAME_TRIES = 2; // the first drawing + one automatic redraw if the check fails
const MOVE_BY_KIND = { establishing: 'pull', dialogue: 'push', reaction: 'close', action: 'pan', insert: 'close', transition: 'tilt' };

class Pause extends Error { constructor(code, message) { super(message); this.code = code; } }
class Refused extends Error { constructor(shot) { super('refused by the image safety filter'); this.shot = shot; } }
// Runware passes on the image model's moderation refusal as a 400.
const isRefusal = (err) => /content moderation|flagged|invalid content|nsfw|safety|not allowed/i.test(String(err?.message || ''));
/** The same templates with only physical looks: no story description, which can read as unsafe out of context. */
const looksOnly = (assets) => Object.fromEntries(Object.entries(assets).map(([id, a]) => [id, a.kind === 'character' ? { ...a, description: '' } : a]));

// ── Small helpers ───────────────────────────────────────────────────────────
async function load(id) {
  const { data } = await supabase.from('video_projects').select('*').eq('id', id).maybeSingle();
  return data;
}
async function shotsOf(id) {
  const { data } = await supabase.from('video_shots').select('*').eq('project_id', id).order('number');
  return data || [];
}
async function assetsOf(userId) {
  const { data } = await supabase.from('video_assets').select('*').eq('user_id', userId).limit(500);
  return Object.fromEntries((data || []).map((a) => [a.id, a]));
}
function log(p, text) {
  p.pipeline.log = [...(p.pipeline.log || []), { at: now(), text: String(text).slice(0, 300) }].slice(-60);
}
async function save(p, extra = {}) {
  p.pipeline.updated_at = now();
  const { error } = await supabase.from('video_projects').update({ pipeline: p.pipeline, updated_at: now(), ...extra }).eq('id', p.id);
  if (error) throw error;
  Object.assign(p, extra);
}
function progress(p, done, total, message) {
  p.pipeline.progress = { done, total };
  if (message) p.pipeline.message = message;
}

/** Reserve → work → commit; release on failure. Pauses the episode when credits run out. */
async function charged(p, action, { units = 1, key, opts = {} }, work) {
  const status = await creditStatus(p.user_id);
  if (!status.plan.premiumModels) throw new Pause('needs_plan', 'Auto episodes are part of the Bascardo AI Pro and Business plans.');
  const cost = creditsFor(action, { premium: true, ...opts }) * Math.max(1, units);
  const short = `This step needs ${cost} AI credits; you have ${status.remaining}. Get more credits, then tap Continue.`;
  if (status.remaining < cost) throw new Pause('needs_credits', short);
  const reservation = await reserveCredits(p.user_id, status.plan, cost, `ep:${p.id}:${key}:${crypto.randomUUID().slice(0, 8)}`, 30);
  if (!reservation) throw new Pause('needs_credits', short);
  try {
    const out = await work();
    await commitCredits(p.user_id, reservation);
    p.pipeline.credits_used = (p.pipeline.credits_used || 0) + cost;
    return out;
  } catch (err) {
    await releaseCredits(reservation);
    throw err;
  }
}

/** One FLUX.2 [pro] picture, kept on our Cloudinary. */
async function draw({ prompt, references = [], size, folder }) {
  const [width, height] = size;
  const model = AI_MODELS.IMAGE.PREMIUM;
  const task = {
    taskType: 'imageInference', taskUUID: crypto.randomUUID(), model, width, height, numberResults: 1, outputFormat: 'JPG', includeCost: true,
    positivePrompt: prompt.slice(0, 3000), ...(references.length ? { inputs: { referenceImages: references.slice(0, 9) } } : {}),
  };
  const { data } = await callRunwareTasks([task]);
  let r = data?.[0];
  // Under load Runware can answer before the picture is ready: collect it by its task id.
  for (let i = 0; !r?.imageURL && i < 20; i++) {
    await new Promise((x) => setTimeout(x, 4000));
    const { data: polled } = await callRunwareTasks([{ taskType: 'getResponse', taskUUID: task.taskUUID }]);
    const got = (polled || []).find((x) => x.imageURL) || polled?.[0];
    if (got?.status === 'error') throw new Error(got.errorMessage || 'The picture failed');
    if (got?.imageURL) r = got;
  }
  if (!r?.imageURL) throw new Error('No picture came back');
  const kept = await cloudinary.uploader.upload(r.imageURL, { folder, resource_type: 'image' });
  return { url: kept.secure_url, publicId: kept.public_id, cost: r.cost ?? null, model };
}

const styleOf = (p) => ART_STYLES[p.settings?.art_style]?.prompt || ART_STYLES.cinematic.prompt;
const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
const DEFAULT_VOICE = { male: ['adrian', 'tunde', 'chidi', 'edmund', 'jordan', 'max'], female: ['laura', 'adaeze', 'sarah', 'hannah', 'zara', 'selene'], child: ['kiki', 'amara'] };

// ── Stages ──────────────────────────────────────────────────────────────────
const STAGE_RUN = {
  async breakdown(p) {
    progress(p, 0, 1, 'Reading the script…');
    const assets = Object.values(await assetsOf(p.user_id));
    const { data: series } = p.series_id ? await supabase.from('video_series').select('*').eq('id', p.series_id).maybeSingle() : { data: null };
    const s = p.settings || {};
    const action = s.seconds > 120 ? 'episodeBreakdownLong' : 'episodeBreakdown';
    const r = await charged(p, action, { key: 'breakdown' }, () => breakdownScript({
      script: p.script, settings: s, ledger: series?.ledger || {},
      cast: assets.filter((a) => a.kind !== 'prop' || (s.cast_map && Object.values(s.cast_map).includes(a.id))).slice(0, 40).map((a) => ({ name: a.name, kind: a.kind, description: a.description })),
    }));
    const b = r.breakdown;
    logGeneration({ userId: p.user_id, feature: 'text', model: EPISODE_MODEL, provider: 'anthropic', tier: 'premium', success: true, inputPrompt: `episode:breakdown ${p.id}` }).catch?.(() => {});
    p.pipeline.breakdown = b;
    log(p, `Script read: "${b.title}", ${b.shots.length} shots in ${new Set(b.shots.map((x) => x.scene_no)).size} scenes, ${b.characters.length} characters.`);
    if (b.cut_note) log(p, `Kept for the next episode: ${b.cut_note}`);
    const seconds = b.shots.reduce((n, x) => n + x.duration_seconds, 0);
    const extra = {};
    if (s.music_auto && !p.music_url) {
      const theme = b.music_theme || (GENRE_PACKS[s.genre] || GENRE_PACKS.drama).music;
      const track = LIBRARY.music.find((m) => m.id === theme);
      if (track) { Object.assign(extra, { music_url: track.url, music_title: track.title, music_history: [{ url: track.url, title: track.title, at: now(), planned: true }] }); log(p, `Music: ${track.title}`); }
    }
    await save(p, { ...extra, title: b.title, logline: b.logline, fit_note: b.cut_note || null, target_seconds: Math.max(5, Math.min(600, Math.round(seconds))) });
    return true;
  },

  async cast(p) {
    const b = p.pipeline.breakdown;
    const s = p.settings || {};
    const assets = await assetsOf(p.user_id);
    const byName = (name, kind) => Object.values(assets).find((a) => a.kind === kind && sameName(a.name, name));
    p.pipeline.cast ||= {};
    const wanted = [
      ...b.characters.map((c) => ({ kind: 'character', name: c.name, src: c })),
      ...b.locations.map((l) => ({ kind: 'location', name: l.name, src: l })),
      ...b.props.filter((x) => x.hero).map((x) => ({ kind: 'prop', name: x.name, src: x })),
    ];
    // 1. Match: the user's own mapping, then a template with the same name.
    for (const w of wanted) {
      const key = `${w.kind}:${w.name}`;
      if (p.pipeline.cast[key]) continue;
      const mapped = s.cast_map?.[w.name] && assets[s.cast_map[w.name]]?.kind === w.kind ? s.cast_map[w.name] : null;
      const found = mapped || byName(w.name, w.kind)?.id;
      if (found) { p.pipeline.cast[key] = found; log(p, `${w.name} → your template "${assets[found].name}"`); }
    }
    // 2. Missing: a new draft template with a reference picture (up to 3 at a time).
    const todo = wanted.filter((w) => !p.pipeline.cast[`${w.kind}:${w.name}`]);
    progress(p, wanted.length - todo.length, wanted.length, todo.length ? `Casting ${todo.slice(0, 3).map((w) => w.name).join(', ')}…` : 'Cast ready');
    if (todo.length) {
      await Promise.all(todo.slice(0, 3).map((w) => charged(p, 'image', { key: `cast:${w.kind}:${w.name}` }, async () => {
        const c = w.src;
        const style = styleOf(p);
        const pic = w.kind === 'character'
          ? await draw({ size: [1024, 1024], folder: 'bookofmemes/video-studio/cast', prompt: `Character reference portrait for a film. ${c.name}: ${Object.values(c.traits || {}).join(', ')}. ${c.description}. Wearing ${c.outfit || 'everyday clothes'}. Head and shoulders, facing the camera, neutral expression, plain light-grey studio background, soft even light, sharp focus. ${style}${c.never_show?.length ? ` Avoid: ${c.never_show.join(', ')}.` : ''}` })
          : w.kind === 'location'
            ? await draw({ size: [1024, 576], folder: 'bookofmemes/video-studio/cast', prompt: `Establishing wide shot of a film location, no people. ${c.name}: ${c.description}. ${c.layout ? `Layout: ${c.layout}.` : ''} ${c.era ? `Era: ${c.era}.` : ''} ${style}` })
            : await draw({ size: [1024, 1024], folder: 'bookofmemes/video-studio/cast', prompt: `A single object on a plain white background, centred, studio product photo: ${c.name}, ${c.description}. ${style}` });
        const { row, error } = cleanAsset(w.kind, {
          name: c.name, description: c.description || '', traits: c.traits, never_show: c.never_show, layout: c.layout,
          refs: [{ slot: w.kind === 'character' ? 'front' : w.kind === 'location' ? 'wide' : 'cutout', url: pic.url }],
          states: w.kind === 'character' && c.outfit ? [{ name: 'Signature outfit', description: c.outfit }] : [],
          owns_rights: true,
        });
        if (error) throw new Error(error);
        const { data: a, error: e } = await supabase.from('video_assets').insert({ ...row, user_id: p.user_id }).select().single();
        if (e) throw e;
        p.pipeline.cast[`${w.kind}:${w.name}`] = a.id;
        assets[a.id] = a;
        saveToGallery({ userId: p.user_id, kind: 'image', url: pic.url, feature: 'image', prompt: `cast: ${c.name}`, model: pic.model, projectKind: 'video', projectId: p.id, role: 'cast', provider: 'runware', providerCost: pic.cost });
        log(p, `New template: ${c.name} (${w.kind})`);
      })));
      await save(p);
      return false; // more to cast, or shots to create on the next tick
    }

    // 3. Voices (kept per series) and the shots, compiled from the templates.
    const { data: series } = p.series_id ? await supabase.from('video_series').select('*').eq('id', p.series_id).maybeSingle() : { data: null };
    const bible = series?.bible || {};
    const voices = { ...(bible.voices || {}) };
    const narrator = s.narrator_voice || 'adrian';
    const used = new Set([narrator, ...Object.values(voices)]);
    // Who speaks with which voice, strongest first: the user's choice in setup (by script name,
    // may be a custom voice), the character template's own voice, the series, then a free pick.
    const chosen = (name) => Object.entries(s.voice_map || {}).find(([n]) => sameName(n, name))?.[1] || null;
    for (const c of b.characters) {
      const id = p.pipeline.cast[`character:${c.name}`];
      if (!id) continue;
      const pick = chosen(c.name) || assets[id]?.voice_id || voices[id]
        || (c.voice_id && !used.has(c.voice_id) ? c.voice_id : (DEFAULT_VOICE[c.gender] || DEFAULT_VOICE.male).find((v) => !used.has(v)) || c.voice_id || 'adrian');
      voices[id] = pick; used.add(pick);
      // The template remembers its voice, so the character sounds the same in every video and episode.
      if (assets[id] && assets[id].voice_id !== pick && (chosen(c.name) || !assets[id].voice_id)) {
        await supabase.from('video_assets').update({ voice_id: pick, updated_at: now() }).eq('id', id).eq('user_id', p.user_id);
      }
    }
    const pronounce = [...(bible.pronunciations || []), ...b.characters.filter((c) => c.say_as).map((c) => ({ name: c.name, say: c.say_as }))]
      .filter((x, i, all) => all.findIndex((y) => sameName(y.name, x.name)) === i).slice(0, 60);
    if (series) await supabase.from('video_series').update({ bible: { ...bible, voices, pronunciations: pronounce, cast: [...new Set([...(bible.cast || []), ...Object.values(p.pipeline.cast)])] }, updated_at: now() }).eq('id', series.id);
    const sayAs = (text) => pronounce.reduce((t, x) => t.replace(new RegExp(`\\b${x.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), x.say), text);
    const lib = (id) => LIBRARY.sfx.find((x) => x.id === id);
    const pack = GENRE_PACKS[s.genre] || GENRE_PACKS.drama;

    await supabase.from('video_shots').delete().eq('project_id', p.id); // a retry starts clean
    const rows = b.shots.map((x, i) => {
      const prev = b.shots[i - 1], next = b.shots[i + 1];
      const charId = (name) => p.pipeline.cast[`character:${name}`];
      const lines = x.lines.map((l) => {
        const aid = l.speaker === 'NARRATOR' ? null : charId(l.speaker);
        return { speaker: l.speaker, asset_id: aid || null, voice_id: aid ? voices[aid] : narrator, tone: l.tone || (l.speaker === 'NARRATOR' ? b.narrator_tone || pack.tone : null), text: l.text, say: sayAs(l.text) };
      });
      return {
        project_id: p.id, number: i + 1, scene_no: x.scene_no, kind: x.kind, motion: x.motion,
        scene: `Scene ${x.scene_no} · ${x.kind}`, visual: x.visual, action: x.action, camera: x.camera,
        narration: lines.map((l) => (l.speaker === 'NARRATOR' ? l.text : `${l.speaker}: ${l.text}`)).join(' ').slice(0, 400),
        duration_seconds: Math.max(1, Math.round(x.duration_seconds)), lines, light: x.light,
        cast_slots: {
          location: x.location && p.pipeline.cast[`location:${x.location}`] ? { id: p.pipeline.cast[`location:${x.location}`], state: null, facing: null } : undefined,
          characters: x.characters.map((c) => ({ id: charId(c.name), state: assets[charId(c.name)]?.states?.[0]?.name || null, pose: c.pose || null, expression: c.expression || null, position: c.position })).filter((c) => c.id),
          props: x.props.map((pr) => ({ id: p.pipeline.cast[`prop:${pr.name}`], state: pr.state || null, holder: pr.holder || null })).filter((pr) => pr.id),
        },
        sfx: x.sfx.map((f) => lib(f.id)).filter(Boolean).map((l, k) => ({ id: l.id, label: l.label, url: l.url, public_id: l.public_id, seconds: l.seconds, lead_in: l.lead_in, at: Math.min(x.sfx[k]?.at || 0, x.duration_seconds), level: 'normal' })),
        edit: { fade_in: !!prev && prev.scene_no !== x.scene_no, fade_out: !!next && next.scene_no !== x.scene_no, clip_audio: x.motion === 'clip' ? 'low' : 'keep' },
        status: 'planned', source: 'ai', included: true,
      };
    });
    const { error } = await supabase.from('video_shots').insert(rows);
    if (error) throw error;
    log(p, `Storyboard planned: ${rows.length} shots, ${rows.filter((r) => r.motion === 'clip').length} moving clips.`);
    return true;
  },

  async keyframes(p) {
    const shots = (await shotsOf(p.id)).filter((x) => x.included);
    const assets = await assetsOf(p.user_id);
    const todo = shots.filter((x) => !x.still_url || (x.qc && !x.qc.ok && (x.qc.tries || 0) < MAX_KEYFRAME_TRIES));
    progress(p, shots.length - todo.length, shots.length, todo.length ? `Drawing shot ${todo[0].number} of ${shots.length}…` : 'Keyframes ready');
    if (!todo.length) return true;
    const [width, height] = IMAGE_SIZE[p.aspect] || IMAGE_SIZE.landscape;
    const results = await Promise.allSettled(todo.slice(0, 3).map((shot) => ({ shot, a0: assembleShot(p, shot, assets, { maxChars: 2800 }) })).map(({ shot, a0 }) => charged(p, 'keyframe', { key: `kf:${shot.number}`, opts: { refs: a0.references.length } }, async () => {
      let a = a0;
      let prompt = `A single film frame from an episode. ${lightText(shot.light)}\n${a.prompt}`;
      let pic;
      try { pic = await draw({ prompt, references: a.references, size: [width, height], folder: 'bookofmemes/video-studio/keyframes' }); }
      catch (err) {
        if (!isRefusal(err)) throw err;
        // The image model's safety filter refused it. Story descriptions (e.g. a teenager "who sells
        // pieces of herself") can read as unsafe out of context: retry once with only how people look.
        a = assembleShot(p, shot, looksOnly(assets), { maxChars: 2800 });
        prompt = `A single film frame from an episode. ${lightText(shot.light)}\n${a.prompt}`;
        try {
          pic = await draw({ prompt, references: a.references, size: [width, height], folder: 'bookofmemes/video-studio/keyframes' });
          log(p, `Shot ${shot.number}: drawn from the characters' looks only (the image model's safety filter refused the full description).`);
        } catch (err2) {
          if (!isRefusal(err2)) throw err2;
          // Still refused: the filter objects to a character's reference PICTURES (tested 2026-11-23:
          // the same shot passed without them). Draw it from the place/props pictures and the
          // characters' written looks; the face may vary a little.
          const charPics = new Set((shot.cast_slots?.characters || []).flatMap((c) => [...(assets[c.id]?.refs || []).map((r) => r.url), ...(assets[c.id]?.states || []).map((x) => x.url)]).filter(Boolean));
          const refs = a.references.filter((u) => !charPics.has(u));
          try { pic = await draw({ prompt, references: refs, size: [width, height], folder: 'bookofmemes/video-studio/keyframes' }); }
          catch (err3) { if (isRefusal(err3)) throw new Refused(shot); throw err3; }
          a = { ...a, references: refs };
          const who = (shot.cast_slots?.characters || []).map((c) => assets[c.id]?.name).filter(Boolean).join(', ');
          log(p, `Shot ${shot.number}: the image model's safety filter refuses the reference pictures of ${who || 'a character'}, so it was drawn from their written looks (the face may vary). Replacing those pictures in the Cast library fixes it.`);
        }
      }
      // Continuity check against each character's reference picture and the never-show list.
      const chars = (shot.cast_slots?.characters || []).map((c) => ({ name: assets[c.id]?.name, ref: assets[c.id]?.refs?.find((r) => r.slot === 'front')?.url })).filter((c) => c.name);
      const qc = await checkKeyframe({ keyframeUrl: pic.url, characters: chars, avoid: a.avoid }).catch(() => ({ ok: true, notes: 'check skipped' }));
      const tries = (shot.qc?.tries || 0) + 1;
      const versions = Object.fromEntries(Object.values(assets).filter((x) => a.labels.some((l) => l.startsWith(x.name))).map((x) => [x.id, x.updated_at]));
      await supabase.from('video_shots').update({
        still_url: pic.url, start_image_url: shot.motion === 'clip' ? pic.url : null, qc: { ok: qc.ok, notes: qc.notes, tries },
        compiled: { prompt, references: a.references, labels: a.labels, asset_versions: versions, model: pic.model }, updated_at: now(),
      }).eq('id', shot.id);
      saveToGallery({ userId: p.user_id, kind: 'image', url: pic.url, feature: 'image', prompt, model: pic.model, projectKind: 'video', projectId: p.id, role: 'still', provider: 'runware', providerCost: pic.cost });
      if (!qc.ok) log(p, `Shot ${shot.number}: ${tries < MAX_KEYFRAME_TRIES ? 'redrawing' : 'kept, please review'} (${qc.notes})`);
    })));
    // A refused shot is left out (not charged) and the episode carries on; anything else is retried.
    for (const r of results) {
      if (r.status === 'fulfilled') continue;
      if (r.reason instanceof Refused) {
        const shot = r.reason.shot;
        if (shot.still_url) {
          // A redraw (after a failed check) was refused: keep the drawing it already had.
          await supabase.from('video_shots').update({ qc: { ok: false, notes: `${shot.qc?.notes || 'Check this shot'}. Kept the first drawing: the redraw was refused by the image model's safety filter.`, tries: MAX_KEYFRAME_TRIES }, updated_at: now() }).eq('id', shot.id);
          log(p, `Shot ${shot.number}: kept its first drawing (the redraw was refused); please check it.`);
          continue;
        }
        await supabase.from('video_shots').update({ included: false, qc: { ok: false, refused: true, notes: "The image model's safety filter refused this shot. Change its description and redraw it in the Video Studio.", tries: (shot.qc?.tries || 0) + 1 }, updated_at: now() }).eq('id', shot.id);
        log(p, `Shot ${shot.number} left out: the image model's safety filter refused it even from the characters' looks (not charged). Rewrite it and redraw it in the Video Studio to put it back.`);
      } else throw r.reason;
    }
    return false;
  },

  async storyboard(p) {
    if (!p.settings?.review_storyboard || p.pipeline.storyboard_approved) return true;
    p.pipeline.status = 'waiting';
    p.pipeline.message = 'Check the keyframes, redraw any you don\'t like, then tap Continue to bring them to life.';
    return false;
  },

  async motion(p) {
    const shots = (await shotsOf(p.id)).filter((x) => x.included);
    const ready = shots.filter((x) => x.status === 'ready' && x.clip_public_id);
    progress(p, ready.length, shots.length, ready.length < shots.length ? `Animating shots (${ready.length}/${shots.length})…` : 'All shots moving');
    if (ready.length === shots.length) return true;
    const status = await creditStatus(p.user_id);
    // Moving clips: image-to-video from the keyframe, as background jobs (same runner as Mode 1).
    for (const shot of shots.filter((x) => x.motion === 'clip' && x.status === 'planned' && x.still_url).slice(0, 4)) {
      const cost = creditsFor('video', { premium: true, reference: true });
      if (status.remaining < cost) throw new Pause('needs_credits', `A moving clip needs ${cost} AI credits; you have ${status.remaining}. Get more credits, then tap Continue.`);
      const reservation = await reserveCredits(p.user_id, status.plan, cost, `ep:${p.id}:clip:${shot.number}:${crypto.randomUUID().slice(0, 6)}`, 30);
      if (!reservation) throw new Pause('needs_credits', 'Not enough AI credits for the moving clips.');
      try {
        const { job } = await createJob({
          userId: p.user_id, requestId: `epclip:${shot.id}:${(shot.qc?.tries || 0)}`, kind: 'video_clip',
          input: { prompt: shot.compiled?.prompt?.slice(0, 1000) || shot.visual, hd: false, premium: true, referenceImageUrl: shot.still_url, referenceImages: null, tier: status.plan.id, role: 'shot', shot_id: shot.id },
          projectKind: 'video', projectId: p.id, reservation, credits: cost,
        });
        await supabase.from('video_shots').update({ status: 'generating', job_id: job.id, updated_at: now() }).eq('id', shot.id);
        p.pipeline.credits_used = (p.pipeline.credits_used || 0) + cost;
        status.remaining -= cost;
      } catch (err) { await releaseCredits(reservation); throw err; }
    }
    // A clip that failed (not charged) becomes an animated still instead.
    for (const shot of shots.filter((x) => x.motion === 'clip' && x.status === 'failed')) {
      await supabase.from('video_shots').update({ motion: 'still', status: 'planned', updated_at: now() }).eq('id', shot.id);
      log(p, `Shot ${shot.number}: the moving clip failed (not charged); using an animated still.`);
    }
    // Animated stills: a slow camera move over the keyframe, exactly as long as the shot.
    const stills = shots.filter((x) => x.motion !== 'clip' && x.status === 'planned' && x.still_url).slice(0, 4);
    await Promise.all(stills.map((shot) => charged(p, 'stillMotion', { key: `mv:${shot.number}` }, async () => {
      const imageId = imagePublicId(shot.still_url);
      if (!imageId) throw new Error('keyframe is not on our Cloudinary');
      const v = await animateStill({ imageId, seconds: Number(shot.duration_seconds) || 4, move: MOVE_BY_KIND[shot.kind] || 'push', aspect: p.aspect });
      await supabase.from('video_shots').update({ clip_url: v.url, clip_public_id: v.publicId, status: 'ready', source: 'still', updated_at: now() }).eq('id', shot.id);
    })));
    return false;
  },

  async voices(p) {
    const shots = (await shotsOf(p.id)).filter((x) => x.included);
    const all = shots.flatMap((x) => (x.lines || []).map((l, i) => ({ shot: x, l, i })));
    const todo = all.filter(({ l }) => !l.url);
    progress(p, all.length - todo.length, all.length, todo.length ? `Recording line ${all.length - todo.length + 1} of ${all.length}…` : 'Voices recorded');
    if (!todo.length) return true;
    const batch = todo.slice(0, 6);
    await charged(p, 'voiceLine', { units: batch.length, key: `vo:${batch[0].shot.number}:${batch[0].i}` }, async () => {
      const results = await Promise.all(batch.map(({ l }) => speakLine(l.say || l.text, { voiceId: l.voice_id, tone: l.tone || 'natural', userId: p.user_id })));
      const byShot = new Map();
      batch.forEach(({ shot, i }, k) => {
        const lines = byShot.get(shot.id) || [...shot.lines];
        lines[i] = { ...lines[i], url: results[k].url, public_id: results[k].public_id, seconds: results[k].seconds, lead_in: results[k].lead_in };
        byShot.set(shot.id, lines);
      });
      for (const [id, lines] of byShot) await supabase.from('video_shots').update({ lines, updated_at: now() }).eq('id', id);
    });
    return false;
  },

  async assemble(p) {
    const shots = (await shotsOf(p.id)).filter((x) => x.included && x.status === 'ready' && x.clip_public_id);
    // Parts of ≤4 shots, never across a scene (each keeps its Cloudinary URL short).
    const groups = [];
    for (const x of shots) {
      const g = groups[groups.length - 1];
      if (g && g[0].scene_no === x.scene_no && g.length < 4) g.push(x); else groups.push([x]);
    }
    p.pipeline.parts ||= [];
    progress(p, p.pipeline.parts.length, groups.length + 1, `Editing part ${Math.min(p.pipeline.parts.length + 1, groups.length)} of ${groups.length}…`);
    if (p.pipeline.parts.length < groups.length) {
      const g = groups[p.pipeline.parts.length];
      const r = await renderFilm({ shots: g, project: p, folder: 'bookofmemes/video-studio/episode-parts' });
      await Promise.all(Object.entries(r.caches).map(([id, cache]) => supabase.from('video_shots').update({ edit_cache: cache }).eq('id', id)));
      p.pipeline.parts.push({ publicId: r.publicId, seconds: r.seconds, shots: g.map((x) => x.number) });
      return false;
    }
    await charged(p, 'episodeRender', { key: 'render' }, async () => {
      const b = p.pipeline.breakdown || {};
      const { data: series } = p.series_id ? await supabase.from('video_series').select('title').eq('id', p.series_id).maybeSingle() : { data: null };
      const base = imagePublicId(shots[0]?.still_url);
      const parts = [...p.pipeline.parts];
      if (base && p.settings?.title_card !== false) parts.unshift(await makeCard({ baseImageId: base, aspect: p.aspect, seconds: 3, lines: [series?.title || p.title, p.episode_number ? `Episode ${p.episode_number}` : '', series ? p.title : ''] }));
      if (base && b.cliffhanger && p.settings?.cliffhanger !== false) parts.push(await makeCard({ baseImageId: base, aspect: p.aspect, seconds: 3, lines: [b.cliffhanger, 'Next episode…'] }));
      const music = p.music_url ? LIBRARY.music.find((m) => m.url === p.music_url) : null;
      const musicId = music ? music.url.match(/upload\/(?:v\d+\/)?(.+)\.[a-z0-9]+$/i)?.[1] : null;
      const r = await joinParts({ parts, musicPublicId: musicId, musicLevel: p.finish?.music_level || 'low', aspect: p.aspect });
      await save(p, { render_url: r.url, render_seconds: r.seconds, status: 'rendered' });
      saveToGallery({ userId: p.user_id, kind: 'video', url: r.url, feature: 'video', prompt: p.title, model: 'episode', durationSeconds: r.seconds, projectKind: 'video', projectId: p.id, role: 'render', provider: 'cloudinary' });
      p.pipeline.thumbnail = shots[0]?.still_url || null;
      log(p, `Episode ready: ${Math.round(r.seconds)} seconds.`);
    });
    return true;
  },

  async ledger(p) {
    if (!p.series_id) return true;
    const { data: series } = await supabase.from('video_series').select('*').eq('id', p.series_id).maybeSingle();
    if (!series) return true;
    await charged(p, 'episodeLedger', { key: 'ledger' }, async () => {
      const r = await updateLedger({ ledger: series.ledger || {}, breakdown: p.pipeline.breakdown, episodeNumber: p.episode_number || series.episode_count + 1 });
      await supabase.from('video_series').update({ ledger: r.ledger, episode_count: Math.max(series.episode_count, p.episode_number || 0), updated_at: now() }).eq('id', series.id);
      log(p, 'Story bible updated for the next episode.');
    });
    return true;
  },
};

/** Runs one unit of work on an episode. Returns true when something happened. */
export async function advanceEpisode(id) {
  const p = await load(id);
  if (!p || p.engine !== 'auto' || p.pipeline?.status !== 'running') return false;
  p.pipeline ||= {};
  const stage = p.pipeline.stage || 'breakdown';
  if (stage === 'done') return false;
  try {
    const finished = await STAGE_RUN[stage](p);
    if (finished) {
      log(p, `✔ ${STAGES.find((x) => x.id === stage)?.label}`);
      p.pipeline.stage = NEXT[stage];
      p.pipeline.fails = {};
      if (p.pipeline.stage === 'done') { p.pipeline.status = 'done'; p.pipeline.finished_at = now(); p.pipeline.message = 'Your episode is ready.'; }
    }
    await save(p);
    return true;
  } catch (err) {
    if (err instanceof Pause) {
      p.pipeline.status = err.code; p.pipeline.message = err.message;
      log(p, err.message);
      await save(p);
      return true;
    }
    const fails = { ...(p.pipeline.fails || {}) };
    fails[stage] = (fails[stage] || 0) + 1;
    p.pipeline.fails = fails;
    console.error(`[episode] ${p.id} ${stage} (try ${fails[stage]}):`, err.message);
    log(p, `${STAGES.find((x) => x.id === stage)?.label}: ${err.status ? err.message : 'a step failed'}; ${fails[stage] < 4 ? 'trying again' : 'stopped'} (you're not charged for failed steps).`);
    if (fails[stage] >= 4) { p.pipeline.status = 'failed'; p.pipeline.message = `Stopped at "${STAGES.find((x) => x.id === stage)?.label}". Tap Continue to try again.`; }
    await save(p).catch(() => {});
    return true;
  }
}

// ── Runner: a timer in this process (like the studio jobs) ─────────────────
const busy = new Set();
let timer = null;
async function tick() {
  try {
    const { data, error } = await supabase.from('video_projects').select('id').eq('engine', 'auto').eq('pipeline->>status', 'running').order('updated_at').limit(6);
    if (error) { if (!/column|engine|PGRST/i.test(error.message)) console.error('[episode] tick:', error.message); return; }
    await Promise.all((data || []).filter((r) => !busy.has(r.id)).slice(0, 3).map(async (r) => {
      busy.add(r.id);
      try { await advanceEpisode(r.id); } finally { busy.delete(r.id); }
    }));
  } catch (err) { console.error('[episode] tick failed:', err.message); }
}
export function startEpisodeRunner() {
  if (timer) return;
  timer = setInterval(tick, 5000);
}
export const kickEpisodes = () => setTimeout(tick, 300);
