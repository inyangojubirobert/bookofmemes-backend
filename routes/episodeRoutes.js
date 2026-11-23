// Auto Episode Engine API (Mode 2) — /api/episodes. Migration 084.
// The user does the setup (script, genre pack, cast, style, voices, format); the
// episode is then built in the background by utils/episodePipeline.js. A finished
// episode is an ordinary Video Studio project, so Creator Studio (Mode 1) can
// edit any shot, line, sound or colour afterwards.
//
//   GET  /options                      choices + prices + the user's series and cast
//   POST /scan            { script }   names in the script, matched to the user's templates (1 credit)
//   POST /estimate                     credits an episode should cost (free)
//   GET  /series | POST /series | GET /series/:id
//   POST /                             start an episode
//   GET  /:id                          progress, stages, shots (storyboard)
//   POST /:id/continue                 approve the storyboard / resume after credits / retry
//   POST /:id/pause
//   POST /:id/shots/:sid/redraw        draw a keyframe again (storyboard review; keyframe credits)
import express from 'express';
import crypto from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { supabase } from '../config/db.js';
import { authenticateToken } from '../auth.js';
import { creditStatus, reserveCredits, commitCredits, releaseCredits, outOfCreditsMessage } from '../utils/aiCredits.js';
import { creditsFor } from '../config/aiPlans.js';
import { callRunwareTasks } from '../utils/runwareClient.js';
import { v2 as cloudinary } from 'cloudinary';
import { AI_MODELS } from '../config/aiModels.js';
import { assembleShot } from '../config/videoCast.js';
import { lightText, VOICES, MUSIC_THEMES, LOOKS, ASPECTS, validVoiceId } from '../config/soundStudio.js';
import { customVoiceMap, publicCustomVoice } from '../utils/customVoices.js';
import { GENRE_PACKS, FORMATS, VISUAL_MODES, DRAMA_MODES, ART_STYLES, LIMITS, estimateCredits, EPISODE_MODEL, AUTOMATION_PREMIUM } from '../config/episodeEngine.js';
const capOf = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n > 0 ? Math.min(n, 1000000) : null; };
import { STAGES, advanceEpisode, kickEpisodes } from '../utils/episodePipeline.js';
import fs from 'fs';

const router = express.Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (res, status, error, extra = {}) => res.status(status).json({ success: false, error, ...extra });
const now = () => new Date().toISOString();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const needs084 = (err) => /video_series|column|schema cache|PGRST20[45]/i.test(err?.message || '');
const saveFail = (res, err, what) => (needs084(err)
  ? fail(res, 503, 'The Auto Episode Engine is not switched on yet (migration 084).', { code: 'needs_migration' })
  : (console.error('[episodes]', what, err?.message), fail(res, 500, what)));

let LIBRARY = { music: [] };
try { LIBRARY = JSON.parse(fs.readFileSync(new URL('../config/soundLibrary.json', import.meta.url), 'utf8')); } catch { /* optional */ }

async function requirePlan(req, res, next) {
  try {
    const status = await creditStatus(req.user.id);
    if (!status.plan.premiumModels) return fail(res, 403, 'The Auto Episode Engine is part of the Bascardo AI Pro and Business plans.', { code: 'video_needs_plan' });
    req.creditStatus = status;
    next();
  } catch { fail(res, 500, 'Could not check your plan'); }
}
async function loadEpisode(userId, id) {
  if (!UUID.test(String(id))) return null;
  const { data } = await supabase.from('video_projects').select('*').eq('id', id).eq('user_id', userId).eq('engine', 'auto').maybeSingle();
  return data;
}

function episodeView(p, shots = []) {
  const pl = p.pipeline || {};
  const at = STAGES.findIndex((s) => s.id === (pl.stage || 'breakdown'));
  return {
    id: p.id, title: p.title, logline: p.logline, cut_note: p.fit_note, series_id: p.series_id, episode_number: p.episode_number,
    aspect: p.aspect, render_url: p.render_url, render_seconds: p.render_seconds, settings: p.settings,
    status: pl.status, stage: pl.stage, message: pl.message, progress: pl.progress || null, credits_used: pl.credits_used || 0,
    // Pay as you go: the running bill (first attempts incl. the automation premium, redraws and
    // failed attempts at base price), the user's cap, and the final total once finished.
    billing: { first: 0, premium: 0, redraws: 0, failed: 0, steps: 0, ...(pl.billing || {}) }, spend_cap: p.settings?.spend_cap || null,
    premium_pct: Math.round(AUTOMATION_PREMIUM * 100), final_total: pl.status === 'done' ? pl.credits_used || 0 : null,
    estimate: pl.estimate || null, thumbnail: pl.thumbnail || null, log: (pl.log || []).slice(-25),
    stages: STAGES.filter((s) => s.id !== 'storyboard' || p.settings?.review_storyboard).map((s) => {
      const i = STAGES.findIndex((x) => x.id === s.id);
      return { id: s.id, label: s.label, state: pl.stage === 'done' || i < at ? 'done' : i === at ? (pl.status === 'running' ? 'running' : pl.status) : 'todo' };
    }),
    shots: shots.map((x) => ({
      id: x.id, number: x.number, scene_no: x.scene_no, kind: x.kind, motion: x.motion, visual: x.visual, status: x.status,
      still_url: x.still_url, clip_url: x.clip_url, qc: x.qc, duration_seconds: x.duration_seconds,
      lines: (x.lines || []).map((l) => ({ speaker: l.speaker, text: l.text, tone: l.tone, recorded: !!l.url })),
    })),
  };
}

// ── Setup ───────────────────────────────────────────────────────────────────
router.get('/options', authenticateToken, async (req, res) => {
  const status = await creditStatus(req.user.id).catch(() => null);
  const customs = await customVoiceMap(req.user.id);
  const [{ data: series }, { data: assets }] = await Promise.all([
    supabase.from('video_series').select('id, title, genre, settings, episode_count, updated_at').eq('user_id', req.user.id).order('updated_at', { ascending: false }).limit(50),
    supabase.from('video_assets').select('*').eq('user_id', req.user.id).order('updated_at', { ascending: false }).limit(200),
  ]);
  const unit = (a, o = {}) => creditsFor(a, { premium: true, ...o });
  res.json({ success: true, data: {
    available: !!status?.plan?.premiumModels, credits: status ? { remaining: status.remaining, plan: status.plan.name } : null,
    genres: Object.entries(GENRE_PACKS).map(([id, g]) => ({ id, label: g.label, music: g.music, look: g.look, drama: g.drama })),
    formats: FORMATS, visual_modes: Object.entries(VISUAL_MODES).map(([id, v]) => ({ id, label: v.label, about: v.about, max_seconds: v.maxSeconds || null })),
    drama_modes: Object.entries(DRAMA_MODES).map(([id, d]) => ({ id, label: d.label, about: d.about })),
    art_styles: Object.entries(ART_STYLES).map(([id, a]) => ({ id, label: a.label })),
    looks: Object.entries(LOOKS).map(([id, l]) => ({ id, label: l.label })), aspects: Object.keys(ASPECTS),
    voices: VOICES.map((v) => ({ id: v.id, name: v.name, about: v.about, accent: v.accent, gender: v.gender })),
    custom_voices: Object.values(customs).map(publicCustomVoice),
    music: MUSIC_THEMES.map((t) => ({ id: t.id, label: t.label, url: LIBRARY.music.find((m) => m.id === t.id)?.url || null })),
    series: series || [], cast: (assets || []).map((a) => ({ id: a.id, kind: a.kind, name: a.name, picture: a.refs?.[0]?.url || null, voice_id: a.voice_id || null })),
    limits: { script_chars: LIMITS.scriptChars },
    premium_pct: Math.round(AUTOMATION_PREMIUM * 100),
    prices: { image: unit('image'), keyframe: unit('keyframe'), clip: unit('video', { reference: true }), still_motion: unit('stillMotion'), voice_line: unit('voiceLine'), breakdown: unit('episodeBreakdown'), breakdown_long: unit('episodeBreakdownLong'), render: unit('episodeRender'), ledger: unit('episodeLedger'), scan: unit('writing') },
  } });
});

router.post('/estimate', authenticateToken, (req, res) => {
  const f = FORMATS.find((x) => x.id === req.body?.format) || FORMATS[1];
  const e = estimateCredits({ seconds: f.seconds, visual_mode: req.body?.visual_mode, newCast: Math.max(0, Math.min(12, Number(req.body?.new_cast) || 3)) }, creditsFor);
  res.json({ success: true, data: e });
});

// Names in the script, so the user can map "ELLIE" to their Ellie template before anything is made.
router.post('/scan', authenticateToken, requirePlan, async (req, res) => {
  const script = String(req.body?.script || '').trim();
  if (script.length < 40) return fail(res, 400, 'Paste or write the script first (a few sentences at least).');
  const status = req.creditStatus;
  const cost = creditsFor('writing', { premium: true });
  const reservation = await reserveCredits(req.user.id, status.plan, cost, `epscan:${crypto.randomUUID()}`);
  if (!reservation) return fail(res, 402, outOfCreditsMessage(status, cost), { code: 'out_of_credits' });
  try {
    const m = await anthropic.messages.create({ model: EPISODE_MODEL, max_tokens: 700, messages: [{ role: 'user', content: `List the characters (people or talking animals) and the places in this script. Use each one's main name.\n<source>\n${script.slice(0, LIMITS.scriptChars).replace(/<\/?source>/gi, '')}\n</source>\nReply with JSON only: {"characters": ["Name"], "locations": ["Place"]}` }] });
    const raw = m.content.filter((x) => x.type === 'text').map((x) => x.text).join('');
    const d = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    await commitCredits(req.user.id, reservation);
    const { data: assets } = await supabase.from('video_assets').select('id, kind, name').eq('user_id', req.user.id).limit(200);
    const match = (name, kind) => (assets || []).find((a) => a.kind === kind && a.name.trim().toLowerCase() === String(name).trim().toLowerCase())?.id || null;
    const clean = (v) => (Array.isArray(v) ? v : []).map((x) => String(x || '').trim().slice(0, 60)).filter(Boolean).slice(0, 15);
    res.json({ success: true, data: {
      characters: clean(d.characters).map((name) => ({ name, asset_id: match(name, 'character') })),
      locations: clean(d.locations).map((name) => ({ name, asset_id: match(name, 'location') })),
    } });
  } catch (err) {
    await releaseCredits(reservation);
    console.error('[episodes] scan:', err.message);
    fail(res, 502, 'Could not read the names. Try again (you were not charged).');
  }
});

// ── Series ──────────────────────────────────────────────────────────────────
router.get('/series', authenticateToken, async (req, res) => {
  const { data, error } = await supabase.from('video_series').select('*').eq('user_id', req.user.id).order('updated_at', { ascending: false }).limit(50);
  if (error) return saveFail(res, error, 'Could not load your series');
  res.json({ success: true, data: data || [] });
});

router.get('/series/:sid', authenticateToken, async (req, res) => {
  if (!UUID.test(req.params.sid)) return fail(res, 404, 'Series not found');
  const { data: s } = await supabase.from('video_series').select('*').eq('id', req.params.sid).eq('user_id', req.user.id).maybeSingle();
  if (!s) return fail(res, 404, 'Series not found');
  const { data: eps } = await supabase.from('video_projects').select('id, title, episode_number, render_url, render_seconds, pipeline, updated_at').eq('series_id', s.id).order('episode_number');
  res.json({ success: true, data: { ...s, episodes: (eps || []).map((e) => ({ id: e.id, title: e.title, episode_number: e.episode_number, render_url: e.render_url, render_seconds: e.render_seconds, status: e.pipeline?.status, thumbnail: e.pipeline?.thumbnail || null })) } });
});

// ── Start an episode ────────────────────────────────────────────────────────
router.post('/', authenticateToken, requirePlan, async (req, res) => {
  const b = req.body || {};
  const script = String(b.script || '').trim();
  if (script.length < 40) return fail(res, 400, 'Paste or write the script first (a few sentences at least).');
  if (script.length > LIMITS.scriptChars) return fail(res, 400, `Keep the script under ${LIMITS.scriptChars.toLocaleString()} characters (split a long chapter into episodes).`);
  const genre = GENRE_PACKS[b.genre] ? b.genre : 'drama';
  const pack = GENRE_PACKS[genre];
  const format = FORMATS.find((f) => f.id === b.format) || FORMATS[1];
  let visual = VISUAL_MODES[b.visual_mode] ? b.visual_mode : 'stills';
  if (VISUAL_MODES[visual].maxSeconds && format.seconds > VISUAL_MODES[visual].maxSeconds) visual = 'mixed';
  const castMap = {};
  for (const [name, id] of Object.entries(b.cast_map || {})) if (UUID.test(String(id))) castMap[String(name).slice(0, 60)] = id;

  // The series: an existing one (its Story Bible settings win) or a new one.
  let series = null;
  if (b.series_id) {
    if (!UUID.test(String(b.series_id))) return fail(res, 404, 'Series not found');
    const { data } = await supabase.from('video_series').select('*').eq('id', b.series_id).eq('user_id', req.user.id).maybeSingle();
    if (!data) return fail(res, 404, 'Series not found');
    series = data;
  } else if (String(b.series_title || '').trim()) {
    const { data, error } = await supabase.from('video_series').insert({
      user_id: req.user.id, title: String(b.series_title).trim().slice(0, 120), genre,
      settings: { art_style: ART_STYLES[b.art_style] ? b.art_style : 'cinematic', look: LOOKS[b.look] ? b.look : pack.look, aspect: ASPECTS[b.aspect] ? b.aspect : 'portrait', narrator_voice: validVoiceId(b.narrator_voice) ? b.narrator_voice : null, music_theme: MUSIC_THEMES.some((t) => t.id === b.music_theme) ? b.music_theme : null }, // only a real theme ('auto' and 'none' are per episode)
    }).select().single();
    if (error) return saveFail(res, error, 'Could not create the series');
    series = data;
  }
  const ss = series?.settings || {};
  const settings = {
    genre, seconds: format.seconds, format: format.id, visual_mode: visual,
    drama_mode: DRAMA_MODES[b.drama_mode] ? b.drama_mode : pack.drama,
    art_style: ss.art_style || (ART_STYLES[b.art_style] ? b.art_style : 'cinematic'),
    narrator_voice: ss.narrator_voice || (validVoiceId(b.narrator_voice) ? b.narrator_voice : 'adrian'),
    review_storyboard: b.review_storyboard !== false, captions: b.captions !== false, cliffhanger: b.cliffhanger !== false, title_card: b.title_card !== false,
    spend_cap: capOf(b.spend_cap), // optional: pause when the episode has spent this much
    cast_map: castMap,
    // A voice per script name (built-in or the user's custom voice): "ELLIE" → "custom:…".
    voice_map: Object.fromEntries(Object.entries(b.voice_map || {}).filter(([n, id]) => String(n).trim() && validVoiceId(id)).slice(0, 15).map(([n, id]) => [String(n).trim().slice(0, 60), id])),
  };
  const aspect = ss.aspect || (ASPECTS[b.aspect] ? b.aspect : 'portrait');
  const look = ss.look || (LOOKS[b.look] ? b.look : pack.look);
  // 'auto' (default): Bascardo picks the theme from the script after reading it (utils/episodePipeline.js).
  const musicAuto = !b.music_theme || b.music_theme === 'auto';
  const seriesTheme = MUSIC_THEMES.some((t) => t.id === ss.music_theme) ? ss.music_theme : null; // older series stored 'auto'
  settings.music_auto = musicAuto && !seriesTheme;
  const themeId = b.music_theme === 'none' ? null : (MUSIC_THEMES.some((t) => t.id === b.music_theme) ? b.music_theme : seriesTheme || (musicAuto ? null : pack.music));
  const track = themeId ? LIBRARY.music.find((m) => m.id === themeId) : null;
  const estimate = estimateCredits({ seconds: format.seconds, visual_mode: visual, newCast: 3 }, creditsFor);
  const episodeNumber = series ? (series.episode_count || 0) + 1 : null;

  const { data: p, error } = await supabase.from('video_projects').insert({
    user_id: req.user.id, engine: 'auto', series_id: series?.id || null, episode_number: episodeNumber,
    title: String(b.title || '').trim().slice(0, 120) || (series ? `${series.title} · Episode ${episodeNumber}` : 'New episode'),
    idea: script.slice(0, 2000), script, source_kind: 'script', target_seconds: format.seconds, clip_seconds: 5, model: AI_MODELS.VIDEO.PREMIUM,
    aspect, status: 'shooting', settings,
    look_card: { style: ART_STYLES[settings.art_style].prompt, palette: '', setting: '', camera: '', characters: [] },
    finish: { look, strength: pack.strength || 'medium', captions: settings.captions, music_level: 'low', vignette: genre === 'horror' || genre === 'thriller' },
    voice: { voice_id: settings.narrator_voice, tone: pack.tone, speed: 1 },
    ...(track ? { music_url: track.url, music_title: track.title, music_history: [{ url: track.url, title: track.title, at: now(), planned: true }] } : {}),
    pipeline: { status: 'running', stage: 'breakdown', started_at: now(), credits_used: 0, estimate, log: [{ at: now(), text: 'Episode started.' }] },
  }).select().single();
  if (error) return saveFail(res, error, 'Could not start the episode');
  if (series) await supabase.from('video_series').update({ episode_count: Math.max(series.episode_count || 0, episodeNumber), updated_at: now() }).eq('id', series.id);
  kickEpisodes();
  res.status(202).json({ success: true, data: episodeView(p) });
});

router.get('/:id', authenticateToken, async (req, res) => {
  const p = await loadEpisode(req.user.id, req.params.id);
  if (!p) return fail(res, 404, 'Episode not found');
  const { data: shots } = await supabase.from('video_shots').select('*').eq('project_id', p.id).order('number');
  res.json({ success: true, data: episodeView(p, shots || []) });
});

router.post('/:id/continue', authenticateToken, requirePlan, async (req, res) => {
  const p = await loadEpisode(req.user.id, req.params.id);
  if (!p) return fail(res, 404, 'Episode not found');
  const pl = { ...(p.pipeline || {}) };
  if (pl.status === 'done') return fail(res, 400, 'This episode is finished. Edit it in the Video Studio.');
  if (pl.stage === 'storyboard') pl.storyboard_approved = true;
  // Raise (or clear, with 0) the spending cap when carrying on after it was reached.
  let settings = p.settings;
  if (req.body?.spend_cap !== undefined) {
    settings = { ...(p.settings || {}), spend_cap: capOf(req.body.spend_cap) };
    await supabase.from('video_projects').update({ settings }).eq('id', p.id);
  }
  if (pl.status === 'cap_reached' && settings?.spend_cap && (pl.credits_used || 0) >= settings.spend_cap) {
    return fail(res, 400, `You've used ${pl.credits_used} of your ${settings.spend_cap}-credit cap. Raise the cap to carry on.`, { code: 'cap_reached' });
  }
  pl.status = 'running'; pl.fails = {}; pl.message = 'Continuing…';
  pl.log = [...(pl.log || []), { at: now(), text: pl.stage === 'storyboard' ? 'Storyboard approved.' : 'Continued.' }].slice(-60);
  await supabase.from('video_projects').update({ pipeline: pl, updated_at: now() }).eq('id', p.id);
  kickEpisodes();
  res.json({ success: true, data: episodeView({ ...p, settings, pipeline: pl }) });
});

router.post('/:id/pause', authenticateToken, async (req, res) => {
  const p = await loadEpisode(req.user.id, req.params.id);
  if (!p) return fail(res, 404, 'Episode not found');
  const pl = { ...(p.pipeline || {}), status: 'paused', message: 'Paused. Tap Continue to carry on.' };
  await supabase.from('video_projects').update({ pipeline: pl, updated_at: now() }).eq('id', p.id);
  res.json({ success: true, data: episodeView({ ...p, pipeline: pl }) });
});

// Storyboard review: draw one keyframe again (optionally with a changed description).
router.post('/:id/shots/:sid/redraw', authenticateToken, requirePlan, async (req, res) => {
  const p = await loadEpisode(req.user.id, req.params.id);
  if (!p || !UUID.test(req.params.sid)) return fail(res, 404, 'Shot not found');
  const { data: shot } = await supabase.from('video_shots').select('*').eq('id', req.params.sid).eq('project_id', p.id).maybeSingle();
  if (!shot) return fail(res, 404, 'Shot not found');
  if (shot.status !== 'planned') return fail(res, 400, 'This shot is already animated. Edit it in the Video Studio instead.');
  const visual = typeof req.body?.visual === 'string' && req.body.visual.trim() ? req.body.visual.trim().slice(0, 600) : shot.visual;
  const status = req.creditStatus;
  const { data: assetRows } = await supabase.from('video_assets').select('*').eq('user_id', req.user.id).limit(500);
  const assets = Object.fromEntries((assetRows || []).map((x) => [x.id, x]));
  const a = assembleShot(p, { ...shot, visual }, assets, { maxChars: 2800 });
  const cost = creditsFor('keyframe', { premium: true, refs: a.references.length }); // priced by references sent
  const reservation = await reserveCredits(req.user.id, status.plan, cost, `epredraw:${crypto.randomUUID()}`);
  if (!reservation) return fail(res, 402, outOfCreditsMessage(status, cost), { code: 'out_of_credits' });
  try {
    const prompt = `A single film frame from an episode. ${lightText(shot.light)}\n${a.prompt}`;
    const [width, height] = { landscape: [1024, 576], portrait: [576, 1024], square: [1024, 1024] }[p.aspect] || [1024, 576];
    const { data } = await callRunwareTasks([{ taskType: 'imageInference', taskUUID: crypto.randomUUID(), model: AI_MODELS.IMAGE.PREMIUM, width, height, numberResults: 1, outputFormat: 'JPG', includeCost: true, positivePrompt: prompt.slice(0, 3000), ...(a.references.length ? { inputs: { referenceImages: a.references } } : {}) }]);
    if (!data?.[0]?.imageURL) throw new Error('No picture came back');
    const kept = await cloudinary.uploader.upload(data[0].imageURL, { folder: 'bookofmemes/video-studio/keyframes', resource_type: 'image' });
    await supabase.from('video_shots').update({ visual, still_url: kept.secure_url, start_image_url: shot.motion === 'clip' ? kept.secure_url : null, qc: { ok: true, notes: 'redrawn by you', tries: (shot.qc?.tries || 0) + 1 }, compiled: { ...(shot.compiled || {}), prompt, references: a.references, labels: a.labels }, updated_at: now() }).eq('id', shot.id);
    await commitCredits(req.user.id, reservation);
    // A redraw the user asked for: base price, no automation premium.
    const billing = { first: 0, premium: 0, redraws: 0, failed: 0, steps: 0, ...(p.pipeline?.billing || {}) };
    billing.redraws += cost; billing.steps += 1;
    const pl = { ...(p.pipeline || {}), billing, credits_used: (p.pipeline?.credits_used || 0) + cost };
    await supabase.from('video_projects').update({ pipeline: pl, updated_at: now() }).eq('id', p.id);
    const { data: shots } = await supabase.from('video_shots').select('*').eq('project_id', p.id).order('number');
    res.json({ success: true, data: episodeView({ ...p, pipeline: pl }, shots || []) });
  } catch (err) {
    await releaseCredits(reservation);
    console.error('[episodes] redraw:', err.message);
    fail(res, 502, 'Could not draw it this time. You were not charged.');
  }
});

export default router;
export { advanceEpisode };
