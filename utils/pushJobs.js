// Background jobs that keep users in the know when they're not in the app.
//   1. Every notification row (bids, outbids, games, comments, deposits, recommendations…)
//      is pushed to the user's phones within ~15 s: a pop-up over other apps with sound.
//   2. A new post: the people who engaged with its author get "New from <author>".
//   3. Once a day, early evening local time: one "you might be interested" pick.
// Limits: at most RECS_PER_DAY recommendation pop-ups a day per user, none in quiet hours
// (22:00-07:00 by default), and nothing for users who switched them off. Activity alerts
// (a bid, an outbid, a game result) are not limited: they're about the user's own things.
import { supabase } from '../config/db.js';
import { pushConfigured, sendToUser } from './push.js';
import { nextRecommendation, logShown, authorNames, inQuietHours, localHour, TYPE_LABEL } from './recommendations.js';

const RECS_PER_DAY = 2;
const DIGEST_HOURS = [17, 18, 19, 20]; // local time
let missing = false;
let lastContentCheck = new Date(Date.now() - 10 * 60000).toISOString();
const timers = [];
const busy = { push: false, fanout: false, digest: false };
const settingsOf = async (ids) => {
  const { data } = await supabase.from('notification_settings').select('*').in('user_id', ids);
  return Object.fromEntries((data || []).map((s) => [s.user_id, s]));
};
const recsToday = async (userId) => {
  const { count } = await supabase.from('notifications').select('id', { count: 'exact', head: true })
    .eq('user_id', userId).eq('type', 'recommendation').gt('created_at', new Date(Date.now() - 24 * 3600000).toISOString());
  return count || 0;
};

// 1. Push every new notification.
async function pushPending() {
  if (busy.push || missing) return;
  busy.push = true;
  try {
    const { data: rows, error } = await supabase.from('notifications').select('*').is('pushed_at', null)
      .gt('created_at', new Date(Date.now() - 2 * 3600000).toISOString()).order('created_at').limit(50);
    if (error) { if (/pushed_at|column/i.test(error.message)) { missing = true; console.warn('[push] migration 087 not run: push is off'); } return; }
    if (!rows?.length) return;
    const settings = await settingsOf([...new Set(rows.map((r) => r.user_id))]);
    for (const n of rows) {
      const s = settings[n.user_id];
      let status;
      if (s && s.push_enabled === false) status = 'off';
      else if (n.type === 'recommendation' && (s?.recommendations_enabled === false || inQuietHours(s))) status = 'held';
      else if (!pushConfigured()) status = 'not_configured';
      else {
        const r = await sendToUser(n.user_id, {
          title: n.title, body: n.body, image: n.data?.cover_url || null,
          data: { notification_id: n.id, type: n.type, reference_id: n.reference_id || '', item_type: n.data?.item_type || '', item_id: n.data?.item_id || '' },
        });
        status = r.devices ? (r.sent ? 'sent' : 'failed') : 'no_device';
      }
      await supabase.from('notifications').update({ pushed_at: new Date().toISOString(), push_status: status }).eq('id', n.id);
    }
  } catch (err) { console.error('[push] pending:', err.message); } finally { busy.push = false; }
}

async function recommendTo(userId, rec, title, settings) {
  if (settings?.recommendations_enabled === false || settings?.push_enabled === false) return false;
  if (await recsToday(userId) >= RECS_PER_DAY) return false;
  const f = rec.featured;
  const { error } = await supabase.from('notifications').insert({
    user_id: userId, type: 'recommendation', title, body: `${f.title}${f.synopsis ? ` — ${f.synopsis.slice(0, 120)}` : ''}`,
    reference_id: f.item_id, data: { item_type: f.item_type, item_id: f.item_id, author_id: rec.author.id, cover_url: f.cover_url || null },
  });
  if (error) return false;
  await logShown(userId, rec, 'push', [f]);
  return true;
}

// 2. New posts → the author's fans.
async function fanOutNewContent() {
  if (busy.fanout || missing) return;
  busy.fanout = true;
  const since = lastContentCheck;
  lastContentCheck = new Date().toISOString();
  try {
    const { data: posts, error } = await supabase.from('content_authors').select('*').eq('published', true).gt('created_at', since).order('created_at').limit(20);
    if (error || !posts?.length) return;
    const names = await authorNames([...new Set(posts.map((p) => p.author_id).filter(Boolean))]);
    for (const post of posts) {
      if (!post.author_id) continue;
      const { data: fans } = await supabase.rpc('author_fans', { p_author: post.author_id, p_min_score: 2, p_limit: 500 });
      if (!fans?.length) continue;
      const settings = await settingsOf(fans.map((f) => f.user_id));
      const author = names[post.author_id] || { name: 'An author' };
      const rec = {
        author: { id: post.author_id, ...author }, reason: `You have engaged with ${author.name}'s content in time past.`,
        featured: { item_type: post.item_type, item_id: post.item_id, title: post.title || 'Untitled', cover_url: post.cover_url, synopsis: post.synopsis || '' }, more: [],
      };
      for (const fan of fans) {
        await recommendTo(fan.user_id, rec, `New ${(TYPE_LABEL[post.item_type]?.[0] || 'post').toLowerCase()} from ${author.name}`, settings[fan.user_id]).catch(() => false);
      }
    }
  } catch (err) { console.error('[push] fan-out:', err.message); } finally { busy.fanout = false; }
}

// 3. Daily pick, early evening local time, for people with a phone registered.
async function dailyDigest() {
  if (busy.digest || missing) return;
  busy.digest = true;
  try {
    const { data: devices } = await supabase.from('push_devices').select('user_id').eq('enabled', true).limit(2000);
    const users = [...new Set((devices || []).map((d) => d.user_id))];
    if (!users.length) return;
    const settings = await settingsOf(users);
    for (const userId of users) {
      const s = settings[userId];
      if (!DIGEST_HOURS.includes(Math.floor(localHour(s?.tz_offset_minutes ?? 60)))) continue;
      const { count } = await supabase.from('notifications').select('id', { count: 'exact', head: true })
        .eq('user_id', userId).eq('type', 'recommendation').gt('created_at', new Date(Date.now() - 20 * 3600000).toISOString());
      if (count) continue;
      const rec = await nextRecommendation(userId);
      if (rec) await recommendTo(userId, rec, `${rec.heading.split(' you might')[0]} you might like · ${rec.author.name}`, s).catch(() => false);
    }
  } catch (err) { console.error('[push] digest:', err.message); } finally { busy.digest = false; }
}

export function startPushJobs() {
  if (timers.length) return;
  timers.push(setInterval(pushPending, 15000), setInterval(fanOutNewContent, 5 * 60000), setInterval(dailyDigest, 30 * 60000));
  // Re-check every 10 minutes whether 087 has been run, so it switches on without a restart.
  timers.push(setInterval(() => { missing = false; }, 10 * 60000));
  if (!pushConfigured()) console.warn('[push] FIREBASE_SERVICE_ACCOUNT not set: notifications stay in the in-app inbox only');
}
