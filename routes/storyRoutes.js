// Bascardo Story Studio API (migration 064, config/storyEngine.js).
//
// The flow the app shows is three steps:
//   1. Idea   POST /projects              idea/script -> plan + 3 directions      (storyPlan credits)
//             POST /projects/import       or continue one of your stories         (storyContinue credits)
//   2. Pick   POST /projects/:id/choose   pick a direction, optionally tweak it   (free)
//   3. Write  POST /projects/:id/write    write the next chapter + update memory  (storyChapter credits)
//             then edit / publish; "what happens next" ideas come with each chapter,
//             POST /projects/:id/ideas gives fresh ones                         (storyIdeas credits)
//
// Credits come from the monthly AI credit pool (utils/aiCredits.js) and are
// spent only after a step succeeds and is saved. Every AI step carries a
// request_id from the app: a retry with the same id returns the saved result
// instead of running (and charging) again, and a second tap while one is
// running is refused.
import express from 'express';
import { supabase } from '../config/db.js';
import { authenticateToken } from '../auth.js';
import { creditStatus, spendCredits, outOfCreditsMessage } from '../utils/aiCredits.js';
import { creditsFor } from '../config/aiPlans.js';
import { chargeCredits, hasCredits, creditsToLogUnits } from '../utils/credits.js';
import { logGeneration } from '../utils/aiGenerationLog.js';
import {
  planStory, writeChapter, updateMemory, nextIdeas, readExisting, StoryError,
  GENRES, LIMITS, STORY_MODEL, PROMPT_VERSION,
} from '../config/storyEngine.js';

const router = express.Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQ_ID = /^[A-Za-z0-9_-]{8,80}$/;
const EDIT_DAYS = 30;
const NEW_TITLE_PRICE_USD = 1; // same as posting any new title in Add Content

const fail = (res, status, error, extra = {}) => res.status(status).json({ success: false, error, ...extra });
const now = () => new Date().toISOString();

async function loadProject(userId, id) {
  if (!UUID.test(String(id))) return null;
  const { data } = await supabase.from('story_projects').select('*').eq('id', id).eq('user_id', userId).maybeSingle();
  return data;
}
async function loadChapters(projectId) {
  const { data } = await supabase.from('story_project_chapters').select('*').eq('project_id', projectId).order('number');
  return data || [];
}

// What the app gets back: never the internal prompt, just the author's data.
async function projectView(project, chapters = null) {
  const list = chapters || await loadChapters(project.id);
  let published = {};
  const ids = list.filter((c) => c.chapter_id).map((c) => c.chapter_id);
  if (ids.length) {
    const { data } = await supabase.from('chapters').select('id, published_at').in('id', ids);
    published = Object.fromEntries((data || []).map((r) => [r.id, r.published_at]));
  }
  const pageIds = list.filter((c) => c.book_page_id).map((c) => c.book_page_id);
  if (pageIds.length) {
    const { data } = await supabase.from('book_pages').select('id, created_at').in('id', pageIds);
    for (const r of data || []) published[r.id] = r.created_at;
  }
  return {
    ...project,
    chapters: list.map((c) => {
      const at = c.chapter_id ? published[c.chapter_id] : c.book_page_id ? published[c.book_page_id] : null;
      const editableUntil = at ? new Date(new Date(at).getTime() + EDIT_DAYS * 86400000).toISOString() : null;
      return {
        ...c,
        published_at: at,
        editable_until: editableUntil,
        editable: c.status === 'draft' || (editableUntil && new Date(editableUntil) > new Date()),
        words: (c.content.match(/\S+/g) || []).length,
      };
    }),
  };
}

// ── Charged AI step with idempotency ────────────────────────────────────────
async function runCharged(req, res, { kind, action, projectId = null }, work) {
  const userId = req.user.id;
  const requestId = String(req.body?.request_id || '');
  if (!REQ_ID.test(requestId)) return fail(res, 400, 'Missing request id. Please update the app.');

  // Same request again: hand back what it produced, without charging again.
  const { data: prior } = await supabase.from('story_ai_requests').select('*').eq('request_id', requestId).maybeSingle();
  if (prior) {
    if (prior.user_id !== userId) return fail(res, 409, 'Request id already used.');
    if (prior.status === 'done') return res.json({ success: true, data: prior.response, replayed: true });
    if (prior.status === 'running' && Date.now() - new Date(prior.created_at).getTime() < 5 * 60000) {
      return fail(res, 409, 'Bascardo AI is still working on this. Give it a moment.');
    }
  }
  // One step at a time per project.
  if (projectId) {
    const { data: busy } = await supabase.from('story_ai_requests').select('request_id')
      .eq('project_id', projectId).eq('status', 'running').neq('request_id', requestId)
      .gt('created_at', new Date(Date.now() - 5 * 60000).toISOString()).limit(1);
    if (busy?.length) return fail(res, 409, 'Bascardo AI is already working on this story. Give it a moment.');
  }

  const status = await creditStatus(userId);
  const cost = creditsFor(action, { premium: status.plan.premiumModels });
  if (status.remaining < cost) {
    return fail(res, 402, outOfCreditsMessage(status, cost, ' Your credits renew on the 1st, or get more with a Bascardo AI plan.'), {
      code: 'out_of_credits', credits: { remaining: status.remaining, limit: status.limit, cost, plan: status.plan.name },
    });
  }

  const row = { request_id: requestId, user_id: userId, project_id: projectId, kind, status: 'running', credits: cost, error: null, response: null, created_at: now(), finished_at: null };
  const { error: lockErr } = prior
    ? await supabase.from('story_ai_requests').update(row).eq('request_id', requestId)
    : await supabase.from('story_ai_requests').insert(row);
  if (lockErr) return fail(res, 409, 'Bascardo AI is already working on this. Give it a moment.');

  const started = Date.now();
  try {
    const result = await work(cost);
    // Saved first, then charged: a failure above never costs credits.
    await spendCredits(userId, cost);
    const after = await creditStatus(userId).catch(() => null);
    const data = { ...result, credits: after ? { remaining: after.remaining, limit: after.limit, spent: cost } : { spent: cost } };
    await supabase.from('story_ai_requests').update({ status: 'done', response: data, finished_at: now(), project_id: result?.project?.id || projectId }).eq('request_id', requestId);
    logGeneration({ userId, feature: 'text', model: STORY_MODEL, provider: 'anthropic', tier: status.plan.id, success: true, requestId, inputPrompt: `story:${kind} ${PROMPT_VERSION}`, latencyMs: Date.now() - started });
    return res.json({ success: true, data });
  } catch (err) {
    console.error(`[story] ${kind} failed:`, err.message);
    await supabase.from('story_ai_requests').update({ status: 'failed', error: String(err.message).slice(0, 500), finished_at: now() }).eq('request_id', requestId);
    logGeneration({ userId, feature: 'text', model: STORY_MODEL, provider: 'anthropic', tier: status.plan.id, success: false, requestId, inputPrompt: `story:${kind} ${PROMPT_VERSION}`, errorMessage: err.message, latencyMs: Date.now() - started });
    return fail(res, err instanceof StoryError ? err.status : 500, err instanceof StoryError ? err.message : 'Bascardo AI could not finish this. Please try again (you were not charged).');
  }
}

// ── Setup info for the app ──────────────────────────────────────────────────
router.get('/config', authenticateToken, async (req, res) => {
  try {
    const status = await creditStatus(req.user.id);
    const premium = status.plan.premiumModels;
    res.json({
      success: true,
      data: {
        genres: GENRES,
        limits: { sourceChars: LIMITS.sourceChars, defaultChapters: LIMITS.defaultChapters, maxChapters: LIMITS.maxChapters },
        costs: {
          plan: creditsFor('storyPlan', { premium }), chapter: creditsFor('storyChapter', { premium }),
          ideas: creditsFor('storyIdeas', { premium }), continue: creditsFor('storyContinue', { premium }),
        },
        credits: { remaining: status.remaining, limit: status.limit, plan: status.plan.name, resets_at: status.resetsAt },
        edit_days: EDIT_DAYS,
        new_title_price_usd: NEW_TITLE_PRICE_USD,
      },
    });
  } catch (err) {
    console.error('[story] config:', err.message);
    fail(res, 500, 'Could not load Story Studio');
  }
});

// ── My projects ─────────────────────────────────────────────────────────────
router.get('/projects', authenticateToken, async (req, res) => {
  const { data, error } = await supabase.from('story_projects')
    .select('id, title, stage, plan, story_id, continued_from_story, updated_at, created_at')
    .eq('user_id', req.user.id).order('updated_at', { ascending: false }).limit(50);
  if (error) return fail(res, 500, 'Could not load your stories');
  const ids = (data || []).map((p) => p.id);
  const counts = {};
  if (ids.length) {
    const { data: ch } = await supabase.from('story_project_chapters').select('project_id, status').in('project_id', ids);
    for (const c of ch || []) {
      counts[c.project_id] ||= { drafts: 0, published: 0 };
      counts[c.project_id][c.status === 'published' ? 'published' : 'drafts']++;
    }
  }
  res.json({ success: true, data: (data || []).map((p) => ({ id: p.id, title: p.plan?.title || p.title || 'Untitled story', stage: p.stage, story_id: p.story_id, continued: p.continued_from_story, updated_at: p.updated_at, ...(counts[p.id] || { drafts: 0, published: 0 }) })) });
});

router.get('/projects/:id', authenticateToken, async (req, res) => {
  const project = await loadProject(req.user.id, req.params.id);
  if (!project) return fail(res, 404, 'Story not found');
  res.json({ success: true, data: await projectView(project) });
});

router.delete('/projects/:id', authenticateToken, async (req, res) => {
  const project = await loadProject(req.user.id, req.params.id);
  if (!project) return fail(res, 404, 'Story not found');
  // Only the private workspace goes; published chapters stay on Book of Memes.
  await supabase.from('story_projects').delete().eq('id', project.id);
  res.json({ success: true });
});

// The author's published stories that can be continued.
router.get('/my-stories', authenticateToken, async (req, res) => {
  const { data, error } = await supabase.from('stories').select('id, title, story_category, cover_image_url, created_at')
    .eq('author_id', req.user.id).order('created_at', { ascending: false }).limit(50);
  if (error) return fail(res, 500, 'Could not load your stories');
  res.json({ success: true, data: data || [] });
});

// ── Step 1: idea -> plan + directions ───────────────────────────────────────
router.post('/projects', authenticateToken, (req, res) => {
  const source = String(req.body?.source_text || '').trim();
  if (source.length < 20) return fail(res, 400, 'Tell Bascardo a bit more about your story (at least a sentence or two).');
  if (source.length > 60000) return fail(res, 400, 'That is too long. Paste up to 60,000 characters.');
  const genre = String(req.body?.genre || '').slice(0, 80) || null;
  const notes = String(req.body?.notes || '').slice(0, 1500) || null;
  const title = String(req.body?.title || '').slice(0, 120) || null;
  const target = Math.min(Math.max(parseInt(req.body?.target_chapters, 10) || LIMITS.defaultChapters, 3), LIMITS.maxChapters);

  return runCharged(req, res, { kind: 'plan', action: 'storyPlan' }, async () => {
    const r = await planStory({ source, genre, notes, targetChapters: target, title });
    const { data: project, error } = await supabase.from('story_projects').insert({
      user_id: req.user.id, title: r.plan.title || title, source_text: source, genre: r.plan.genre || genre, notes,
      target_chapters: target, stage: 'choose', plan: r.plan, directions: r.directions,
      memory: { summaries: [], characters: r.plan.characters, threads: [] },
    }).select().single();
    if (error) throw error;
    return { project: await projectView(project, []) };
  });
});

// ── Step 1 (alternative): continue one of my published stories ──────────────
router.post('/projects/import', authenticateToken, async (req, res) => {
  const storyId = String(req.body?.story_id || '');
  if (!UUID.test(storyId)) return fail(res, 400, 'Pick one of your stories');
  const { data: story } = await supabase.from('stories').select('*').eq('id', storyId).eq('author_id', req.user.id).maybeSingle();
  if (!story) return fail(res, 404, 'Story not found');
  const { data: chapters } = await supabase.from('chapters').select('chapter_number, chapter_title, chapter_content').eq('story_id', storyId).order('chapter_number');
  if (!chapters?.length) return fail(res, 400, 'This story has no chapters yet. Start it as a new story instead.');

  return runCharged(req, res, { kind: 'continue', action: 'storyContinue' }, async () => {
    const r = await readExisting({ story, chapters });
    const { data: project, error } = await supabase.from('story_projects').insert({
      user_id: req.user.id, title: story.title, genre: r.plan.genre,
      source_text: String(story.story_synopsis || story.description || story.title).slice(0, 60000) || story.title,
      stage: 'writing', plan: r.plan, chosen_direction: r.direction, directions: [r.direction],
      memory: { ...r.memory, last_chapter_tail: r.lastChapter ? String(r.lastChapter.chapter_content || '').slice(-LIMITS.previousTailChars) : '', start_after: r.lastNumber },
      next_options: r.nextIdeas, story_id: story.id, continued_from_story: true,
    }).select().single();
    if (error) throw error;
    return { project: await projectView(project, []) };
  });
});

// ── Step 2: pick a direction (free) ─────────────────────────────────────────
router.post('/projects/:id/choose', authenticateToken, async (req, res) => {
  const project = await loadProject(req.user.id, req.params.id);
  if (!project) return fail(res, 404, 'Story not found');
  const idx = Number(req.body?.direction_index);
  const tweak = String(req.body?.tweak || '').trim().slice(0, 1500);
  const custom = String(req.body?.custom || '').trim().slice(0, 2000);
  let direction;
  if (custom) direction = { name: 'My own direction', summary: custom, roadmap: [] };
  else if (Number.isInteger(idx) && project.directions?.[idx]) direction = { ...project.directions[idx] };
  else return fail(res, 400, 'Pick one of the directions, or describe your own');
  if (tweak) direction.author_tweak = tweak;
  const { data, error } = await supabase.from('story_projects')
    .update({ chosen_direction: direction, roadmap: direction.roadmap || [], stage: 'writing', updated_at: now() })
    .eq('id', project.id).select().single();
  if (error) return fail(res, 500, 'Could not save your choice');
  res.json({ success: true, data: await projectView(data) });
});

// ── Step 3: write the next chapter ──────────────────────────────────────────
router.post('/projects/:id/write', authenticateToken, async (req, res) => {
  const project = await loadProject(req.user.id, req.params.id);
  if (!project) return fail(res, 404, 'Story not found');
  if (project.stage !== 'writing' || !project.chosen_direction) return fail(res, 400, 'Pick a direction for your story first');
  const chapters = await loadChapters(project.id);
  const lastLocal = chapters[chapters.length - 1];
  const number = lastLocal ? lastLocal.number + 1 : (Number(project.memory?.start_after) || 0) + 1;
  if (chapters.length >= LIMITS.maxChapters) return fail(res, 400, `A story can have up to ${LIMITS.maxChapters} chapters in the studio.`);

  const optionIndex = req.body?.option_index;
  const custom = String(req.body?.custom || '').trim().slice(0, 1500);
  const idea = Number.isInteger(optionIndex) ? project.next_options?.[optionIndex] : null;
  const next = custom ? { custom } : idea ? { idea } : null;
  const previous = lastLocal || (project.memory?.last_chapter_tail ? { content: project.memory.last_chapter_tail } : null);

  return runCharged(req, res, { kind: 'chapter', action: 'storyChapter', projectId: project.id }, async () => {
    const written = await writeChapter({ project, number, previousChapter: previous, next, wordTarget: req.body?.words });
    const mem = await updateMemory({ project, chapter: { number, title: written.title, content: written.content } });
    const directionUsed = custom || (idea ? `${idea.title}: ${idea.what_happens}` : null);
    const { data: chapter, error } = await supabase.from('story_project_chapters').insert({
      project_id: project.id, number, title: written.title, content: written.content, summary: mem.summary, direction_used: directionUsed,
    }).select().single();
    if (error) throw error;
    const summaries = [...(project.memory?.summaries || []).filter((s) => s.number !== number), { number, title: written.title, summary: mem.summary }];
    const memory = { ...(project.memory || {}), summaries, characters: mem.characters.length ? mem.characters : project.memory?.characters || [], threads: mem.threads };
    const { data: updated } = await supabase.from('story_projects')
      .update({ memory, next_options: mem.nextIdeas, updated_at: now() }).eq('id', project.id).select().single();
    return { project: await projectView(updated), chapter_id: chapter.id, truncated: written.truncated };
  });
});

// Fresh "what happens next" ideas.
router.post('/projects/:id/ideas', authenticateToken, async (req, res) => {
  const project = await loadProject(req.user.id, req.params.id);
  if (!project) return fail(res, 404, 'Story not found');
  if (project.stage !== 'writing') return fail(res, 400, 'Pick a direction for your story first');
  return runCharged(req, res, { kind: 'ideas', action: 'storyIdeas', projectId: project.id }, async () => {
    const r = await nextIdeas({ project, wish: req.body?.wish });
    const { data: updated } = await supabase.from('story_projects').update({ next_options: r.nextIdeas, updated_at: now() }).eq('id', project.id).select().single();
    return { project: await projectView(updated) };
  });
});

// ── Publish as a story (chapters) or a book (illustrated pages) ─────────────
router.post('/projects/:id/settings', authenticateToken, async (req, res) => {
  const project = await loadProject(req.user.id, req.params.id);
  if (!project) return fail(res, 404, 'Story not found');
  const publishAs = req.body?.publish_as;
  if (!['stories', 'books_library'].includes(publishAs)) return fail(res, 400, 'Choose story or book');
  if (project.continued_from_story && publishAs !== 'stories') return fail(res, 400, 'This continues a published story, so it stays a story.');
  if ((project.story_id && publishAs === 'books_library') || (project.book_id && publishAs === 'stories')) {
    return fail(res, 400, 'Part of this is already published, so it can\'t switch now.');
  }
  const { data, error } = await supabase.from('story_projects').update({ publish_as: publishAs, updated_at: now() }).eq('id', project.id).select().single();
  if (error) return fail(res, 500, 'Could not save');
  res.json({ success: true, data: await projectView(data) });
});

// ── Edit a chapter (drafts any time; published ones for 30 days) ────────────
router.patch('/projects/:id/chapters/:cid', authenticateToken, async (req, res) => {
  const project = await loadProject(req.user.id, req.params.id);
  if (!project || !UUID.test(req.params.cid)) return fail(res, 404, 'Chapter not found');
  const { data: ch } = await supabase.from('story_project_chapters').select('*').eq('id', req.params.cid).eq('project_id', project.id).maybeSingle();
  if (!ch) return fail(res, 404, 'Chapter not found');
  const title = String(req.body?.title ?? ch.title).trim().slice(0, 120);
  const content = String(req.body?.content ?? ch.content).trim();
  let imageUrl = ch.image_url || null;
  if (req.body?.image_url !== undefined) {
    imageUrl = req.body.image_url ? String(req.body.image_url) : null;
    if (imageUrl && !/^https:\/\/[^\s]+$/.test(imageUrl)) return fail(res, 400, 'Invalid picture link');
  }
  if (!title || content.length < 50) return fail(res, 400, 'A chapter needs a title and some text');
  if (content.length > 60000) return fail(res, 400, 'That chapter is too long (60,000 characters at most)');

  if (ch.status === 'published' && ch.chapter_id) {
    // The database refuses edits after 30 days (chapters_edit_window); this is the friendly check.
    const { error } = await supabase.from('chapters').update({ chapter_title: title, chapter_content: content, updated_at: now() })
      .eq('id', ch.chapter_id).eq('author_id', req.user.id);
    if (error) return fail(res, 403, /30 days/.test(error.message) ? 'This chapter was published more than 30 days ago, so it can no longer be edited.' : 'Could not save the published chapter');
  }
  if (ch.status === 'published' && ch.book_page_id) {
    const { data: page } = await supabase.from('book_pages').select('created_at').eq('id', ch.book_page_id).maybeSingle();
    if (page && Date.now() - new Date(page.created_at).getTime() > EDIT_DAYS * 86400000) {
      return fail(res, 403, `This page was published more than ${EDIT_DAYS} days ago, so it can no longer be edited.`);
    }
    const { error } = await supabase.from('book_pages').update({ heading: title, content, image_url: imageUrl, updated_at: now() })
      .eq('id', ch.book_page_id).eq('author_id', req.user.id);
    if (error) return fail(res, 403, /marketplace/.test(error.message) ? error.message : 'Could not save the published page');
  }
  const { data, error } = await supabase.from('story_project_chapters').update({ title, content, image_url: imageUrl, updated_at: now() }).eq('id', ch.id).select().single();
  if (error) return fail(res, 500, 'Could not save');
  res.json({ success: true, data });
});

// Delete a draft chapter (only the newest, so numbering stays continuous).
router.delete('/projects/:id/chapters/:cid', authenticateToken, async (req, res) => {
  const project = await loadProject(req.user.id, req.params.id);
  if (!project || !UUID.test(req.params.cid)) return fail(res, 404, 'Chapter not found');
  const chapters = await loadChapters(project.id);
  const ch = chapters.find((c) => c.id === req.params.cid);
  if (!ch) return fail(res, 404, 'Chapter not found');
  if (ch.status !== 'draft') return fail(res, 400, 'Published chapters can\'t be deleted here');
  if (ch.number !== chapters[chapters.length - 1].number) return fail(res, 400, 'Only the newest draft can be deleted');
  await supabase.from('story_project_chapters').delete().eq('id', ch.id);
  const memory = { ...(project.memory || {}), summaries: (project.memory?.summaries || []).filter((s) => s.number !== ch.number) };
  await supabase.from('story_projects').update({ memory, updated_at: now() }).eq('id', project.id);
  res.json({ success: true });
});

// ── Publish a chapter ───────────────────────────────────────────────────────
// The first chapter of a new story creates the story itself, which costs the
// same as any new title ($1 in credits); later chapters are free.
router.post('/projects/:id/chapters/:cid/publish', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const project = await loadProject(userId, req.params.id);
  if (!project || !UUID.test(req.params.cid)) return fail(res, 404, 'Chapter not found');
  const chapters = await loadChapters(project.id);
  const ch = chapters.find((c) => c.id === req.params.cid);
  if (!ch) return fail(res, 404, 'Chapter not found');
  if (ch.status === 'published') return res.json({ success: true, data: await projectView(project, chapters), already: true });
  const earlierDraft = chapters.find((c) => c.number < ch.number && c.status !== 'published');
  if (earlierDraft) return fail(res, 400, `Publish chapter ${earlierDraft.number} first`);

  if (project.publish_as === 'books_library') return publishAsBookPage(req, res, project, chapters, ch);

  let storyId = project.story_id;
  let createdStory = null;
  try {
    if (!storyId) {
      if (!(await hasCredits(userId, NEW_TITLE_PRICE_USD))) {
        return fail(res, 402, `Publishing a new story costs $${NEW_TITLE_PRICE_USD.toFixed(2)} in credits (like any new title). Later chapters are free.`, { code: 'needs_wallet_credits' });
      }
      const plan = project.plan || {};
      const { data: story, error } = await supabase.from('stories').insert({
        author_id: userId, universal_item_type: 'stories', is_published: true,
        title: String(req.body?.story_title || plan.title || project.title || 'Untitled story').slice(0, 120),
        story_category: String(req.body?.category || plan.genre || project.genre || 'Story').slice(0, 80),
        story_synopsis: String(req.body?.synopsis || plan.synopsis || plan.logline || '').slice(0, 2000) || null,
        cover_image_url: req.body?.cover_image_url && /^https:\/\//.test(req.body.cover_image_url) ? req.body.cover_image_url : null,
      }).select().single();
      if (error) throw error;
      createdStory = story;
      storyId = story.id;
    } else {
      const { data: s } = await supabase.from('stories').select('id').eq('id', storyId).eq('author_id', userId).maybeSingle();
      if (!s) return fail(res, 400, 'The published story was deleted, so new chapters can\'t be added to it.');
    }

    const { data: last } = await supabase.from('chapters').select('id, chapter_number').eq('story_id', storyId)
      .order('chapter_number', { ascending: false }).limit(1).maybeSingle();
    const { data: published, error: chErr } = await supabase.from('chapters').insert({
      story_id: storyId, chapter_number: (last?.chapter_number || 0) + 1, chapter_title: ch.title, chapter_content: ch.content,
      author_id: userId, prev_chapter_id: last?.id || null, updated_at: now(),
    }).select().single();
    if (chErr) throw chErr;
    if (last?.id) await supabase.from('chapters').update({ next_chapter_id: published.id }).eq('id', last.id);

    if (createdStory) {
      const charged = await chargeCredits(req, NEW_TITLE_PRICE_USD, `New Story: ${createdStory.title}`).catch(() => false);
      if (!charged) {
        await supabase.from('chapters').delete().eq('id', published.id);
        await supabase.from('stories').delete().eq('id', createdStory.id);
        return fail(res, 402, `Publishing a new story costs $${NEW_TITLE_PRICE_USD.toFixed(2)} in credits. Nothing was published.`, { code: 'needs_wallet_credits' });
      }
    }

    await supabase.from('story_project_chapters').update({ status: 'published', chapter_id: published.id, updated_at: now() }).eq('id', ch.id);
    const { data: updated } = await supabase.from('story_projects').update({ story_id: storyId, updated_at: now() }).eq('id', project.id).select().single();
    if (createdStory) logGeneration({ userId, feature: 'text', tier: 'publish', success: true, costTokens: creditsToLogUnits(NEW_TITLE_PRICE_USD), inputPrompt: 'story:publish-new-title' });
    res.json({ success: true, data: await projectView(updated), story_id: storyId, item_type: 'stories', chapter_public_id: published.id });
  } catch (err) {
    console.error('[story] publish failed:', err.message);
    if (createdStory) await supabase.from('stories').delete().eq('id', createdStory.id).then(() => {}, () => {});
    fail(res, 500, 'Could not publish this chapter. Nothing was charged.');
  }
});

// A book: the first page creates the book (same $1 as any new title), every
// chapter becomes a page with its heading, text and picture.
async function publishAsBookPage(req, res, project, chapters, ch) {
  const userId = req.user.id;
  let bookId = project.book_id;
  let createdBook = null;
  try {
    if (!bookId) {
      if (!(await hasCredits(userId, NEW_TITLE_PRICE_USD))) {
        return fail(res, 402, `Publishing a new book costs $${NEW_TITLE_PRICE_USD.toFixed(2)} in credits (like any new title). Later pages are free.`, { code: 'needs_wallet_credits' });
      }
      const plan = project.plan || {};
      const { data: book, error } = await supabase.from('books_library').insert({
        author_id: userId, universal_item_type: 'books_library', is_published: true,
        title: String(req.body?.story_title || plan.title || project.title || 'Untitled book').slice(0, 160),
        genre: String(req.body?.category || plan.genre || project.genre || '').slice(0, 80) || null,
        description: String(req.body?.synopsis || plan.synopsis || plan.logline || '').slice(0, 4000) || null,
        cover_image_url: req.body?.cover_image_url && /^https:\/\//.test(req.body.cover_image_url) ? req.body.cover_image_url : (chapters.find((c) => c.image_url)?.image_url || null),
      }).select().single();
      if (error) throw error;
      createdBook = book;
      bookId = book.id;
    } else {
      const { data: b } = await supabase.from('books_library').select('id').eq('id', bookId).eq('author_id', userId).maybeSingle();
      if (!b) return fail(res, 400, 'The published book was deleted, so new pages can\'t be added to it.');
    }
    const { data: last } = await supabase.from('book_pages').select('page_number').eq('book_id', bookId)
      .order('page_number', { ascending: false }).limit(1).maybeSingle();
    const { data: page, error: pErr } = await supabase.from('book_pages').insert({
      book_id: bookId, author_id: userId, page_number: (last?.page_number || 0) + 1,
      heading: ch.title, content: ch.content, image_url: ch.image_url || null,
    }).select().single();
    if (pErr) throw pErr;

    if (createdBook) {
      const charged = await chargeCredits(req, NEW_TITLE_PRICE_USD, `New Book: ${createdBook.title}`).catch(() => false);
      if (!charged) {
        await supabase.from('books_library').delete().eq('id', createdBook.id);
        return fail(res, 402, `Publishing a new book costs $${NEW_TITLE_PRICE_USD.toFixed(2)} in credits. Nothing was published.`, { code: 'needs_wallet_credits' });
      }
    }
    await supabase.from('story_project_chapters').update({ status: 'published', book_page_id: page.id, updated_at: now() }).eq('id', ch.id);
    const { data: updated } = await supabase.from('story_projects').update({ book_id: bookId, updated_at: now() }).eq('id', project.id).select().single();
    res.json({ success: true, data: await projectView(updated), book_id: bookId, item_type: 'books_library' });
  } catch (err) {
    console.error('[story] publish book page failed:', err.message);
    if (createdBook) await supabase.from('books_library').delete().eq('id', createdBook.id).then(() => {}, () => {});
    fail(res, 500, 'Could not publish this page. Nothing was charged.');
  }
}

export default router;
