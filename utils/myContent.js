// "My content": everything a user wrote that can become a video script, from every
// place it lives. Used by the Video Studio (Model 1: one of my stories) and the Auto
// Episode Engine (Model 2: use my content as the script).
//   studio   Story Studio / Book Studio projects   story_projects + story_project_chapters
//   story    posted stories                        stories + chapters (+ chapter_content)
//   book     posted books                          books_library + book_pages
//   podcast  posted podcasts with a transcript     podcast_box.transcript
import { supabase } from '../config/db.js';
import { searchText, ilikeAny } from './searchText.js';

export const CONTENT_KINDS = { studio: 'Studio project', story: 'Story', book: 'Book', podcast: 'Podcast' };
const MAX_TEXT = 40000;

/** Newest first, optionally searched by title (any words of `q`). */
export async function listMyContent(userId, q = '') {
  const text = searchText(q);
  const lim = text ? 25 : 15;
  const like = (query, cols) => (text ? query.or(ilikeAny(text, cols)) : query);
  const [studio, stories, books, pods] = await Promise.all([
    like(supabase.from('story_projects').select('id, title, plan, kind, updated_at').eq('user_id', userId), ['title', 'plan->>title']).order('updated_at', { ascending: false }).limit(lim),
    like(supabase.from('stories').select('id, title, story_synopsis, created_at, is_published').eq('author_id', userId), ['title', 'story_synopsis']).order('created_at', { ascending: false }).limit(lim),
    like(supabase.from('books_library').select('id, title, description, page_count, updated_at').eq('author_id', userId), ['title', 'description']).order('updated_at', { ascending: false }).limit(lim),
    like(supabase.from('podcast_box').select('id, title, description, transcript, updated_at').eq('author_id', userId).not('transcript', 'is', null), ['title', 'description']).order('updated_at', { ascending: false }).limit(lim),
  ]);
  const items = [
    ...(studio.data || []).map((x) => ({ kind: 'studio', id: x.id, title: x.plan?.title || x.title || 'Untitled', sub: x.kind === 'book' ? 'Book Studio project' : 'Story Studio project', at: x.updated_at })),
    ...(stories.data || []).map((x) => ({ kind: 'story', id: x.id, title: x.title || 'Untitled story', sub: x.is_published === false ? 'Story (draft)' : 'Posted story', at: x.created_at })),
    ...(books.data || []).map((x) => ({ kind: 'book', id: x.id, title: x.title || 'Untitled book', sub: `Book${x.page_count ? ` · ${x.page_count} pages` : ''}`, at: x.updated_at })),
    ...(pods.data || []).map((x) => ({ kind: 'podcast', id: x.id, title: x.title || 'Podcast', sub: 'Podcast transcript', at: x.updated_at })),
  ];
  return items.sort((a, b) => String(b.at || '').localeCompare(String(a.at || ''))).slice(0, 40);
}

/**
 * The text of one item, split into parts (chapters / pages). part = 1-based part number, or
 * null for everything. Returns { title, parts: [{ n, title }], text } or null if not the user's.
 */
export async function contentText(userId, kind, id, part = null) {
  let title = '';
  let parts = []; // [{ n, title, text }]
  if (kind === 'studio') {
    const { data: p } = await supabase.from('story_projects').select('*').eq('id', id).eq('user_id', userId).maybeSingle();
    if (!p) return null;
    title = p.plan?.title || p.title || 'Untitled';
    const { data: ch } = await supabase.from('story_project_chapters').select('number, title, content').eq('project_id', p.id).order('number');
    parts = (ch || []).filter((c) => c.content).map((c) => ({ n: c.number, title: c.title || `Chapter ${c.number}`, text: c.content }));
    if (!parts.length && p.source_text) parts = [{ n: 1, title: 'Source', text: p.source_text }];
    if (!parts.length && p.plan) parts = [{ n: 1, title: 'Plan', text: [p.plan.logline, p.plan.setting, ...(p.plan.chapters || []).map((c) => `${c.title}: ${c.summary || ''}`)].filter(Boolean).join('\n') }];
  } else if (kind === 'story') {
    const { data: s } = await supabase.from('stories').select('id, title, story_synopsis, description').eq('id', id).eq('author_id', userId).maybeSingle();
    if (!s) return null;
    title = s.title || 'Untitled story';
    const { data: ch } = await supabase.from('chapters').select('id, chapter_number, chapter_title, chapter_content').eq('story_id', s.id).order('chapter_number');
    const missing = (ch || []).filter((c) => !c.chapter_content).map((c) => c.id);
    const { data: extra } = missing.length ? await supabase.from('chapter_content').select('chapter_id, content').in('chapter_id', missing) : { data: [] };
    parts = (ch || []).map((c) => ({ n: c.chapter_number, title: c.chapter_title || `Chapter ${c.chapter_number}`, text: c.chapter_content || (extra || []).find((e) => e.chapter_id === c.id)?.content || '' })).filter((c) => c.text);
    if (!parts.length) parts = [{ n: 1, title: 'Synopsis', text: [s.story_synopsis, s.description].filter(Boolean).join('\n\n') }];
  } else if (kind === 'book') {
    const { data: b } = await supabase.from('books_library').select('id, title, description').eq('id', id).eq('author_id', userId).maybeSingle();
    if (!b) return null;
    title = b.title || 'Untitled book';
    const { data: pages } = await supabase.from('book_pages').select('page_number, heading, content').eq('book_id', b.id).order('page_number');
    parts = (pages || []).filter((x) => x.content).map((x) => ({ n: x.page_number, title: x.heading || `Page ${x.page_number}`, text: [x.heading, x.content].filter(Boolean).join('\n') }));
    if (!parts.length && b.description) parts = [{ n: 1, title: 'Description', text: b.description }];
  } else if (kind === 'podcast') {
    const { data: p } = await supabase.from('podcast_box').select('id, title, transcript').eq('id', id).eq('author_id', userId).maybeSingle();
    if (!p) return null;
    title = p.title || 'Podcast';
    parts = p.transcript ? [{ n: 1, title: 'Transcript', text: p.transcript }] : [];
  } else return null;
  const chosen = part ? parts.filter((x) => x.n === Number(part)) : parts;
  const text = chosen.map((x) => (parts.length > 1 ? `${x.title}\n${x.text}` : x.text)).join('\n\n').slice(0, MAX_TEXT);
  return { title, parts: parts.map(({ n, title: t, text: body }) => ({ n, title: t, chars: body.length })), text };
}
