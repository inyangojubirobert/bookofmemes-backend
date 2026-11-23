// Bascardo Video Studio API (config/videoEngine.js, migration 075). Pro and
// Business only: every route that spends anything checks the plan first,
// before any provider is called (requireVideoPlan).
//
//   1. Plan     POST /projects              idea / script / a story + length → shot list   (videoPlan / videoPlanWithReference)
//               PATCH /projects/:id         edit the look card / title; free
//               PATCH /projects/:id/shots/:sid  edit a shot, use your own clip or a start picture; free
//   2. Shoot    POST /projects/:id/shots/:sid/generate   one clip, as a background job        (video credits)
//   3. Finish   (migration 083, config/soundStudio.js) GET /finishing = voices, tones, music, sounds, looks, prices
//               PATCH /projects/:id/shots/:sid { trim_start, trim_end, edit: { zoom, anchor, look, strength, grade, clip_audio },
//                     light, voice_id, voice_tone, sfx: [...] }                            edit a made clip; free
//               PATCH /projects/:id { aspect, finish, voice, light, music_url }           whole video; free (stock music free)
//               POST /voice-preview                 hear a voice + tone on your words  (voiceLine)
//               POST /projects/:id/voice-lines      each shot's line, placed on its shot (voiceLine × lines)
//               POST /projects/:id/sfx              a sound effect from words           (sfx credits / second)
//               POST /projects/:id/shots/:sid/sound sound made for the clip itself      (sfx credits / second)
//               POST /projects/:id/music            soundtrack from theme/mood/tempo    (song credits / minute)
//   4. Render   POST /projects/:id/render     edited clips + voices + sounds + music → one MP4 (videoRender)
import express from 'express';
import crypto from 'crypto';
import { supabase } from '../config/db.js';
import { authenticateToken } from '../auth.js';
import { creditStatus, reserveCredits, releaseCredits, outOfCreditsMessage } from '../utils/aiCredits.js';
import { creditsFor } from '../config/aiPlans.js';
import { runChargedStep } from '../utils/studioSteps.js';
import { createJob, publicJob } from '../utils/studioJobs.js';
import { saveToGallery } from '../utils/gallery.js';
import { narrateScript, speakableText, estimateSeconds, MAX_SCRIPT_CHARS } from '../utils/podcastNarration.js';
import { generateSong } from '../utils/music.js';
import { renderFilm, editedPreview, ensureOnCloudinary } from '../utils/renderVideo.js';
import { speakLine, makeSoundEffect, soundForClip, SFX_MODEL } from '../utils/soundMaker.js';
import {
  VOICES, TONES, SPEEDS, MAX_LINE_CHARS, voiceById, cleanVoice, MUSIC_THEMES, MOODS, TEMPOS, MUSIC_LEVELS, musicPrompt,
  SFX_CATEGORIES, SFX_LEVELS, SFX_MAX_SECONDS, SFX_PER_SHOT, cleanSfx, LOOKS, LOOK_STRENGTHS, GRADE_KEYS, ASPECTS, ZOOMS, ANCHORS,
  LIGHTING, LIGHT_COLOURS, cleanLight, lightText, cleanEdit, cleanFinish, VOICE_MODEL,
} from '../config/soundStudio.js';
import fs from 'fs';
import { planVideo, shotBudget, shotPrompt, referenceFrames, LENGTHS, LIMITS, VIDEO_PLAN_MODEL, PROMPT_VERSION, VideoError, clipModel } from '../config/videoEngine.js';
import { assembleShot, cleanAsset, cleanSlots, continuityNotes, hasSlots, readiness, SLOTS, POSITIONS, POSES, EXPRESSIONS, LIMITS as CAST_LIMITS } from '../config/videoCast.js';
import { prepareAssetImage, BACKGROUND_MODEL } from '../utils/assetImages.js';
import { callRunwareTasks } from '../utils/runwareClient.js';
import { AI_MODELS } from '../config/aiModels.js';
import { v2 as cloudinary } from 'cloudinary';
import { searchText, ilikeAny } from '../utils/searchText.js';

const router = express.Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQ_ID = /^[A-Za-z0-9_-]{8,80}$/;
const HTTPS = /^https:\/\/[^\s]+$/;
const fail = (res, status, error, extra = {}) => res.status(status).json({ success: false, error, ...extra });
const now = () => new Date().toISOString();

// Video is Pro/Business only (owner's decision). Checked before any spend.
async function requireVideoPlan(req, res, next) {
  try {
    const status = await creditStatus(req.user.id);
    if (!status.plan.premiumModels) {
      return fail(res, 403, 'Video Studio is part of the Bascardo AI Pro and Business plans.', { code: 'video_needs_plan' });
    }
    req.creditStatus = status;
    next();
  } catch (err) { fail(res, 500, 'Could not check your plan'); }
}

async function loadProject(userId, id) {
  if (!UUID.test(String(id))) return null;
  const { data } = await supabase.from('video_projects').select('*').eq('id', id).eq('user_id', userId).maybeSingle();
  return data;
}
async function loadShots(projectId) {
  const { data } = await supabase.from('video_shots').select('*').eq('project_id', projectId).order('number');
  return data || [];
}
async function loadAssets(userId) {
  const { data } = await supabase.from('video_assets').select('*').eq('user_id', userId).limit(CAST_LIMITS.assets);
  return Object.fromEntries((data || []).map((a) => [a.id, a]));
}

// Stock sounds, music and voice samples made once by scripts/buildSoundLibrary.js (free to use).
let LIBRARY = { voices: {}, music: [], sfx: [] };
try { LIBRARY = { ...LIBRARY, ...JSON.parse(fs.readFileSync(new URL('../config/soundLibrary.json', import.meta.url), 'utf8')) }; }
catch { console.warn('[video] config/soundLibrary.json missing: run node scripts/buildSoundLibrary.js'); }
const libraryUrls = () => new Set([...LIBRARY.music, ...LIBRARY.sfx].map((x) => x.url));

// Missing 083 columns → tell the owner which migration to run instead of a bare 500.
const needs083 = (err) => /column|schema cache|PGRST204/i.test(err?.message || '');
const saveFail = (res, err, what = 'Could not save') => (needs083(err)
  ? fail(res, 503, 'Video finishing is not switched on yet (migration 083).', { code: 'needs_migration' })
  : fail(res, 500, what));

/** The prompt (+ cast references) a shot's clip is made from; lighting goes first so it's never cut off. */
function promptFor(project, shot, assets) {
  const light = lightText(shot.light || project.light);
  if (!hasSlots(shot.cast_slots)) return { prompt: [light, shotPrompt(project, shot)].filter(Boolean).join(' ').slice(0, 1000), references: [], labels: [] };
  const a = assembleShot(project, shot, assets);
  return { prompt: [light, a.prompt].filter(Boolean).join(' '), references: a.references, labels: a.labels };
}

const voiceKey = (text, v) => crypto.createHash('md5').update([String(text || '').trim(), v.voice_id, v.tone, v.speed].join('|')).digest('hex');
/** The voice a shot's line is said in: the shot's own choice over the video's. */
const lineVoice = (project, shot) => {
  const base = cleanVoice(project.voice || {});
  return { ...base, voice_id: shot.voice_id || base.voice_id, tone: shot.voice_tone || base.tone };
};

async function view(project, shots = null) {
  const list = shots || await loadShots(project.id);
  const assets = list.some((s) => hasSlots(s.cast_slots)) ? await loadAssets(project.user_id) : {};
  const continuity = continuityNotes(list, assets);
  const previews = await Promise.all(list.map((s) => (s.clip_public_id ? editedPreview(s, project).catch(() => null) : null)));
  return {
    ...project,
    shots: list.map((s, i) => {
      const a = promptFor(project, s, assets);
      const v = lineVoice(project, s);
      const voice = s.narration?.trim() ? {
        voice_id: v.voice_id, voice_name: voiceById(v.voice_id).name, tone: v.tone,
        recorded: !!s.voice_url, stale: !!s.voice_url && s.voice_key !== voiceKey(s.narration, v),
        too_long: !!s.voice_seconds && Number(s.voice_seconds) - Number(s.voice_lead_in || 0) > Number(s.duration_seconds || 5) + 0.5,
      } : null;
      return { ...s, prompt: a.prompt, references: a.labels, continuity: hasSlots(s.cast_slots) ? continuity[s.id] || [] : [], preview: previews[i], line: voice };
    }),
    ready: list.filter((s) => s.included && s.status === 'ready').length,
    included: list.filter((s) => s.included).length,
    narration_words: list.filter((s) => s.included).reduce((n, s) => n + (String(s.narration || '').match(/\S+/g) || []).length, 0),
  };
}

function runCharged(req, res, { kind, action, projectId = null, costOpts = {}, log = {} }, work) {
  return runChargedStep(req, res, {
    ledger: 'video_ai_requests', kind, action, projectId, costOpts, subject: 'this video',
    log: { feature: 'text', model: VIDEO_PLAN_MODEL, provider: 'anthropic', prompt: `video:${kind} ${PROMPT_VERSION}`, ...log },
    isKnownError: (err) => err instanceof VideoError || err.status === 400 || err.status === 501,
  }, work);
}

// ── Setup ───────────────────────────────────────────────────────────────────
router.get('/config', authenticateToken, async (req, res) => {
  try {
    const status = await creditStatus(req.user.id);
    const premium = status.plan.premiumModels;
    const clip = creditsFor('video', { premium: true });
    const { clipSeconds } = clipModel();
    res.json({ success: true, data: {
      available: premium,
      clip_seconds: clipSeconds,
      lengths: LENGTHS.map((s) => { const b = shotBudget(s); return { seconds: s, shots: b.shots, clip_credits: clip, total_clip_credits: b.shots * clip }; }),
      costs: {
        plan: creditsFor('videoPlan', { premium }), plan_with_reference: creditsFor('videoPlanWithReference', { premium }),
        clip, clip_with_start_picture: creditsFor('video', { premium: true, reference: true }),
        render: creditsFor('videoRender', { premium }), narration_per_minute: creditsFor('narration', { premium, seconds: 60 }),
        music_per_minute: creditsFor('song', { premium, seconds: 60 }),
      },
      credits: { remaining: status.remaining, limit: status.limit, topup: status.topup || 0, plan: status.plan.name },
    } });
  } catch (err) { console.error('[video] config:', err.message); fail(res, 500, 'Could not load Video Studio'); }
});

router.get('/projects', authenticateToken, async (req, res) => {
  let q = supabase.from('video_projects').select('id, title, target_seconds, status, render_url, updated_at')
    .eq('user_id', req.user.id).order('updated_at', { ascending: false }).limit(50);
  const text = searchText(req.query.q); // ?q= finds older ones past the newest 50
  if (text) q = q.ilike('title', `%${text}%`);
  const { data, error } = await q;
  if (error) return fail(res, 500, 'Could not load your videos');
  res.json({ success: true, data: data || [] });
});

router.get('/projects/:id', authenticateToken, async (req, res) => {
  const p = await loadProject(req.user.id, req.params.id);
  if (!p) return fail(res, 404, 'Video not found');
  res.json({ success: true, data: await view(p) });
});

router.delete('/projects/:id', authenticateToken, async (req, res) => {
  const p = await loadProject(req.user.id, req.params.id);
  if (!p) return fail(res, 404, 'Video not found');
  await supabase.from('video_projects').delete().eq('id', p.id); // clips stay in the Gallery
  res.json({ success: true });
});

// Stories the user can turn into a video.
router.get('/stories', authenticateToken, async (req, res) => {
  let q = supabase.from('story_projects').select('id, title, plan, kind, updated_at')
    .eq('user_id', req.user.id).order('updated_at', { ascending: false }).limit(30);
  const text = searchText(req.query.q); // ?q= finds older ones past the newest 30
  if (text) q = q.or(ilikeAny(text, ['title', 'plan->>title']));
  const { data } = await q;
  res.json({ success: true, data: (data || []).map((p) => ({ id: p.id, title: p.plan?.title || p.title || 'Untitled', kind: p.kind || 'story' })) });
});

// ── 1. Plan ─────────────────────────────────────────────────────────────────
router.post('/projects', authenticateToken, requireVideoPlan, async (req, res) => {
  const idea = String(req.body?.idea || '').trim();
  const storyId = UUID.test(String(req.body?.story_project_id || '')) ? req.body.story_project_id : null;
  const refUrl = HTTPS.test(String(req.body?.reference_video_url || '')) ? req.body.reference_video_url : null;
  if (!storyId && idea.length < 10) return fail(res, 400, 'Describe your video (a sentence or two), or pick one of your stories.');
  if (idea.length > LIMITS.ideaChars) return fail(res, 400, `Keep it under ${LIMITS.ideaChars.toLocaleString()} characters.`);
  const b = shotBudget(req.body?.target_seconds);

  let storyContext = '';
  if (storyId) {
    const { data: st } = await supabase.from('story_projects').select('*').eq('id', storyId).eq('user_id', req.user.id).maybeSingle();
    if (!st) return fail(res, 404, 'Story not found');
    const m = st.memory || {};
    storyContext = [
      `TITLE: ${st.plan?.title || st.title}`, st.plan?.logline && `PREMISE: ${st.plan.logline}`, st.plan?.setting && `SETTING: ${st.plan.setting}`,
      (m.characters || st.plan?.characters || []).length && `CHARACTERS: ${(m.characters || st.plan.characters).map((c) => `${c.name} (${c.role || ''}): ${c.state || c.wants || ''}`).join('; ')}`,
      (m.summaries || []).length && `WHAT HAPPENS:\n${m.summaries.map((s) => `${s.number}. ${s.title}: ${s.summary}`).join('\n')}`,
    ].filter(Boolean).join('\n');
  }
  let refVideo = null;
  if (refUrl) {
    try { refVideo = `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/video/upload/${await ensureOnCloudinary(refUrl)}.mp4`; }
    catch { return fail(res, 400, 'Could not read that reference video. Try another one.'); }
  }
  const frames = refVideo ? referenceFrames(refVideo) : [];
  // Sound & light plan (on unless the app says no): music theme 'auto' | 'none' | a theme id; narrator voice.
  const wantSound = req.body?.sound_plan !== false;
  const musicChoice = String(req.body?.music_theme || 'auto');
  const sound = wantSound ? {
    musicTheme: musicChoice === 'none' || musicChoice === 'auto' || MUSIC_THEMES.some((t) => t.id === musicChoice) ? musicChoice : 'auto',
    voiceId: VOICES.some((v) => v.id === req.body?.voice_id) ? req.body.voice_id : null,
  } : null;

  return runCharged(req, res, { kind: 'plan', action: frames.length ? 'videoPlanWithReference' : 'videoPlan' }, async () => {
    const r = await planVideo({ idea: idea || 'Turn this story into a video.', storyContext, targetSeconds: b.targetSeconds, frames, sound });
    const sp = r.plan.sound_plan;
    // Applied at once, all free and all changeable: library sounds on each shot, its lighting
    // and tone, the narrator, and a free library track for the music theme (unless "no music").
    const theme = sp ? (sound.musicTheme === 'none' ? null : sound.musicTheme !== 'auto' ? sound.musicTheme : sp.music_theme) : null;
    const track = theme ? LIBRARY.music.find((m) => m.id === theme) : null;
    const soundFields = sp ? {
      voice: cleanVoice({ voice_id: sound.voiceId || sp.voice_id, tone: sp.tone }),
      finish: { music_level: 'low' },
      ...(track ? { music_url: track.url, music_title: track.title, music_history: [{ url: track.url, title: track.title, at: now(), planned: true }] } : {}),
    } : {};
    const shotSound = (i) => {
      const x = sp?.shots?.[i];
      if (!x) return {};
      const sfx = x.sfx.map((f) => { const lib = LIBRARY.sfx.find((l) => l.id === f.id); return lib ? { id: lib.id, label: lib.label, url: lib.url, public_id: lib.public_id, seconds: lib.seconds, lead_in: lib.lead_in, at: f.at, level: 'normal' } : null; }).filter(Boolean);
      return { voice_tone: x.tone, light: x.light, sfx };
    };
    const { data: project, error } = await supabase.from('video_projects').insert({
      user_id: req.user.id, title: r.plan.title, idea: idea || '(from a story)', source_kind: storyId ? 'story' : frames.length ? 'reference' : 'idea', source_id: storyId,
      target_seconds: b.targetSeconds, clip_seconds: b.clipSeconds, model: b.model, logline: r.plan.logline, look_card: r.plan.look_card, fit_note: r.plan.fit_note || null,
      reference: frames.length ? { video_url: refVideo, frames, description: r.plan.reference_style, how: 'analysed from 3 frames, not given to the video model' } : null,
      ...soundFields,
    }).select().single();
    if (error) throw error;
    const { error: sErr } = await supabase.from('video_shots').insert(r.plan.shots.map((s, i) => ({ ...s, ...shotSound(i), project_id: project.id, duration_seconds: b.clipSeconds })));
    if (sErr) { await supabase.from('video_projects').delete().eq('id', project.id); throw sErr; }
    const u = r.usage;
    return { data: { project: await view(project) }, projectId: project.id, providerCost: Number((u.input / 1e6 + u.output * 5 / 1e6).toFixed(6)) };
  });
});

router.patch('/projects/:id', authenticateToken, async (req, res) => {
  const p = await loadProject(req.user.id, req.params.id);
  if (!p) return fail(res, 404, 'Video not found');
  const b = req.body || {};
  const up = { updated_at: now() };
  if (typeof b.title === 'string' && b.title.trim()) up.title = b.title.trim().slice(0, 120);
  if (b.look_card && typeof b.look_card === 'object') {
    const l = b.look_card;
    up.look_card = {
      style: String(l.style ?? p.look_card?.style ?? '').slice(0, 300), palette: String(l.palette ?? p.look_card?.palette ?? '').slice(0, 200),
      setting: String(l.setting ?? p.look_card?.setting ?? '').slice(0, 300), camera: String(l.camera ?? p.look_card?.camera ?? '').slice(0, 200),
      characters: (Array.isArray(l.characters) ? l.characters : p.look_card?.characters || []).slice(0, 5).map((c) => ({ name: String(c?.name || '').slice(0, 60), look: String(c?.look || '').slice(0, 300) })).filter((c) => c.name),
    };
  }
  for (const k of ['music_url', 'voiceover_url']) {
    if (b[k] === undefined) continue;
    if (b[k] && !HTTPS.test(String(b[k]))) return fail(res, 400, 'Invalid link');
    up[k] = b[k] || null;
  }
  if (b.music_url !== undefined) {
    // A track from the stock library or the Gallery; kept in the versions list.
    const lib = LIBRARY.music.find((m) => m.url === b.music_url);
    up.music_title = b.music_url ? String(b.music_title || lib?.title || 'My song').slice(0, 80) : null;
    if (b.music_url) up.music_history = [...(p.music_history || []).filter((m) => m.url !== b.music_url), { url: b.music_url, title: up.music_title, at: now() }].slice(-12);
  }
  if (b.aspect !== undefined && ASPECTS[b.aspect]) up.aspect = b.aspect;
  if (b.finish && typeof b.finish === 'object') up.finish = cleanFinish(b.finish, p.finish || {});
  if (b.voice && typeof b.voice === 'object') up.voice = cleanVoice(b.voice, p.voice || {});
  if (b.light !== undefined) up.light = cleanLight(b.light);
  const { data, error } = await supabase.from('video_projects').update(up).eq('id', p.id).select().single();
  if (error) return saveFail(res, error);
  res.json({ success: true, data: await view(data) });
});

// ── Edit videos you already have (no plan, free) ────────────────────────────
// Any video (Gallery, a finished render, the phone) becomes a project whose
// shots are those videos, so every finishing tool works on it: trim, frame,
// colour, sounds, voice, music, shape, then join.
const EDIT_MAX_CLIPS = 12;

async function clipInfo(url) {
  const publicId = await ensureOnCloudinary(url);
  let seconds = 5;
  try { const r = await cloudinary.api.resource(publicId, { resource_type: 'video' }); seconds = Number(r.duration) || 5; }
  catch (err) { console.warn('[video] clip length unknown:', err.message); }
  return { publicId, seconds };
}

router.post('/projects/edit', authenticateToken, async (req, res) => {
  const urls = (Array.isArray(req.body?.videos) ? req.body.videos : [req.body?.video_url]).filter((u) => HTTPS.test(String(u || ''))).slice(0, EDIT_MAX_CLIPS);
  if (!urls.length) return fail(res, 400, 'Choose a video to edit.');
  let clips;
  try { clips = await Promise.all(urls.map(clipInfo)); }
  catch (err) { console.error('[video] edit import:', err.message); return fail(res, 400, 'Could not open that video. Try another one.'); }
  const total = clips.reduce((n, c) => n + c.seconds, 0);
  const title = String(req.body?.title || '').trim().slice(0, 120) || `Edit ${new Date().toISOString().slice(0, 10)}`;
  const aspect = ASPECTS[req.body?.aspect] ? req.body.aspect : 'landscape';
  const { data: project, error } = await supabase.from('video_projects').insert({
    user_id: req.user.id, title, idea: 'Editing my own videos', source_kind: 'edit', aspect,
    target_seconds: Math.max(5, Math.min(120, Math.round(total) || 5)), clip_seconds: Math.round(clips[0].seconds) || 5, model: 'upload', status: 'shooting',
  }).select().single();
  if (error) { console.error('[video] edit project:', error.message); return fail(res, 500, 'Could not start the editor'); }
  const { error: sErr } = await supabase.from('video_shots').insert(clips.map((c, i) => ({
    project_id: project.id, number: i + 1, scene: `Video ${i + 1}`, visual: `Your video ${i + 1}`, duration_seconds: Math.max(1, Math.round(c.seconds)),
    source: 'upload', status: 'ready', clip_url: urls[i], clip_public_id: c.publicId,
  })));
  if (sErr) { await supabase.from('video_projects').delete().eq('id', project.id); return saveFail(res, sErr, 'Could not start the editor'); }
  res.json({ success: true, data: await view(project) });
});

// Add another video to the end of a project (an edit, or a planned video).
router.post('/projects/:id/clips', authenticateToken, async (req, res) => {
  const p = await loadProject(req.user.id, req.params.id);
  if (!p) return fail(res, 404, 'Video not found');
  const url = String(req.body?.video_url || '');
  if (!HTTPS.test(url)) return fail(res, 400, 'Choose a video to add.');
  const shots = await loadShots(p.id);
  if (shots.length >= LIMITS.maxShots) return fail(res, 400, `A video holds ${LIMITS.maxShots} clips at most.`);
  let c;
  try { c = await clipInfo(url); } catch { return fail(res, 400, 'Could not use that video. Try another one.'); }
  const n = (shots.at(-1)?.number || 0) + 1;
  const { error } = await supabase.from('video_shots').insert({
    project_id: p.id, number: n, scene: `Video ${n}`, visual: `Your video ${n}`, duration_seconds: Math.max(1, Math.round(c.seconds)),
    source: 'upload', status: 'ready', clip_url: url, clip_public_id: c.publicId,
  });
  if (error) return saveFail(res, error, 'Could not add the video');
  await supabase.from('video_projects').update({ updated_at: now() }).eq('id', p.id);
  res.json({ success: true, data: await view(p) });
});

// Edit a shot; use your own clip (from the Gallery/phone) or a start picture.
router.patch('/projects/:id/shots/:sid', authenticateToken, async (req, res) => {
  const p = await loadProject(req.user.id, req.params.id);
  if (!p || !UUID.test(req.params.sid)) return fail(res, 404, 'Shot not found');
  const { data: shot } = await supabase.from('video_shots').select('*').eq('id', req.params.sid).eq('project_id', p.id).maybeSingle();
  if (!shot) return fail(res, 404, 'Shot not found');
  const b = req.body || {};
  const up = { updated_at: now() };
  for (const [k, max] of [['scene', 80], ['visual', 600], ['action', 300], ['camera', 200], ['lighting', 200], ['narration', 400], ['sound', 200]]) {
    if (typeof b[k] === 'string') up[k] = b[k].slice(0, max);
  }
  if (typeof b.included === 'boolean') up.included = b.included;
  if (b.trim_start !== undefined) up.trim_start = Math.max(0, Number(b.trim_start) || 0);
  if (b.trim_end !== undefined) up.trim_end = b.trim_end === null ? null : Math.max(0, Number(b.trim_end) || 0);
  if (b.start_image_url !== undefined) {
    if (b.start_image_url && !HTTPS.test(String(b.start_image_url))) return fail(res, 400, 'Invalid picture link');
    up.start_image_url = b.start_image_url || null;
  }
  if (b.cast_slots !== undefined) {
    up.cast_slots = cleanSlots(b.cast_slots || {}, await loadAssets(req.user.id));
    up.still_url = null; // the scene changed: the old still no longer matches it
  }
  if (b.edit && typeof b.edit === 'object') up.edit = cleanEdit(b.edit, shot.edit || {});
  if (b.light !== undefined) up.light = cleanLight(b.light);
  if (b.voice_id !== undefined) up.voice_id = b.voice_id && VOICES.some((v) => v.id === b.voice_id) ? b.voice_id : null;
  if (b.voice_tone !== undefined) up.voice_tone = b.voice_tone && TONES.some((t) => t.id === b.voice_tone) ? b.voice_tone : null;
  if (b.sfx !== undefined) {
    // Each sound: from the stock library, or the user's own (made here / Gallery) on our Cloudinary.
    const list = cleanSfx(b.sfx, Number(shot.duration_seconds) || 15);
    for (const x of list) {
      if (!x.public_id || !String(x.url).includes('/' + x.public_id + '.')) {
        try { x.public_id = await ensureOnCloudinary(x.url); } catch { return fail(res, 400, 'Could not use the sound "' + x.label + '"'); }
      }
    }
    up.sfx = list;
  }
  if (b.clip_url !== undefined) {
    if (b.clip_url) {
      if (!HTTPS.test(String(b.clip_url))) return fail(res, 400, 'Invalid video link');
      try { up.clip_public_id = await ensureOnCloudinary(b.clip_url); } catch { return fail(res, 400, 'Could not use that video'); }
      Object.assign(up, { clip_url: b.clip_url, source: 'upload', status: 'ready', job_id: null });
    } else Object.assign(up, { clip_url: null, clip_public_id: null, status: 'planned', source: 'ai' });
  }
  const { error } = await supabase.from('video_shots').update(up).eq('id', shot.id);
  if (error) return saveFail(res, error, 'Could not save the shot');
  res.json({ success: true, data: await view(p) });
});

// ── 2. One clip, as a background job ────────────────────────────────────────
router.post('/projects/:id/shots/:sid/generate', authenticateToken, requireVideoPlan, async (req, res) => {
  const p = await loadProject(req.user.id, req.params.id);
  if (!p || !UUID.test(req.params.sid)) return fail(res, 404, 'Shot not found');
  const { data: shot } = await supabase.from('video_shots').select('*').eq('id', req.params.sid).eq('project_id', p.id).maybeSingle();
  if (!shot) return fail(res, 404, 'Shot not found');
  if (shot.status === 'generating') return fail(res, 409, 'This shot is already being made.');
  const requestId = String(req.body?.request_id || '');
  if (!REQ_ID.test(requestId)) return fail(res, 400, 'Missing request id. Please update the app.');

  const status = req.creditStatus;
  const withStart = !!shot.start_image_url;
  // Cast slots (migration 079): the assembled prompt, and — when there's no
  // start picture — the cast's cropped references (a start picture already
  // carries them, and the model can't take both).
  const a = promptFor(p, shot, hasSlots(shot.cast_slots) ? await loadAssets(req.user.id) : {});
  const prompt = a.prompt;
  const referenceImages = !withStart && a.references.length ? a.references : null;
  const cost = creditsFor('video', { premium: true, reference: withStart || !!referenceImages });
  const reservation = status.remaining >= cost ? await reserveCredits(req.user.id, status.plan, cost, `shot:${requestId}`, 30) : null;
  if (!reservation) {
    return fail(res, 402, outOfCreditsMessage(status, cost), { code: 'out_of_credits', credits: { remaining: status.remaining, cost } });
  }
  try {
    const { job, existed } = await createJob({
      userId: req.user.id, requestId: `shot:${requestId}`, kind: 'video_clip',
      input: { prompt, hd: false, premium: true, referenceImageUrl: shot.start_image_url || null, referenceImages, tier: status.plan.id, role: 'shot', shot_id: shot.id },
      projectKind: 'video', projectId: p.id, reservation, credits: cost,
    });
    if (existed) await releaseCredits(reservation);
    await supabase.from('video_shots').update({ status: 'generating', job_id: job.id, updated_at: now() }).eq('id', shot.id);
    res.status(202).json({ success: true, data: { job: publicJob(job), credits: cost } });
  } catch (err) {
    await releaseCredits(reservation);
    console.error('[video] start clip failed:', err.message);
    fail(res, 500, 'Could not start this shot. You were not charged.');
  }
});

// ── Cast library: Characters, Locations, Props (migration 079) ──────────────
const assetView = (a) => ({ ...a, readiness: readiness(a) });

router.get('/assets', authenticateToken, async (req, res) => {
  const { data, error } = await supabase.from('video_assets').select('*').eq('user_id', req.user.id).order('updated_at', { ascending: false }).limit(CAST_LIMITS.assets);
  if (error) return fail(res, /video_assets|PGRST205/.test(error.message) ? 503 : 500, /video_assets|PGRST205/.test(error.message) ? 'The cast library is not switched on yet (migration 079).' : 'Could not load your cast');
  res.json({ success: true, data: {
    assets: (data || []).map(assetView),
    slots: SLOTS, positions: POSITIONS, poses: POSES, expressions: EXPRESSIONS, limits: CAST_LIMITS,
    costs: { background: creditsFor('backgroundRemoval'), still: creditsFor('image', { premium: true, reference: true }) },
  } });
});

router.post('/assets', authenticateToken, async (req, res) => {
  const { row, error } = cleanAsset(String(req.body?.kind || ''), req.body || {});
  if (error) return fail(res, 400, error);
  if (row.parent_id && !(await loadAssets(req.user.id))[row.parent_id]) row.parent_id = null;
  const { data, error: e } = await supabase.from('video_assets').insert({ ...row, user_id: req.user.id }).select().single();
  if (e) { console.error('[video] asset create:', e.message); return fail(res, 500, 'Could not save it'); }
  res.json({ success: true, data: assetView(data) });
});

router.patch('/assets/:aid', authenticateToken, async (req, res) => {
  if (!UUID.test(req.params.aid)) return fail(res, 404, 'Not found');
  const { data: a } = await supabase.from('video_assets').select('*').eq('id', req.params.aid).eq('user_id', req.user.id).maybeSingle();
  if (!a) return fail(res, 404, 'Not found');
  const { row, error } = cleanAsset(a.kind, req.body || {}, a);
  if (error) return fail(res, 400, error);
  if (row.parent_id === a.id || (row.parent_id && !(await loadAssets(req.user.id))[row.parent_id])) row.parent_id = null;
  const { data, error: e } = await supabase.from('video_assets').update({ ...row, updated_at: now() }).eq('id', a.id).select().single();
  if (e) return fail(res, 500, 'Could not save it');
  res.json({ success: true, data: assetView(data) });
});

router.delete('/assets/:aid', authenticateToken, async (req, res) => {
  if (!UUID.test(req.params.aid)) return fail(res, 404, 'Not found');
  await supabase.from('video_assets').delete().eq('id', req.params.aid).eq('user_id', req.user.id);
  res.json({ success: true });
});

// Smart upload: crop (free) and, optionally, remove the background (charged).
// { url, crop: { x, y, w, h } fractions | null, remove_background, owns_rights, request_id }
router.post('/assets/image', authenticateToken, async (req, res) => {
  const url = String(req.body?.url || '');
  if (!HTTPS.test(url)) return fail(res, 400, 'Pick a picture first');
  if (!req.body?.owns_rights) return fail(res, 400, 'Confirm you own this picture or have the right to use it.');
  const c = req.body?.crop;
  const crop = c && [c.x, c.y, c.w, c.h].every((v) => Number.isFinite(Number(v))) ? { x: +c.x, y: +c.y, w: +c.w, h: +c.h } : null;
  // A location is a whole place: removing its "background" erases everything.
  if (!req.body?.remove_background || req.body?.kind === 'location') {
    try { const r = await prepareAssetImage(url, { crop }); return res.json({ success: true, data: { url: r.url, width: r.width, height: r.height } }); }
    catch (err) { console.error('[video] crop:', err.message); return fail(res, 400, 'Could not use that picture. Try another one.'); }
  }
  return runCharged(req, res, { kind: 'background', action: 'backgroundRemoval', log: { feature: 'image', provider: 'runware', model: BACKGROUND_MODEL } }, async () => {
    const r = await prepareAssetImage(url, { crop, removeBackground: true });
    saveToGallery({ userId: req.user.id, kind: 'image', url: r.url, feature: 'image', prompt: 'cast cut-out', model: BACKGROUND_MODEL, projectKind: 'video', role: 'cast', provider: 'runware', providerCost: r.cost });
    return { data: { url: r.url, width: r.width, height: r.height }, providerCost: r.cost, outputUrl: r.url };
  });
});

// Still preview: one picture of the shot from its cast references (FLUX.2
// [pro], up to 9 references). Approved, it becomes the start picture, so the
// clip animates exactly what was checked: the cheapest way to get it right.
const STILL_SIZE = { landscape: [1024, 576], portrait: [576, 1024], square: [1024, 1024] };
router.post('/projects/:id/shots/:sid/still', authenticateToken, requireVideoPlan, async (req, res) => {
  const p = await loadProject(req.user.id, req.params.id);
  if (!p || !UUID.test(req.params.sid)) return fail(res, 404, 'Shot not found');
  const { data: shot } = await supabase.from('video_shots').select('*').eq('id', req.params.sid).eq('project_id', p.id).maybeSingle();
  if (!shot) return fail(res, 404, 'Shot not found');
  const assets = await loadAssets(req.user.id);
  const a = assembleShot(p, shot, assets, { maxChars: 3000 });
  const [width, height] = STILL_SIZE[p.aspect] || STILL_SIZE.landscape;
  const model = AI_MODELS.IMAGE.PREMIUM;
  return runCharged(req, res, { kind: 'still', action: 'image', projectId: p.id, costOpts: { reference: a.references.length > 0 }, log: { feature: 'image', provider: 'runware', model } }, async () => {
    const task = {
      taskType: 'imageInference', taskUUID: crypto.randomUUID(), model, width, height, numberResults: 1, outputFormat: 'JPG', includeCost: true,
      positivePrompt: `A single film frame, the first frame of this shot.\n${[lightText(shot.light || p.light), a.prompt].filter(Boolean).join(' ')}`,
      ...(a.references.length ? { inputs: { referenceImages: a.references } } : {}),
    };
    const { data } = await callRunwareTasks([task]);
    const r = data?.[0];
    if (!r?.imageURL) throw new VideoError('No picture came back. You were not charged.', 502);
    const kept = await cloudinary.uploader.upload(r.imageURL, { folder: 'bookofmemes/video-studio/stills', resource_type: 'image' });
    await supabase.from('video_shots').update({ still_url: kept.secure_url, updated_at: now() }).eq('id', shot.id);
    saveToGallery({ userId: req.user.id, kind: 'image', url: kept.secure_url, feature: 'image', prompt: a.prompt, model, projectKind: 'video', projectId: p.id, role: 'still', provider: 'runware', providerCost: r.cost ?? null });
    return { data: { project: await view(p) }, providerCost: r.cost ?? null, outputUrl: kept.secure_url };
  });
});

// Use the approved still as the start picture (or stop using it).
router.post('/projects/:id/shots/:sid/use-still', authenticateToken, async (req, res) => {
  const p = await loadProject(req.user.id, req.params.id);
  if (!p || !UUID.test(req.params.sid)) return fail(res, 404, 'Shot not found');
  const { data: shot } = await supabase.from('video_shots').select('*').eq('id', req.params.sid).eq('project_id', p.id).maybeSingle();
  if (!shot) return fail(res, 404, 'Shot not found');
  if (req.body?.use !== false && !shot.still_url) return fail(res, 400, 'Make a still first');
  await supabase.from('video_shots').update({ start_image_url: req.body?.use === false ? null : shot.still_url, updated_at: now() }).eq('id', shot.id);
  res.json({ success: true, data: await view(p) });
});

// Non-destructive: switch the shot back to any clip made for it before.
router.post('/projects/:id/shots/:sid/version', authenticateToken, async (req, res) => {
  const p = await loadProject(req.user.id, req.params.id);
  if (!p || !UUID.test(req.params.sid)) return fail(res, 404, 'Shot not found');
  const { data: shot } = await supabase.from('video_shots').select('*').eq('id', req.params.sid).eq('project_id', p.id).maybeSingle();
  if (!shot) return fail(res, 404, 'Shot not found');
  const v = (shot.clip_history || [])[Number(req.body?.index)];
  if (!v?.url) return fail(res, 404, 'That version is gone');
  await supabase.from('video_shots').update({ clip_url: v.url, clip_public_id: v.public_id || null, status: 'ready', source: 'ai', updated_at: now() }).eq('id', shot.id);
  res.json({ success: true, data: await view(p) });
});

// ── 3. Finishing: voices, sounds, music, light & colour (migration 083) ─────
// Everything the app needs to choose from, with prices. Stock items are free.
router.get('/finishing', authenticateToken, async (req, res) => {
  const status = await creditStatus(req.user.id).catch(() => null);
  const premium = !!status?.plan?.premiumModels;
  res.json({ success: true, data: {
    voices: VOICES.map((v) => ({ id: v.id, name: v.name, gender: v.gender, age: v.age, accent: v.accent, group: v.group, about: v.about, sample_url: LIBRARY.voices?.[v.id] || null })),
    tones: TONES.map(({ id, label }) => ({ id, label })), speeds: SPEEDS, max_line_chars: MAX_LINE_CHARS,
    music: { themes: MUSIC_THEMES.map(({ id, label }) => ({ id, label })), moods: MOODS, tempos: Object.keys(TEMPOS), levels: Object.keys(MUSIC_LEVELS), library: LIBRARY.music },
    sfx: { categories: SFX_CATEGORIES, library: LIBRARY.sfx, levels: Object.keys(SFX_LEVELS), max_seconds: SFX_MAX_SECONDS, per_shot: SFX_PER_SHOT },
    looks: Object.entries(LOOKS).map(([id, l]) => ({ id, label: l.label, about: l.about })), strengths: Object.keys(LOOK_STRENGTHS), grade_keys: GRADE_KEYS,
    lighting: LIGHTING.map(({ id, label }) => ({ id, label })), light_colours: LIGHT_COLOURS.map(({ id, label }) => ({ id, label })),
    aspects: Object.keys(ASPECTS), zooms: ZOOMS, anchors: ANCHORS,
    costs: {
      voice_line: creditsFor('voiceLine', { premium }), sfx_per_second: creditsFor('sfx', { premium, seconds: 1 }),
      music_per_minute: creditsFor('song', { premium, seconds: 60 }), render: creditsFor('videoRender', { premium }),
    },
  } });
});

// Hear a voice + tone on your own words before choosing it (1 voice line).
router.post('/voice-preview', authenticateToken, requireVideoPlan, async (req, res) => {
  const text = String(req.body?.text || '').trim().slice(0, 200);
  if (text.length < 3) return fail(res, 400, 'Type a line to hear.');
  const v = cleanVoice(req.body || {});
  return runCharged(req, res, { kind: 'voice_preview', action: 'voiceLine', log: { feature: 'voice', provider: 'runware', model: VOICE_MODEL } }, async () => {
    const r = await speakLine(text, { voiceId: v.voice_id, tone: v.tone, speed: v.speed, folder: 'bookofmemes/video-studio/voice-previews' });
    return { data: { url: r.url, seconds: r.seconds, voice: r.voice }, providerCost: r.cost, durationSeconds: r.seconds, outputUrl: r.url };
  });
});

// Record each shot's line in its voice and tone; placed at the start of its shot.
// { shot_ids?: [] } — default: every included line not recorded yet or changed since.
router.post('/projects/:id/voice-lines', authenticateToken, requireVideoPlan, async (req, res) => {
  const p = await loadProject(req.user.id, req.params.id);
  if (!p) return fail(res, 404, 'Video not found');
  const only = Array.isArray(req.body?.shot_ids) ? new Set(req.body.shot_ids.map(String)) : null;
  const shots = (await loadShots(p.id)).filter((s) => s.included && s.narration?.trim())
    .filter((s) => (only ? only.has(s.id) : !s.voice_url || s.voice_key !== voiceKey(s.narration, lineVoice(p, s))));
  if (!shots.length) return fail(res, 400, only ? 'Those shots have no narration.' : 'Every line is already recorded. Change a line, voice or tone to record it again.');
  if (shots.some((s) => s.narration.trim().length > MAX_LINE_CHARS)) return fail(res, 400, `Keep each shot's line under ${MAX_LINE_CHARS} characters.`);
  return runCharged(req, res, { kind: 'voice_lines', action: 'voiceLine', projectId: p.id, costOpts: { units: shots.length }, log: { feature: 'voice', provider: 'runware', model: VOICE_MODEL } }, async () => {
    let cost = 0, seconds = 0;
    for (let i = 0; i < shots.length; i += 3) {
      await Promise.all(shots.slice(i, i + 3).map(async (s) => {
        const v = lineVoice(p, s);
        const r = await speakLine(s.narration, { voiceId: v.voice_id, tone: v.tone, speed: v.speed });
        cost += Number(r.cost) || 0; seconds += r.seconds;
        const { error } = await supabase.from('video_shots').update({ voice_url: r.url, voice_public_id: r.public_id, voice_seconds: r.seconds, voice_lead_in: r.lead_in, voice_key: voiceKey(s.narration, v), updated_at: now() }).eq('id', s.id);
        if (error) throw Object.assign(new Error(needs083(error) ? 'Video finishing is not switched on yet (migration 083).' : 'Could not save the line'), { status: 400 });
        saveToGallery({ userId: req.user.id, kind: 'audio', url: r.url, feature: 'narration', prompt: s.narration, model: VOICE_MODEL, durationSeconds: r.seconds, projectKind: 'video', projectId: p.id, role: 'voice_line', provider: 'runware', providerCost: r.cost });
      }));
    }
    return { data: { project: await view(p), lines: shots.length }, providerCost: cost || null, durationSeconds: seconds };
  });
});

// A sound effect from words (1-10 s). With shot_id it's also placed in that shot at `at` seconds.
router.post('/projects/:id/sfx', authenticateToken, requireVideoPlan, async (req, res) => {
  const p = await loadProject(req.user.id, req.params.id);
  if (!p) return fail(res, 404, 'Video not found');
  const prompt = String(req.body?.prompt || '').trim();
  if (prompt.length < 3) return fail(res, 400, 'Describe the sound (e.g. "water poured into a cup").');
  const seconds = Math.max(1, Math.min(SFX_MAX_SECONDS, Math.round(Number(req.body?.seconds) || 3)));
  let shot = null;
  if (req.body?.shot_id) {
    if (!UUID.test(String(req.body.shot_id))) return fail(res, 404, 'Shot not found');
    ({ data: shot } = await supabase.from('video_shots').select('*').eq('id', req.body.shot_id).eq('project_id', p.id).maybeSingle());
    if (!shot) return fail(res, 404, 'Shot not found');
    if ((shot.sfx || []).length >= SFX_PER_SHOT) return fail(res, 400, `A shot holds ${SFX_PER_SHOT} sounds. Remove one first.`);
  }
  return runCharged(req, res, { kind: 'sfx', action: 'sfx', projectId: p.id, costOpts: { seconds }, log: { feature: 'voice', provider: 'runware', model: SFX_MODEL } }, async () => {
    const r = await makeSoundEffect(prompt, seconds);
    const sound = { id: `own-${r.public_id.split('/').pop()}`, label: prompt.slice(0, 60), url: r.url, public_id: r.public_id, seconds: r.seconds, lead_in: r.lead_in };
    saveToGallery({ userId: req.user.id, kind: 'audio', url: r.url, feature: 'sfx', prompt, model: SFX_MODEL, durationSeconds: r.seconds, projectKind: 'video', projectId: p.id, role: 'sfx', provider: 'runware', providerCost: r.cost });
    if (shot) {
      const list = cleanSfx([...(shot.sfx || []), { ...sound, at: Number(req.body?.at) || 0, level: req.body?.level || 'normal' }], Number(shot.duration_seconds) || 15);
      list[list.length - 1].public_id = r.public_id;
      const { error } = await supabase.from('video_shots').update({ sfx: list, updated_at: now() }).eq('id', shot.id);
      if (error) throw Object.assign(new Error(needs083(error) ? 'Video finishing is not switched on yet (migration 083).' : 'Could not add the sound to the shot'), { status: 400 });
    }
    return { data: { sound, project: await view(p) }, providerCost: r.cost, durationSeconds: r.seconds, outputUrl: r.url };
  });
});

// Sound made to match what happens in the clip (footsteps, doors, rain…), as a new version of the clip.
router.post('/projects/:id/shots/:sid/sound', authenticateToken, requireVideoPlan, async (req, res) => {
  const p = await loadProject(req.user.id, req.params.id);
  if (!p || !UUID.test(req.params.sid)) return fail(res, 404, 'Shot not found');
  const { data: shot } = await supabase.from('video_shots').select('*').eq('id', req.params.sid).eq('project_id', p.id).maybeSingle();
  if (!shot) return fail(res, 404, 'Shot not found');
  if (shot.status !== 'ready' || !shot.clip_public_id) return fail(res, 400, 'Make the clip first.');
  const seconds = Math.max(1, Math.ceil(Number(shot.edit_cache?.seconds) || Number(shot.duration_seconds) || 5));
  return runCharged(req, res, { kind: 'clip_sound', action: 'sfx', projectId: p.id, costOpts: { seconds }, log: { feature: 'video', provider: 'runware', model: SFX_MODEL } }, async () => {
    const clipUrl = `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/video/upload/${shot.clip_public_id}.mp4`;
    const r = await soundForClip(clipUrl);
    const history = [...(shot.clip_history || [])];
    if (!history.some((h) => h.url === shot.clip_url) && shot.clip_url) history.push({ url: shot.clip_url, public_id: shot.clip_public_id, at: shot.updated_at });
    history.push({ url: r.url, public_id: r.public_id, sound: true, model: SFX_MODEL, at: now() });
    const { error } = await supabase.from('video_shots').update({
      clip_url: r.url, clip_public_id: r.public_id, source: 'sound', clip_history: history.slice(-20),
      edit: { ...(shot.edit || {}), clip_audio: 'keep' }, updated_at: now(),
    }).eq('id', shot.id);
    if (error) throw Object.assign(new Error(needs083(error) ? 'Video finishing is not switched on yet (migration 083).' : 'Could not save the clip'), { status: 400 });
    saveToGallery({ userId: req.user.id, kind: 'video', url: r.url, feature: 'video', prompt: `sound for shot ${shot.number}`, model: SFX_MODEL, durationSeconds: r.seconds, projectKind: 'video', projectId: p.id, role: 'shot', provider: 'runware', providerCost: r.cost });
    return { data: { project: await view(p) }, providerCost: r.cost, durationSeconds: r.seconds, outputUrl: r.url };
  });
});

// A soundtrack composed to the creator's choices: theme, mood, tempo, instruments, own words.
router.post('/projects/:id/music', authenticateToken, requireVideoPlan, async (req, res) => {
  const p = await loadProject(req.user.id, req.params.id);
  if (!p) return fail(res, 404, 'Video not found');
  const seconds = Math.max(30, Math.min(120, Math.ceil((p.render_seconds || p.target_seconds || 30) / 30) * 30));
  const b = req.body || {};
  const chosen = b.theme || b.mood || b.tempo || b.instruments || b.custom || b.style;
  const style = chosen ? musicPrompt({ ...b, custom: b.custom || b.style }) : `${p.look_card?.style || 'cinematic'} instrumental soundtrack, ${p.logline || p.title}`;
  const title = String(b.title || MUSIC_THEMES.find((t) => t.id === b.theme)?.label || 'Custom soundtrack').slice(0, 60);
  return runCharged(req, res, { kind: 'music', action: 'song', projectId: p.id, costOpts: { seconds }, log: { feature: 'voice', provider: 'runware', model: 'ace-step' } }, async () => {
    const r = await generateSong({ style, seconds, folder: 'bookofmemes/video-studio/music' });
    const history = [...(p.music_history || []), { url: r.audioUrl, title, prompt: style, at: now() }].slice(-12);
    let { data, error } = await supabase.from('video_projects').update({ music_url: r.audioUrl, music_title: title, music_history: history, updated_at: now() }).eq('id', p.id).select().single();
    if (error && needs083(error)) ({ data, error } = await supabase.from('video_projects').update({ music_url: r.audioUrl, updated_at: now() }).eq('id', p.id).select().single());
    if (error) throw error;
    saveToGallery({ userId: req.user.id, kind: 'audio', url: r.audioUrl, feature: 'song', prompt: style, model: r.model, durationSeconds: r.seconds, projectKind: 'video', projectId: p.id, role: 'music', provider: 'runware', providerCost: r.cost });
    return { data: { project: await view(data) }, providerCost: r.cost, durationSeconds: r.seconds, outputUrl: r.audioUrl };
  });
});

// Old whole-video voice-over (one track from all the narration); kept for videos made before 083.
router.post('/projects/:id/voiceover', authenticateToken, requireVideoPlan, async (req, res) => {
  const p = await loadProject(req.user.id, req.params.id);
  if (!p) return fail(res, 404, 'Video not found');
  const shots = (await loadShots(p.id)).filter((s) => s.included && s.narration?.trim());
  if (!shots.length) return fail(res, 400, 'No shot has narration yet. Add a line to a shot first.');
  const script = shots.map((s) => s.narration.trim()).join(' ... ');
  const text = speakableText(script);
  if (text.length > MAX_SCRIPT_CHARS) return fail(res, 400, 'The narration is too long.');
  const seconds = estimateSeconds(text);
  return runCharged(req, res, { kind: 'voiceover', action: 'narration', projectId: p.id, costOpts: { seconds }, log: { feature: 'voice', provider: 'runware', model: null } }, async (status) => {
    const r = await narrateScript(script, { useHdModel: status.plan.premiumModels, userId: req.user.id });
    const { data } = await supabase.from('video_projects').update({ voiceover_url: r.audioUrl, voiceover_seconds: r.seconds, updated_at: now() }).eq('id', p.id).select().single();
    saveToGallery({ userId: req.user.id, kind: 'audio', url: r.audioUrl, feature: 'narration', prompt: p.title, model: r.model, durationSeconds: r.seconds, projectKind: 'video', projectId: p.id, role: 'voiceover', provider: 'runware', providerCost: r.providerCost });
    return { data: { project: await view(data) }, providerCost: r.providerCost, durationSeconds: r.seconds, outputUrl: r.audioUrl };
  });
});

// ── 4. Render one MP4 ───────────────────────────────────────────────────────
router.post('/projects/:id/render', authenticateToken, requireVideoPlan, async (req, res) => {
  const p = await loadProject(req.user.id, req.params.id);
  if (!p) return fail(res, 404, 'Video not found');
  const shots = (await loadShots(p.id)).filter((s) => s.included);
  const ready = shots.filter((s) => s.status === 'ready' && s.clip_public_id);
  if (!ready.length) return fail(res, 400, 'Make or add at least one clip first.');
  if (ready.length < shots.length && !req.body?.allow_partial) {
    return fail(res, 409, `${shots.length - ready.length} shot(s) have no clip yet. Make them, leave them out, or render anyway.`, { code: 'shots_missing', missing: shots.length - ready.length });
  }
  return runCharged(req, res, { kind: 'render', action: 'videoRender', projectId: p.id, log: { feature: 'video', provider: 'cloudinary', model: 'splice' } }, async () => {
    // Per-shot voice lines replace the old single voice-over track when any exist.
    const perShotVoice = ready.some((s) => s.voice_public_id);
    const voiceover = !perShotVoice && p.voiceover_url ? await ensureOnCloudinary(p.voiceover_url) : null;
    const music = p.music_url ? await ensureOnCloudinary(p.music_url) : null;
    const r = await renderFilm({ shots: ready, project: p, musicPublicId: music, voiceoverPublicId: voiceover });
    await Promise.all(Object.entries(r.caches).map(([id, cache]) => supabase.from('video_shots').update({ edit_cache: cache }).eq('id', id).then(() => null, () => null)));
    const { data } = await supabase.from('video_projects').update({ render_url: r.url, render_seconds: r.seconds, status: 'rendered', updated_at: now() }).eq('id', p.id).select().single();
    saveToGallery({ userId: req.user.id, kind: 'video', url: r.url, feature: 'video', prompt: p.title, model: 'render', durationSeconds: r.seconds, projectKind: 'video', projectId: p.id, role: 'render', provider: 'cloudinary' });
    return { data: { project: await view(data), timeline: r.timeline }, outputUrl: r.url, durationSeconds: r.seconds };
  });
});

export default router;
