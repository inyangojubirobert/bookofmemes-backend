// Bascardo Content Studio API (migration 071, config/contentEngine.js).
// The Story Studio's flow and bookkeeping (routes/storyRoutes.js) for memes,
// puzzles, kids, music, podcasts and TV.
//
// Three steps in the app:
//   1. Idea    POST /projects               idea -> 3 concepts                (contentIdeas credits)
//              POST /projects/:id/ideas     3 fresh concepts                  (contentIdeas credits)
//   2. Pick    POST /projects/:id/draft     picked concept (+ tweak) -> draft (contentDraft / contentDraftLong)
//   3. Post    PATCH /projects/:id          save the author's edits and media (free)
//              then Add Content posts it ($1 new title, as always) and
//              POST /projects/:id/posted    records which item it became  (free)
//              POST /projects/:id/narrate   podcast: the script as one audio file (narration credits per minute)
//
// Credits come from the monthly AI pool and are spent only after a step
// succeeded and was saved. Every AI step carries a request_id from the app: a
// retry with the same id returns the saved result without charging again, and
// a second tap while one is running is refused.
import express from 'express';
import { supabase } from '../config/db.js';
import { authenticateToken } from '../auth.js';
import { creditStatus, spendCredits, outOfCreditsMessage } from '../utils/aiCredits.js';
import { creditsFor } from '../config/aiPlans.js';
import { logGeneration } from '../utils/aiGenerationLog.js';
import { saveToGallery } from '../utils/gallery.js';
import { narrateScript, speakableText, estimateSeconds, MAX_SCRIPT_CHARS } from '../utils/podcastNarration.js';
import {
  proposeConcepts, writeDraft, draftToForm, publicTypes, ContentError,
  CONTENT_TYPES, STUDIO_TYPES, LIMITS, CONTENT_MODEL, PROMPT_VERSION,
} from '../config/contentEngine.js';

const router = express.Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQ_ID = /^[A-Za-z0-9_-]{8,80}$/;
const HTTPS = /^https:\/\/[^\s]+$/;
// Claude Haiku 4.5 list price, for the real cost logged with every step.
const USD_PER_TOKEN = { input: 1 / 1e6, output: 5 / 1e6 };

const fail = (res, status, error, extra = {}) => res.status(status).json({ success: false, error, ...extra });
const now = () => new Date().toISOString();

async function loadProject(userId, id) {
  if (!UUID.test(String(id))) return null;
  const { data } = await supabase.from('content_projects').select('*').eq('id', id).eq('user_id', userId).maybeSingle();
  return data;
}

// What the app gets: the project plus the Add Content form it fills.
const projectView = (p) => ({ ...p, form: p.draft ? draftToForm(p.item_type, p.draft) : null });

function addUsage(total, usage) {
  if (!usage) return total;
  return { input: total.input + (usage.input_tokens || 0), output: total.output + (usage.output_tokens || 0) };
}

// ── Charged AI step with idempotency (same contract as the Story Studio) ────
async function runCharged(req, res, { kind, action, itemType, projectId = null, costOpts = {}, log = {} }, work) {
  const userId = req.user.id;
  const requestId = String(req.body?.request_id || '');
  if (!REQ_ID.test(requestId)) return fail(res, 400, 'Missing request id. Please update the app.');

  const { data: prior } = await supabase.from('content_ai_requests').select('*').eq('request_id', requestId).maybeSingle();
  if (prior) {
    if (prior.user_id !== userId) return fail(res, 409, 'Request id already used.');
    if (prior.status === 'done') return res.json({ success: true, data: prior.response, replayed: true });
    if (prior.status === 'running' && Date.now() - new Date(prior.created_at).getTime() < 5 * 60000) {
      return fail(res, 409, 'Bascardo AI is still working on this. Give it a moment.');
    }
  }
  if (projectId) {
    const { data: busy } = await supabase.from('content_ai_requests').select('request_id')
      .eq('project_id', projectId).eq('status', 'running').neq('request_id', requestId)
      .gt('created_at', new Date(Date.now() - 5 * 60000).toISOString()).limit(1);
    if (busy?.length) return fail(res, 409, 'Bascardo AI is already working on this post. Give it a moment.');
  }

  const status = await creditStatus(userId);
  const cost = creditsFor(action, { premium: status.plan.premiumModels, ...costOpts });
  if (status.remaining < cost) {
    return fail(res, 402, outOfCreditsMessage(status, cost, ' Your credits renew on the 1st, or get more with a Bascardo AI plan.'), {
      code: 'out_of_credits', credits: { remaining: status.remaining, limit: status.limit, cost, plan: status.plan.name },
    });
  }

  const row = { request_id: requestId, user_id: userId, project_id: projectId, item_type: itemType, kind, status: 'running', credits: cost, error: null, response: null, input_tokens: null, output_tokens: null, created_at: now(), finished_at: null };
  const { error: lockErr } = prior
    ? await supabase.from('content_ai_requests').update(row).eq('request_id', requestId)
    : await supabase.from('content_ai_requests').insert(row);
  if (lockErr) return fail(res, 409, 'Bascardo AI is already working on this. Give it a moment.');

  const started = Date.now();
  const prompt = `content:${itemType}:${kind} ${PROMPT_VERSION}`;
  try {
    const { view, usage = { input: 0, output: 0 }, providerCost: workCost = null, durationSeconds = 0 } = await work(status);
    // Saved first, then charged: a failure above never costs credits.
    await spendCredits(userId, cost);
    const after = await creditStatus(userId).catch(() => null);
    const data = { ...view, credits: after ? { remaining: after.remaining, limit: after.limit, spent: cost } : { spent: cost } };
    const providerCost = workCost ?? Number((usage.input * USD_PER_TOKEN.input + usage.output * USD_PER_TOKEN.output).toFixed(6));
    await supabase.from('content_ai_requests').update({
      status: 'done', response: data, finished_at: now(), project_id: view?.project?.id || projectId,
      input_tokens: usage.input, output_tokens: usage.output,
    }).eq('request_id', requestId);
    logGeneration({ userId, feature: 'text', model: CONTENT_MODEL, provider: 'anthropic', ...log, tier: status.plan.id, success: true, requestId, inputPrompt: prompt, latencyMs: Date.now() - started, providerCost, durationSeconds, outputUrl: view?.audio_url || null });
    return res.json({ success: true, data });
  } catch (err) {
    console.error(`[content] ${itemType} ${kind} failed:`, err.message);
    await supabase.from('content_ai_requests').update({ status: 'failed', error: String(err.message).slice(0, 500), finished_at: now() }).eq('request_id', requestId);
    logGeneration({ userId, feature: 'text', model: CONTENT_MODEL, provider: 'anthropic', ...log, tier: status.plan.id, success: false, requestId, inputPrompt: prompt, errorMessage: err.message, latencyMs: Date.now() - started });
    const known = err instanceof ContentError || err.status === 400;
    return fail(res, known ? err.status : 500, known ? err.message : 'Bascardo AI could not finish this. Please try again (you were not charged).');
  }
}

// ── Setup info for the app ──────────────────────────────────────────────────
router.get('/config', authenticateToken, async (req, res) => {
  try {
    const status = await creditStatus(req.user.id);
    const premium = status.plan.premiumModels;
    const types = publicTypes();
    for (const t of Object.values(types)) t.draft_cost = creditsFor(t.draft_action, { premium });
    res.json({
      success: true,
      data: {
        types,
        costs: { ideas: creditsFor('contentIdeas', { premium }), image: creditsFor('image', { premium }), video: creditsFor('video', { premium }), video_with_reference: creditsFor('video', { premium, reference: true }), narration_per_minute: creditsFor('narration', { premium, seconds: 60 }) },
        limits: { ideaChars: LIMITS.ideaChars },
        credits: { remaining: status.remaining, limit: status.limit, plan: status.plan.name, resets_at: status.resetsAt },
        video_available: premium, // video is a Pro/Business feature
      },
    });
  } catch (err) {
    console.error('[content] config:', err.message);
    fail(res, 500, 'Could not load Content Studio');
  }
});

// ── My projects ─────────────────────────────────────────────────────────────
router.get('/projects', authenticateToken, async (req, res) => {
  let q = supabase.from('content_projects').select('id, item_type, idea, stage, chosen_concept, draft, published_item_id, updated_at')
    .eq('user_id', req.user.id).order('updated_at', { ascending: false }).limit(50);
  if (STUDIO_TYPES.includes(req.query.item_type)) q = q.eq('item_type', req.query.item_type);
  const { data, error } = await q;
  if (error) return fail(res, 500, 'Could not load your posts in progress');
  res.json({
    success: true,
    data: (data || []).map((p) => ({
      id: p.id, item_type: p.item_type, stage: p.stage, updated_at: p.updated_at, published_item_id: p.published_item_id,
      title: p.draft?.title || p.chosen_concept?.title || p.idea.slice(0, 60),
    })),
  });
});

router.get('/projects/:id', authenticateToken, async (req, res) => {
  const project = await loadProject(req.user.id, req.params.id);
  if (!project) return fail(res, 404, 'Post not found');
  res.json({ success: true, data: projectView(project) });
});

router.delete('/projects/:id', authenticateToken, async (req, res) => {
  const project = await loadProject(req.user.id, req.params.id);
  if (!project) return fail(res, 404, 'Post not found');
  await supabase.from('content_projects').delete().eq('id', project.id); // a posted item stays on Book of Memes
  res.json({ success: true });
});

// ── Step 1: idea -> 3 concepts ──────────────────────────────────────────────
router.post('/projects', authenticateToken, (req, res) => {
  const itemType = String(req.body?.item_type || '');
  if (!STUDIO_TYPES.includes(itemType)) return fail(res, 400, 'Pick what kind of post to make');
  const idea = String(req.body?.idea || '').trim();
  if (idea.length < 5) return fail(res, 400, 'Tell Bascardo a little about your idea (a few words is enough).');
  if (idea.length > LIMITS.ideaChars) return fail(res, 400, `Keep the idea under ${LIMITS.ideaChars.toLocaleString()} characters.`);
  const notes = String(req.body?.notes || '').trim().slice(0, LIMITS.notesChars) || null;

  return runCharged(req, res, { kind: 'concepts', action: 'contentIdeas', itemType }, async () => {
    const r = await proposeConcepts({ itemType, idea, notes });
    const { data: project, error } = await supabase.from('content_projects').insert({
      user_id: req.user.id, item_type: itemType, idea, notes, stage: 'choose',
      concepts: r.concepts, concepts_seen: r.concepts.map((c) => c.title),
    }).select().single();
    if (error) throw error;
    return { view: { project: projectView(project) }, usage: addUsage({ input: 0, output: 0 }, r.usage) };
  });
});

// Three fresh concepts, different from the ones already offered.
router.post('/projects/:id/ideas', authenticateToken, async (req, res) => {
  const project = await loadProject(req.user.id, req.params.id);
  if (!project) return fail(res, 404, 'Post not found');
  const wish = String(req.body?.wish || '').trim().slice(0, LIMITS.notesChars);
  return runCharged(req, res, { kind: 'ideas', action: 'contentIdeas', itemType: project.item_type, projectId: project.id }, async () => {
    const notes = [project.notes, wish && `Now looking for: ${wish}`].filter(Boolean).join('. ') || null;
    const r = await proposeConcepts({ itemType: project.item_type, idea: project.idea, notes, avoid: project.concepts_seen || [] });
    const seen = [...(project.concepts_seen || []), ...r.concepts.map((c) => c.title)].slice(-30);
    const { data: updated, error } = await supabase.from('content_projects')
      .update({ concepts: r.concepts, concepts_seen: seen, updated_at: now() }).eq('id', project.id).select().single();
    if (error) throw error;
    return { view: { project: projectView(updated) }, usage: addUsage({ input: 0, output: 0 }, r.usage) };
  });
});

// ── Step 2: pick a concept -> the finished draft ────────────────────────────
// Also used to rewrite the draft with the same concept and a new tweak.
router.post('/projects/:id/draft', authenticateToken, async (req, res) => {
  const project = await loadProject(req.user.id, req.params.id);
  if (!project) return fail(res, 404, 'Post not found');
  const idx = req.body?.concept_index;
  const custom = String(req.body?.custom || '').trim().slice(0, 1200);
  const tweak = String(req.body?.tweak || '').trim().slice(0, LIMITS.tweakChars);
  let concept;
  if (custom) concept = { title: 'My own idea', pitch: custom };
  else if (Number.isInteger(idx) && project.concepts?.[idx]) concept = { ...project.concepts[idx] };
  else if (req.body?.rewrite && project.chosen_concept) concept = { ...project.chosen_concept };
  else return fail(res, 400, 'Pick one of the ideas, or describe your own');
  if (tweak) concept.author_tweak = tweak;

  const spec = CONTENT_TYPES[project.item_type];
  return runCharged(req, res, { kind: 'draft', action: spec.draftAction, itemType: project.item_type, projectId: project.id }, async () => {
    const r = await writeDraft({ itemType: project.item_type, idea: project.idea, notes: project.notes, concept, tweak: concept.author_tweak });
    const { data: updated, error } = await supabase.from('content_projects').update({
      chosen_concept: concept, draft: r.draft, drafts_made: (project.drafts_made || 0) + 1,
      stage: project.stage === 'posted' ? 'posted' : 'draft', updated_at: now(),
    }).eq('id', project.id).select().single();
    if (error) throw error;
    return { view: { project: projectView(updated) }, usage: addUsage({ input: 0, output: 0 }, r.usage) };
  });
});

// ── Step 3: the author's edits and the media they made (free) ───────────────
router.patch('/projects/:id', authenticateToken, async (req, res) => {
  const project = await loadProject(req.user.id, req.params.id);
  if (!project) return fail(res, 404, 'Post not found');
  if (!project.draft) return fail(res, 400, 'There is no draft yet');
  const update = { updated_at: now() };

  if (req.body?.draft && typeof req.body.draft === 'object') {
    const draft = { ...project.draft };
    // Only fields Bascardo wrote can be edited, and only as text/lists.
    for (const [k, v] of Object.entries(req.body.draft)) {
      if (!(k in project.draft)) continue;
      if (k === 'quiz') {
        if (!v || typeof v !== 'object') continue;
        draft.quiz = {
          question_text: String(v.question_text ?? draft.quiz?.question_text ?? '').slice(0, 300),
          correct_answer: String(v.correct_answer ?? draft.quiz?.correct_answer ?? '').slice(0, 120),
          wrong_answers: (Array.isArray(v.wrong_answers) ? v.wrong_answers : draft.quiz?.wrong_answers || []).slice(0, 3).map((w) => String(w).slice(0, 120)),
          explanation: String(v.explanation ?? draft.quiz?.explanation ?? '').slice(0, 400),
        };
      } else if (Array.isArray(v)) draft[k] = v.slice(0, 12).map((x) => String(x).slice(0, 400));
      else if (typeof v === 'string') draft[k] = v.slice(0, k === 'script' || k === 'lyrics' ? 12000 : 2000);
    }
    update.draft = draft;
    // A narration of an older script no longer matches: drop it so the old audio isn't posted.
    if (draft.script !== project.draft.script && project.media?.audio_url) {
      update.media = { ...(project.media || {}) };
      delete update.media.audio_url; delete update.media.audio_seconds;
    }
  }
  if (req.body?.media && typeof req.body.media === 'object') {
    const media = { ...(update.media || project.media || {}) };
    for (const k of ['image_url', 'video_url', 'audio_url']) {
      if (req.body.media[k] === null) { delete media[k]; if (k === 'audio_url') delete media.audio_seconds; }
      else if (req.body.media[k] !== undefined) {
        if (!HTTPS.test(String(req.body.media[k]))) return fail(res, 400, 'Invalid media link');
        media[k] = String(req.body.media[k]);
      }
    }
    update.media = media;
  }
  const { data, error } = await supabase.from('content_projects').update(update).eq('id', project.id).select().single();
  if (error) return fail(res, 500, 'Could not save');
  res.json({ success: true, data: projectView(data) });
});

// ── Podcast: narrate the script as one audio file ───────────────────────────
// Priced like any narration (narration credits per started minute), charged
// only once the audio is uploaded; the same request id never narrates twice.
router.post('/projects/:id/narrate', authenticateToken, async (req, res) => {
  const project = await loadProject(req.user.id, req.params.id);
  if (!project) return fail(res, 404, 'Post not found');
  if (project.item_type !== 'podcast_box' || !project.draft?.script) return fail(res, 400, 'Only a podcast script can be narrated');
  if (!process.env.RUNWARE_API_KEY) return fail(res, 501, 'Narration is not available yet');
  const text = speakableText(project.draft.script);
  if (text.length > MAX_SCRIPT_CHARS) return fail(res, 400, `The script is too long to narrate (${MAX_SCRIPT_CHARS.toLocaleString()} characters at most). Shorten it and try again.`);
  const seconds = estimateSeconds(text);

  return runCharged(req, res, {
    kind: 'narrate', action: 'narration', itemType: project.item_type, projectId: project.id,
    costOpts: { seconds }, log: { feature: 'voice', provider: 'runware', model: null },
  }, async (status) => {
    const r = await narrateScript(project.draft.script, { useHdModel: status.plan.premiumModels, userId: req.user.id });
    const media = { ...(project.media || {}), audio_url: r.audioUrl, audio_seconds: r.seconds };
    saveToGallery({ userId: req.user.id, kind: 'audio', url: r.audioUrl, feature: 'podcast_narration', prompt: project.draft.title || null, model: r.model, durationSeconds: r.seconds });
    const { data: updated, error } = await supabase.from('content_projects').update({ media, updated_at: now() }).eq('id', project.id).select().single();
    if (error) throw error;
    return { view: { project: projectView(updated), audio_url: r.audioUrl }, providerCost: r.providerCost, durationSeconds: r.seconds };
  });
});

// Add Content posted it: remember which item it became.
router.post('/projects/:id/posted', authenticateToken, async (req, res) => {
  const project = await loadProject(req.user.id, req.params.id);
  if (!project) return fail(res, 404, 'Post not found');
  const itemId = String(req.body?.item_id || '');
  if (!UUID.test(itemId)) return fail(res, 400, 'Missing item');
  const { data: item } = await supabase.from(project.item_type).select('id').eq('id', itemId).eq('author_id', req.user.id).maybeSingle();
  if (!item) return fail(res, 404, 'That post was not found');
  const { data, error } = await supabase.from('content_projects')
    .update({ stage: 'posted', published_item_id: itemId, published_at: project.published_at || now(), updated_at: now() })
    .eq('id', project.id).select().single();
  if (error) return fail(res, 500, 'Could not save');
  res.json({ success: true, data: projectView(data) });
});

export default router;
