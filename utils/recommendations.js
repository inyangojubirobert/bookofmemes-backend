// Recommendations: posts by authors a user has engaged with (viewed, read, liked, bookmarked,
// shared, commented or replied on, bid on, messaged, followed), shown as an in-app card
// and as pop-up notifications (utils/pushJobs.js). Scoring and choice live in SQL (087):
// author_affinity(), author_fans(), recommend_items().
import { supabase } from '../config/db.js';

export const TYPE_LABEL = {
  stories: ['Story', 'Stories'], books_library: ['Book', 'Books'], podcast_box: ['Podcast', 'Podcasts'], music_box: ['Song', 'Music'],
  tv_box: ['Video', 'Videos'], memes: ['Meme', 'Memes'], kids_collections: ['Kids story', 'Kids stories'], puzzles: ['Puzzle', 'Puzzles'],
};
const plural = (types) => {
  const u = [...new Set(types)];
  if (u.length === 1) return TYPE_LABEL[u[0]]?.[1] || 'Posts';
  if (u.length === 2) return `${TYPE_LABEL[u[0]]?.[1] || 'Posts'} and ${(TYPE_LABEL[u[1]]?.[1] || 'posts').toLowerCase()}`;
  return 'Stories, books and more';
};

export async function authorNames(ids) {
  if (!ids.length) return {};
  const { data } = await supabase.from('profiles').select('id, full_name, username, avatar_url').in('id', ids);
  return Object.fromEntries((data || []).map((p) => [p.id, { name: p.full_name || p.username || 'An author', username: p.username, avatar_url: p.avatar_url }]));
}

/**
 * The next recommendation for a user: one author, a featured post and up to 3 more of theirs.
 * Returns null when there is nothing new from authors they engaged with.
 */
export async function nextRecommendation(userId) {
  const { data: rows, error } = await supabase.rpc('recommend_items', { p_user: userId, p_limit: 12, p_min_score: 2 });
  if (error) { if (!/recommend_items|PGRST202/.test(error.message)) console.warn('[recs]', error.message); return null; }
  if (!rows?.length) return null;
  const authorId = rows[0].author_id; // strongest author first
  const items = rows.filter((r) => r.author_id === authorId).slice(0, 4);
  const author = (await authorNames([authorId]))[authorId] || { name: 'An author' };
  return {
    tag: 'Recommended',
    heading: `${plural(items.map((i) => i.item_type))} you might be interested in viewing`,
    reason: `You have engaged with ${author.name}'s content in time past.`,
    author: { id: authorId, ...author },
    featured: shape(items[0]),
    more: items.slice(1).map(shape),
  };
}
const shape = (r) => ({ item_type: r.item_type, item_id: r.item_id, title: r.title || 'Untitled', cover_url: r.cover_url, synopsis: (r.synopsis || '').slice(0, 400), kind: TYPE_LABEL[r.item_type]?.[0] || 'Post', created_at: r.created_at });

export async function logShown(userId, rec, channel, items = null) {
  const list = items || [rec.featured, ...rec.more];
  const rows = list.map((i) => ({ user_id: userId, author_id: rec.author.id, item_type: i.item_type, item_id: i.item_id, channel, reason: rec.reason }));
  const { data } = await supabase.from('recommendation_log').insert(rows).select('id');
  return (data || []).map((x) => x.id);
}

/** Local hour of a user from the offset their phone reported. */
export const localHour = (offsetMinutes = 60, date = new Date()) => (((date.getUTCHours() * 60 + date.getUTCMinutes() + Number(offsetMinutes || 0)) / 60) % 24 + 24) % 24;
export const inQuietHours = (s, date = new Date()) => {
  const h = Math.floor(localHour(s?.tz_offset_minutes ?? 60, date));
  const start = s?.quiet_start ?? 22, end = s?.quiet_end ?? 7;
  return start > end ? h >= start || h < end : h >= start && h < end;
};
