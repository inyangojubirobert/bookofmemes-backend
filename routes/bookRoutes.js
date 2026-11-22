// Bascardo Book Studio API (config/bookEngine.js; migration 075).
// A book is a story project with kind = 'book'; its pages are the project's
// chapters, so editing and the Gallery work as for stories.
//
//   1. Idea      POST /projects              idea + format + reader → 3 concepts      (bookConcepts)
//   2. Pick      POST /projects/:id/choose   pick a concept (page plan + look); free
//                PATCH /projects/:id         edit the look / page plan / cover; free
//   3. Pages     POST /projects/:id/pages    write the next 1-4 pages                 (bookPagesShort / bookPagesLong)
//                PATCH /projects/:id/pages/:pid  edit a page, set its picture; free
//                pictures: the app calls /api/ai/runware/image with each page's picture_prompt (image credits)
//   4. Publish   POST /projects/:id/publish  every unpublished page, in order; a new book costs the usual $1
import express from 'express';
import { supabase } from '../config/db.js';
import { authenticateToken } from '../auth.js';
import { creditStatus } from '../utils/aiCredits.js';
import { creditsFor } from '../config/aiPlans.js';
import { runChargedStep } from '../utils/studioSteps.js';
import { newTitlePayment, payNewTitle, newTitleFeeText, NEW_TITLE_FEE_VIEW } from '../utils/titleFee.js';
import { proposeBooks, writePages, picturePrompt, formatSpec, BOOK_FORMATS, READING_LEVELS, LIMITS, BOOK_MODEL, PROMPT_VERSION, BookError } from '../config/bookEngine.js';

const router = express.Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EDIT_DAYS = 30;
const fail = (res, status, error, extra = {}) => res.status(status).json({ success: false, error, ...extra });
const now = () => new Date().toISOString();
const HTTPS = /^https:\/\/[^\s]+$/;

async function loadBook(userId, id) {
  if (!UUID.test(String(id))) return null;
  const { data } = await supabase.from('story_projects').select('*').eq('id', id).eq('user_id', userId).eq('kind', 'book').maybeSingle();
  return data;
}
async function loadPages(projectId) {
  const { data } = await supabase.from('story_project_chapters').select('*').eq('project_id', projectId).order('number');
  return data || [];
}
async function bookView(project, pages = null) {
  const list = pages || await loadPages(project.id);
  const f = formatSpec(project.book_format, project.target_chapters);
  return {
    ...project,
    format: { key: f.key, label: f.label, words: f.words, pages: f.pageCount, short: f.short },
    cover_prompt: project.plan?.title ? picturePrompt(project, `Book cover for "${project.plan.title}": ${project.plan.summary || ''}`) : null,
    pages: list.map((p) => ({
      id: p.id, number: p.number, heading: p.title, text: p.content, summary: p.summary, status: p.status,
      image_url: p.image_url, picture: p.illustration_prompt,
      picture_prompt: p.illustration_prompt ? picturePrompt(project, p.illustration_prompt) : null,
      words: (p.content.match(/\S+/g) || []).length, book_page_id: p.book_page_id,
    })),
  };
}

function runCharged(req, res, { kind, action, projectId = null }, work) {
  return runChargedStep(req, res, {
    ledger: 'story_ai_requests', kind: `book_${kind}`, action, projectId, subject: 'this book',
    log: { feature: 'text', model: BOOK_MODEL, provider: 'anthropic', prompt: `book:${kind} ${PROMPT_VERSION}` },
    isKnownError: (err) => err instanceof BookError,
  }, async () => {
    const r = await work();
    const u = r.usage || { input: 0, output: 0 };
    return { data: r.data, projectId: r.data?.project?.id || projectId, providerCost: Number((u.input / 1e6 + u.output * 5 / 1e6).toFixed(6)) };
  });
}

router.get('/config', authenticateToken, async (req, res) => {
  try {
    const status = await creditStatus(req.user.id);
    const premium = status.plan.premiumModels;
    res.json({ success: true, data: {
      formats: Object.entries(BOOK_FORMATS).map(([key, f]) => ({ key, label: f.label, note: f.note, words: f.words, min_pages: f.pages[0], max_pages: f.pages[1], default_pages: f.pages[2], short: f.short })),
      levels: Object.entries(READING_LEVELS).map(([key, label]) => ({ key, label })),
      pages_per_batch: LIMITS.pagesPerBatch,
      costs: { concepts: creditsFor('bookConcepts', { premium }), pages_short: creditsFor('bookPagesShort', { premium }), pages_long: creditsFor('bookPagesLong', { premium }), picture: creditsFor('image', { premium }) },
      credits: { remaining: status.remaining, limit: status.limit, topup: status.topup || 0, plan: status.plan.name },
      ...NEW_TITLE_FEE_VIEW,
    } });
  } catch (err) { console.error('[book] config:', err.message); fail(res, 500, 'Could not load Book Studio'); }
});

router.get('/projects', authenticateToken, async (req, res) => {
  const { data, error } = await supabase.from('story_projects').select('id, title, stage, plan, book_id, book_format, updated_at, cover_url')
    .eq('user_id', req.user.id).eq('kind', 'book').order('updated_at', { ascending: false }).limit(50);
  if (error) return fail(res, 500, 'Could not load your books');
  const ids = (data || []).map((p) => p.id);
  const counts = {};
  if (ids.length) {
    const { data: ch } = await supabase.from('story_project_chapters').select('project_id, status').in('project_id', ids);
    for (const c of ch || []) { counts[c.project_id] ||= { pages: 0, published: 0 }; counts[c.project_id].pages++; if (c.status === 'published') counts[c.project_id].published++; }
  }
  res.json({ success: true, data: (data || []).map((p) => ({ id: p.id, title: p.plan?.title || p.title || 'Untitled book', stage: p.stage, format: p.book_format, cover_url: p.cover_url, book_id: p.book_id, updated_at: p.updated_at, ...(counts[p.id] || { pages: 0, published: 0 }) })) });
});

router.get('/projects/:id', authenticateToken, async (req, res) => {
  const p = await loadBook(req.user.id, req.params.id);
  if (!p) return fail(res, 404, 'Book not found');
  res.json({ success: true, data: await bookView(p) });
});

router.delete('/projects/:id', authenticateToken, async (req, res) => {
  const p = await loadBook(req.user.id, req.params.id);
  if (!p) return fail(res, 404, 'Book not found');
  await supabase.from('story_projects').delete().eq('id', p.id); // a published book stays on Book of Memes
  res.json({ success: true });
});

// ── 1. Idea → 3 concepts ────────────────────────────────────────────────────
router.post('/projects', authenticateToken, (req, res) => {
  const idea = String(req.body?.idea || '').trim();
  if (idea.length < 10) return fail(res, 400, 'Tell Bascardo a little about your book (a sentence is enough).');
  if (idea.length > LIMITS.ideaChars) return fail(res, 400, `Keep the idea under ${LIMITS.ideaChars.toLocaleString()} characters.`);
  const format = BOOK_FORMATS[req.body?.format] ? req.body.format : 'picture_book';
  const level = READING_LEVELS[req.body?.level] ? req.body.level : '6-8';
  const f = formatSpec(format, req.body?.pages);
  const notes = String(req.body?.notes || '').trim().slice(0, 1200) || null;
  return runCharged(req, res, { kind: 'concepts', action: 'bookConcepts' }, async () => {
    const r = await proposeBooks({ idea, format, level, pages: f.pageCount, notes });
    const { data: project, error } = await supabase.from('story_projects').insert({
      user_id: req.user.id, kind: 'book', title: r.concepts[0]?.title || null, source_text: idea, notes,
      book_format: format, reading_level: level, target_chapters: f.pageCount, stage: 'choose',
      directions: r.concepts, plan: {}, memory: { summaries: [] }, publish_as: 'books_library',
    }).select().single();
    if (error) throw error;
    return { data: { project: await bookView(project, []) }, usage: r.usage };
  });
});

// ── 2. Pick a concept (free) ────────────────────────────────────────────────
router.post('/projects/:id/choose', authenticateToken, async (req, res) => {
  const p = await loadBook(req.user.id, req.params.id);
  if (!p) return fail(res, 404, 'Book not found');
  const c = p.directions?.[Number(req.body?.index)];
  if (!c) return fail(res, 400, 'Pick one of the three books');
  const tweak = String(req.body?.tweak || '').trim().slice(0, 1200);
  const { data, error } = await supabase.from('story_projects').update({
    title: c.title, plan: { title: c.title, summary: c.summary, logline: c.why },
    chosen_direction: { name: c.title, summary: c.summary, roadmap: c.page_plan, author_tweak: tweak || undefined },
    roadmap: c.page_plan, visual_identity: c.visual_identity,
    notes: [p.notes, tweak].filter(Boolean).join('\n') || null, stage: 'writing', updated_at: now(),
  }).eq('id', p.id).select().single();
  if (error) return fail(res, 500, 'Could not save your choice');
  res.json({ success: true, data: await bookView(data) });
});

// Edit the look, the page plan, the title or the cover (free).
router.patch('/projects/:id', authenticateToken, async (req, res) => {
  const p = await loadBook(req.user.id, req.params.id);
  if (!p) return fail(res, 404, 'Book not found');
  const up = { updated_at: now() };
  const b = req.body || {};
  if (b.visual_identity && typeof b.visual_identity === 'object') {
    const v = b.visual_identity;
    up.visual_identity = {
      art_style: String(v.art_style ?? p.visual_identity?.art_style ?? '').slice(0, 300),
      palette: String(v.palette ?? p.visual_identity?.palette ?? '').slice(0, 200),
      setting: String(v.setting ?? p.visual_identity?.setting ?? '').slice(0, 300),
      characters: (Array.isArray(v.characters) ? v.characters : p.visual_identity?.characters || []).slice(0, 6)
        .map((c) => ({ name: String(c?.name || '').slice(0, 60), look: String(c?.look || '').slice(0, 300) })).filter((c) => c.name),
    };
  }
  if (Array.isArray(b.page_plan)) {
    const plan = b.page_plan.slice(0, 40).map((x, i) => ({ number: i + 1, heading: String(x?.heading || '').slice(0, 100), purpose: String(x?.purpose || '').slice(0, 300) })).filter((x) => x.heading);
    up.roadmap = plan;
    up.chosen_direction = { ...(p.chosen_direction || {}), roadmap: plan };
  }
  if (typeof b.title === 'string' && b.title.trim()) { up.title = b.title.trim().slice(0, 160); up.plan = { ...(p.plan || {}), title: up.title }; }
  if (b.cover_url !== undefined) {
    if (b.cover_url && !HTTPS.test(String(b.cover_url))) return fail(res, 400, 'Invalid picture link');
    up.cover_url = b.cover_url || null;
  }
  const { data, error } = await supabase.from('story_projects').update(up).eq('id', p.id).select().single();
  if (error) return fail(res, 500, 'Could not save');
  res.json({ success: true, data: await bookView(data) });
});

// ── 3. Write the next pages ─────────────────────────────────────────────────
router.post('/projects/:id/pages', authenticateToken, async (req, res) => {
  const p = await loadBook(req.user.id, req.params.id);
  if (!p) return fail(res, 404, 'Book not found');
  if (p.stage !== 'writing') return fail(res, 400, 'Pick one of the three books first');
  const pages = await loadPages(p.id);
  const f = formatSpec(p.book_format, p.target_chapters);
  const next = (pages[pages.length - 1]?.number || 0) + 1;
  const count = Math.min(Math.max(parseInt(req.body?.count, 10) || LIMITS.pagesPerBatch, 1), LIMITS.pagesPerBatch);
  if (next > Math.max(f.pageCount, 60)) return fail(res, 400, 'This book has all its pages. Edit them, or add more pages to the plan first.');
  const numbers = Array.from({ length: count }, (_, i) => next + i);
  const wish = String(req.body?.wish || '').trim().slice(0, 600);
  return runCharged(req, res, { kind: 'pages', action: f.short ? 'bookPagesShort' : 'bookPagesLong', projectId: p.id }, async () => {
    const r = await writePages({ project: p, numbers, wish });
    const rows = r.pages.map((pg) => ({ project_id: p.id, number: pg.number, title: pg.heading, content: pg.text, summary: pg.summary, illustration_prompt: pg.picture, direction_used: wish || null }));
    const { error } = await supabase.from('story_project_chapters').insert(rows);
    if (error) throw error;
    const summaries = [...(p.memory?.summaries || []).filter((s) => !numbers.includes(s.number)), ...r.pages.map((pg) => ({ number: pg.number, title: pg.heading, summary: pg.summary }))];
    const { data: updated } = await supabase.from('story_projects').update({ memory: { ...(p.memory || {}), summaries, last_page_text: r.pages[r.pages.length - 1].text.slice(-1500) }, updated_at: now() }).eq('id', p.id).select().single();
    return { data: { project: await bookView(updated), written: numbers }, usage: r.usage };
  });
});

// Edit a page or set its picture (drafts any time; published pages for 30 days).
router.patch('/projects/:id/pages/:pid', authenticateToken, async (req, res) => {
  const p = await loadBook(req.user.id, req.params.id);
  if (!p || !UUID.test(req.params.pid)) return fail(res, 404, 'Page not found');
  const { data: pg } = await supabase.from('story_project_chapters').select('*').eq('id', req.params.pid).eq('project_id', p.id).maybeSingle();
  if (!pg) return fail(res, 404, 'Page not found');
  const b = req.body || {};
  const heading = String(b.heading ?? pg.title).trim().slice(0, 120) || pg.title;
  const text = String(b.text ?? pg.content).trim();
  const picture = b.picture !== undefined ? String(b.picture || '').slice(0, 800) : pg.illustration_prompt;
  let imageUrl = pg.image_url;
  if (b.image_url !== undefined) {
    if (b.image_url && !HTTPS.test(String(b.image_url))) return fail(res, 400, 'Invalid picture link');
    imageUrl = b.image_url || null;
  }
  if (!text) return fail(res, 400, 'A page needs some text');
  if (text.length > 20000) return fail(res, 400, 'That page is too long');
  if (pg.status === 'published' && pg.book_page_id) {
    const { data: live } = await supabase.from('book_pages').select('created_at').eq('id', pg.book_page_id).maybeSingle();
    if (live && Date.now() - new Date(live.created_at).getTime() > EDIT_DAYS * 86400000) return fail(res, 403, `This page was published more than ${EDIT_DAYS} days ago, so it can no longer be edited.`);
    const { error } = await supabase.from('book_pages').update({ heading, content: text, image_url: imageUrl, updated_at: now() }).eq('id', pg.book_page_id).eq('author_id', req.user.id);
    if (error) return fail(res, 403, /marketplace/.test(error.message) ? error.message : 'Could not save the published page');
  }
  const { error } = await supabase.from('story_project_chapters').update({ title: heading, content: text, image_url: imageUrl, illustration_prompt: picture, updated_at: now() }).eq('id', pg.id);
  if (error) return fail(res, 500, 'Could not save');
  res.json({ success: true, data: await bookView(p) });
});

// Delete the newest draft page (numbering stays continuous).
router.delete('/projects/:id/pages/:pid', authenticateToken, async (req, res) => {
  const p = await loadBook(req.user.id, req.params.id);
  if (!p) return fail(res, 404, 'Book not found');
  const pages = await loadPages(p.id);
  const pg = pages.find((x) => x.id === req.params.pid);
  if (!pg) return fail(res, 404, 'Page not found');
  if (pg.status !== 'draft') return fail(res, 400, 'Published pages can\'t be deleted here');
  if (pg.number !== pages[pages.length - 1].number) return fail(res, 400, 'Only the last page can be deleted');
  await supabase.from('story_project_chapters').delete().eq('id', pg.id);
  const memory = { ...(p.memory || {}), summaries: (p.memory?.summaries || []).filter((s) => s.number !== pg.number) };
  await supabase.from('story_projects').update({ memory, updated_at: now() }).eq('id', p.id);
  res.json({ success: true, data: await bookView({ ...p, memory }) });
});

// ── 4. Publish every unpublished page, in order ─────────────────────────────
router.post('/projects/:id/publish', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const p = await loadBook(userId, req.params.id);
  if (!p) return fail(res, 404, 'Book not found');
  const pages = (await loadPages(p.id)).filter((x) => x.status === 'draft');
  if (!pages.length) return fail(res, 400, 'Every page is already published');
  let bookId = p.book_id;
  let created = null;
  let paidWith = null;
  try {
    if (!bookId) {
      if (!(await newTitlePayment(userId))) {
        return fail(res, 402, `Publishing a new book costs ${newTitleFeeText()} (like any new title). Adding pages later is free.`, { code: 'needs_wallet_credits' });
      }
      const { data: book, error } = await supabase.from('books_library').insert({
        author_id: userId, universal_item_type: 'books_library', is_published: true,
        title: String(req.body?.title || p.plan?.title || p.title || 'Untitled book').slice(0, 160),
        genre: BOOK_FORMATS[p.book_format]?.label || null,
        description: String(req.body?.description || p.plan?.summary || '').slice(0, 4000) || null,
        author_name: req.body?.author_name ? String(req.body.author_name).slice(0, 80) : null,
        cover_image_url: p.cover_url || pages.find((x) => x.image_url)?.image_url || null,
      }).select().single();
      if (error) throw error;
      created = book; bookId = book.id;
    }
    const { data: last } = await supabase.from('book_pages').select('page_number').eq('book_id', bookId).order('page_number', { ascending: false }).limit(1).maybeSingle();
    let n = last?.page_number || 0;
    const rows = pages.map((pg) => ({ book_id: bookId, author_id: userId, page_number: ++n, heading: pg.title, content: pg.content, image_url: pg.image_url || null }));
    const { data: inserted, error: pErr } = await supabase.from('book_pages').insert(rows).select('id, page_number');
    if (pErr) throw pErr;
    if (created) {
      paidWith = await payNewTitle(req, userId, `New Book: ${created.title}`).catch(() => null);
      if (!paidWith) {
        await supabase.from('books_library').delete().eq('id', created.id);
        return fail(res, 402, `Publishing a new book costs ${newTitleFeeText()}. Nothing was published.`, { code: 'needs_wallet_credits' });
      }
    }
    const byNumber = Object.fromEntries((inserted || []).map((r) => [r.page_number, r.id]));
    let k = last?.page_number || 0;
    for (const pg of pages) {
      await supabase.from('story_project_chapters').update({ status: 'published', book_page_id: byNumber[++k] || null, updated_at: now() }).eq('id', pg.id);
    }
    const { data: updated } = await supabase.from('story_projects').update({ book_id: bookId, updated_at: now() }).eq('id', p.id).select().single();
    res.json({ success: true, data: await bookView(updated), book_id: bookId, published: pages.length, paid_with: paidWith });
  } catch (err) {
    console.error('[book] publish failed:', err.message);
    if (created) await supabase.from('books_library').delete().eq('id', created.id).then(() => {}, () => {});
    fail(res, 500, 'Could not publish the book. Nothing was charged.');
  }
});

export default router;
