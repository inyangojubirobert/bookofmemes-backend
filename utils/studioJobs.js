// Background jobs for long media work (migration 073, studio_jobs).
//
// A paid provider task (a video clip takes 30–80 s, later songs and renders)
// must not depend on the phone keeping a request open, or on this server not
// restarting. So: the route reserves the credits and creates a job; a runner in
// this process starts it, stores the provider's task id, and polls until it
// finishes. On success the handler saves the result (Gallery, project) and the
// credits are committed; on failure they're released. After a restart the
// runner picks unfinished jobs up again from the database.
//
// Same in-process timer pattern the app already uses for its sweeps; no queue
// service. Each job is claimed with a short lock, so two server instances
// would not run the same step twice.
import { supabase } from '../config/db.js';
import { commitCredits, releaseCredits } from './aiCredits.js';
import { jobScope } from './providerBalance.js';

const HANDLERS = new Map();
const TICK_MS = 4000;
const MAX_ATTEMPTS = 5;
const GIVE_UP_MS = 20 * 60000;
// Things only this process can hold (e.g. the user's session for a wallet
// charge). If the server restarts they are gone, and the handler must cope.
const ephemeral = new Map();
let tableMissing = false;
let missingSince = 0; // re-check every 5 minutes, so running migration 073 later switches jobs on without a restart

const now = () => new Date().toISOString();
const later = (ms) => new Date(Date.now() + ms).toISOString();

/**
 * handler = {
 *   start(job)  → { providerTaskId?, provider? }                 submit to the provider
 *   poll(job)   → null (not yet) | { result }                     check the provider
 *   finish(job, result, ctx) → final result object to store      save asset, project, log
 *   failed?(job, err, ctx)                                        optional clean-up / log
 *   pollEveryMs?
 * }
 */
export function registerJobKind(kind, handler) { HANDLERS.set(kind, handler); }

export const jobsAvailable = () => !tableMissing;

/** Creates (or returns the existing job for) request_id. */
export async function createJob({ userId, requestId, kind, input = {}, projectKind = null, projectId = null, reservation = null, credits = 0, memory = null }) {
  if (requestId) {
    const { data: existing } = await supabase.from('studio_jobs').select('*').eq('request_id', requestId).maybeSingle();
    if (existing) {
      if (existing.user_id !== userId) throw Object.assign(new Error('Request id already used.'), { status: 409 });
      return { job: existing, existed: true };
    }
  }
  const { data, error } = await supabase.from('studio_jobs').insert({
    user_id: userId, request_id: requestId, kind, input, project_kind: projectKind, project_id: projectId,
    reservation_id: reservation?.legacy ? null : reservation?.id || null, credits,
  }).select().single();
  if (error) throw error;
  ephemeral.set(data.id, { reservation, ...(memory || {}) });
  kick();
  return { job: data, existed: false };
}

export async function getJob(id, userId) {
  const { data } = await supabase.from('studio_jobs').select('*').eq('id', id).eq('user_id', userId).maybeSingle();
  return data;
}

/** For callers that still want to wait (older app versions): resolves with the job when it settles or the time runs out. */
export async function waitForJob(id, timeoutMs = 115000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const { data } = await supabase.from('studio_jobs').select('*').eq('id', id).single();
    if (data && ['done', 'failed', 'cancelled'].includes(data.status)) return data;
    await new Promise((r) => setTimeout(r, 2500));
  }
  const { data } = await supabase.from('studio_jobs').select('*').eq('id', id).single();
  return data;
}

// What the app sees.
export const publicJob = (j) => j && ({
  id: j.id, kind: j.kind, status: j.status, progress: j.progress, result: j.result, error: j.error,
  project_kind: j.project_kind, project_id: j.project_id, credits: j.credits, created_at: j.created_at, finished_at: j.finished_at,
});

// ── Runner ──────────────────────────────────────────────────────────────────
let ticking = false;
let timer = null;
function kick() { setTimeout(tick, 50); }

// Two conditional updates, not one with .or(): this PostgREST rejects an
// or-filter on a PATCH ("column studio_jobs.locked_until does not exist"),
// and because that error was ignored no job was ever claimed or run (found
// 2026-11-22: every video clip sat "queued" forever). Each update is still
// atomic, so two instances can't both claim the same job.
async function claim(job) {
  const patch = { locked_until: later(60000), updated_at: now() };
  const base = () => supabase.from('studio_jobs').update(patch).eq('id', job.id).in('status', ['queued', 'running']);
  const free = await base().is('locked_until', null).select().maybeSingle();
  if (free.error) console.error('[jobs] claim failed:', free.error.message);
  if (free.data) return free.data;
  const stale = await base().lt('locked_until', now()).select().maybeSingle();
  if (stale.error) console.error('[jobs] claim failed:', stale.error.message);
  return stale.data;
}

async function settle(job, patch, reservationAction) {
  const ctx = ephemeral.get(job.id) || {};
  const reservation = ctx.reservation || (job.reservation_id ? { id: job.reservation_id, credits: job.credits } : null);
  if (reservationAction === 'commit') await commitCredits(job.user_id, reservation);
  if (reservationAction === 'release') await releaseCredits(reservation);
  await supabase.from('studio_jobs').update({ ...patch, locked_until: null, updated_at: now(), finished_at: now() }).eq('id', job.id);
  ephemeral.delete(job.id);
}

async function step(job) {
  const handler = HANDLERS.get(job.kind);
  if (!handler) return; // registered by a route module that may not be loaded in this process
  const ctx = ephemeral.get(job.id) || {};
  try {
    if (Date.now() - new Date(job.created_at).getTime() > GIVE_UP_MS) throw Object.assign(new Error('The provider took too long.'), { permanent: true });
    if (job.status === 'queued') {
      const started = await jobScope.run(true, () => handler.start(job, ctx));
      await supabase.from('studio_jobs').update({
        status: 'running', provider: started?.provider || null, provider_task_id: started?.providerTaskId || null,
        progress: 10, next_run_at: later(handler.pollEveryMs || 5000), locked_until: null, updated_at: now(),
      }).eq('id', job.id);
      return;
    }
    const polled = await handler.poll(job, ctx);
    if (!polled) {
      const elapsed = Date.now() - new Date(job.created_at).getTime();
      const progress = Math.min(90, 10 + Math.round(elapsed / 1000));
      await supabase.from('studio_jobs').update({ progress, next_run_at: later(handler.pollEveryMs || 5000), locked_until: null, updated_at: now() }).eq('id', job.id);
      return;
    }
    const result = await handler.finish(job, polled.result, ctx);
    await settle(job, { status: 'done', progress: 100, result, error: null }, 'commit');
  } catch (err) {
    const attempts = (job.attempts || 0) + 1;
    if (err.permanent || attempts >= MAX_ATTEMPTS) {
      console.error(`[jobs] ${job.kind} ${job.id} failed:`, err.message);
      try { await handler.failed?.(job, err, ctx); } catch { /* logging only */ }
      // The provider's own message is kept (result.provider_error) so a failure
      // can be diagnosed from the database without the server logs.
      await settle(job, { status: 'failed', error: String(err.userMessage || 'It could not be made this time. You were not charged.').slice(0, 300), attempts, result: { provider_error: String(err.message || '').slice(0, 500) } }, 'release');
    } else {
      console.warn(`[jobs] ${job.kind} ${job.id} attempt ${attempts}:`, err.message);
      await supabase.from('studio_jobs').update({ attempts, result: { provider_error: String(err.message || '').slice(0, 500) }, next_run_at: later(5000 * 2 ** attempts), locked_until: null, updated_at: now() }).eq('id', job.id);
    }
  }
}

async function tick() {
  if (tableMissing && Date.now() - missingSince > 5 * 60000) tableMissing = false;
  if (ticking || tableMissing) return;
  ticking = true;
  try {
    const { data, error } = await supabase.from('studio_jobs').select('*')
      .in('status', ['queued', 'running']).lte('next_run_at', now())
      .order('next_run_at').limit(10);
    if (error) {
      if (/studio_jobs|PGRST205|relation/i.test(error.message)) { tableMissing = true; missingSince = Date.now(); console.warn('[jobs] studio_jobs not found (run migration 073); jobs are off.'); }
      return;
    }
    for (const job of data || []) {
      const claimed = await claim(job);
      if (claimed) await step(claimed);
    }
  } catch (err) {
    console.error('[jobs] tick failed:', err.message);
  } finally { ticking = false; }
}

export function startJobRunner() {
  if (timer) return;
  timer = setInterval(tick, TICK_MS);
  kick();
}
