// Bascardo Video Studio API (config/videoEngine.js, migration 075). Pro and
// Business only: every route that spends anything checks the plan first,
// before any provider is called (requireVideoPlan).
//
//   1. Plan     POST /projects              idea / script / a story + length → shot list   (videoPlan / videoPlanWithReference)
//               PATCH /projects/:id         edit the look card / title; free
//               PATCH /projects/:id/shots/:sid  edit a shot, use your own clip or a start picture; free
//   2. Shoot    POST /projects/:id/shots/:sid/generate   one clip, as a background job        (video credits)
//   3. Sound    POST /projects/:id/voiceover  the shots' narration as one voice track         (narration credits / minute)
//               POST /projects/:id/music      an instrumental soundtrack                       (song credits / minute)
//               PATCH /projects/:id { music_url } to use a song from the Gallery instead; free
//   4. Render   POST /projects/:id/render     join the clips + sound into one MP4             (videoRender)
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
import { renderVideo, ensureOnCloudinary } from '../utils/renderVideo.js';
import { planVideo, shotBudget, shotPrompt, referenceFrames, LENGTHS, LIMITS, VIDEO_PLAN_MODEL, PROMPT_VERSION, VideoError, clipModel } from '../config/videoEngine.js';
import { assembleShot, cleanAsset, cleanSlots, continuityNotes, hasSlots, readiness, SLOTS, POSITIONS, POSES, EXPRESSIONS, LIMITS as CAST_LIMITS } from '../config/videoCast.js';
import { prepareAssetImage, BACKGROUND_MODEL } from '../utils/assetImages.js';
import { callRunwareTasks } from '../utils/runwareClient.js';
import { AI_MODELS } from '../config/aiModels.js';
import { v2 as cloudinary } from 'cloudinary';

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

async function view(project, shots = null) {
  const list = shots || await loadShots(project.id);
  const assets = list.some((s) => hasSlots(s.cast_slots)) ? await loadAssets(project.user_id) : {};
  const continuity = continuityNotes(list, assets);
  return {
    ...project,
    shots: list.map((s) => {
      if (!hasSlots(s.cast_slots)) return { ...s, prompt: shotPrompt(project, s), references: [], continuity: [] };
      const a = assembleShot(project, s, assets);
      return { ...s, prompt: a.prompt, references: a.labels, continuity: continuity[s.id] || [] };
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
  const { data, error } = await supabase.from('video_projects').select('id, title, target_seconds, status, render_url, updated_at')
    .eq('user_id', req.user.id).order('updated_at', { ascending: false }).limit(50);
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
  const { data } = await supabase.from('story_projects').select('id, title, plan, kind, updated_at')
    .eq('user_id', req.user.id).order('updated_at', { ascending: false }).limit(30);
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

  return runCharged(req, res, { kind: 'plan', action: frames.length ? 'videoPlanWithReference' : 'videoPlan' }, async () => {
    const r = await planVideo({ idea: idea || 'Turn this story into a video.', storyContext, targetSeconds: b.targetSeconds, frames });
    const { data: project, error } = await supabase.from('video_projects').insert({
      user_id: req.user.id, title: r.plan.title, idea: idea || '(from a story)', source_kind: storyId ? 'story' : frames.length ? 'reference' : 'idea', source_id: storyId,
      target_seconds: b.targetSeconds, clip_seconds: b.clipSeconds, model: b.model, logline: r.plan.logline, look_card: r.plan.look_card, fit_note: r.plan.fit_note || null,
      reference: frames.length ? { video_url: refVideo, frames, description: r.plan.reference_style, how: 'analysed from 3 frames, not given to the video model' } : null,
    }).select().single();
    if (error) throw error;
    const { error: sErr } = await supabase.from('video_shots').insert(r.plan.shots.map((s) => ({ ...s, project_id: project.id, duration_seconds: b.clipSeconds })));
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
  const { data, error } = await supabase.from('video_projects').update(up).eq('id', p.id).select().single();
  if (error) return fail(res, 500, 'Could not save');
  res.json({ success: true, data: await view(data) });
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
  if (b.clip_url !== undefined) {
    if (b.clip_url) {
      if (!HTTPS.test(String(b.clip_url))) return fail(res, 400, 'Invalid video link');
      try { up.clip_public_id = await ensureOnCloudinary(b.clip_url); } catch { return fail(res, 400, 'Could not use that video'); }
      Object.assign(up, { clip_url: b.clip_url, source: 'upload', status: 'ready', job_id: null });
    } else Object.assign(up, { clip_url: null, clip_public_id: null, status: 'planned', source: 'ai' });
  }
  const { error } = await supabase.from('video_shots').update(up).eq('id', shot.id);
  if (error) return fail(res, 500, 'Could not save the shot');
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
  let prompt = shotPrompt(p, shot);
  let referenceImages = null;
  if (hasSlots(shot.cast_slots)) {
    const a = assembleShot(p, shot, await loadAssets(req.user.id));
    prompt = a.prompt;
    if (!withStart && a.references.length) referenceImages = a.references;
  }
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
  if (!req.body?.remove_background) {
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
      positivePrompt: `A single film frame, the first frame of this shot.\n${a.prompt}`,
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

// ── 3. Sound ────────────────────────────────────────────────────────────────
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

router.post('/projects/:id/music', authenticateToken, requireVideoPlan, async (req, res) => {
  const p = await loadProject(req.user.id, req.params.id);
  if (!p) return fail(res, 404, 'Video not found');
  const seconds = Math.max(30, Math.min(120, Math.ceil((p.target_seconds || 30) / 30) * 30));
  const style = String(req.body?.style || '').trim().slice(0, 300) || `${p.look_card?.style || 'cinematic'} instrumental soundtrack, ${p.logline || p.title}`;
  return runCharged(req, res, { kind: 'music', action: 'song', projectId: p.id, costOpts: { seconds }, log: { feature: 'voice', provider: 'runware', model: 'ace-step' } }, async () => {
    const r = await generateSong({ style, seconds, folder: 'bookofmemes/video-studio/music' });
    const { data } = await supabase.from('video_projects').update({ music_url: r.audioUrl, updated_at: now() }).eq('id', p.id).select().single();
    saveToGallery({ userId: req.user.id, kind: 'audio', url: r.audioUrl, feature: 'song', prompt: style, model: r.model, durationSeconds: r.seconds, projectKind: 'video', projectId: p.id, role: 'music', provider: 'runware', providerCost: r.cost });
    return { data: { project: await view(data) }, providerCost: r.cost, durationSeconds: r.seconds, outputUrl: r.audioUrl };
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
    const voice = p.voiceover_url ? await ensureOnCloudinary(p.voiceover_url) : null;
    const music = p.music_url ? await ensureOnCloudinary(p.music_url) : null;
    const r = await renderVideo({ clips: ready.map((s) => ({ publicId: s.clip_public_id, trimStart: Number(s.trim_start) || 0, trimEnd: s.trim_end ? Number(s.trim_end) : null })), voiceover: voice, music });
    const { data } = await supabase.from('video_projects').update({ render_url: r.url, render_seconds: r.seconds, status: 'rendered', updated_at: now() }).eq('id', p.id).select().single();
    saveToGallery({ userId: req.user.id, kind: 'video', url: r.url, feature: 'video', prompt: p.title, model: 'render', durationSeconds: r.seconds, projectKind: 'video', projectId: p.id, role: 'render', provider: 'cloudinary' });
    return { data: { project: await view(data) }, outputUrl: r.url, durationSeconds: r.seconds };
  });
});

export default router;
