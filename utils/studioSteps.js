// One charged AI step for every Bascardo studio (stories, content, and the
// engines that follow). Was copied in storyRoutes.js and contentStudioRoutes.js;
// both now call this, with the same request/response contract as before:
//
//   * request_id from the app: the same id returns the saved result without
//     running or charging again; a second tap while it runs is refused.
//   * one step at a time per project.
//   * credits are RESERVED atomically before the provider is called (migration
//     073), COMMITTED only after the result is saved, RELEASED on any failure.
//   * every step is logged (ai_generation_history) with its real cost.
//
// The ledger table (story_ai_requests, content_ai_requests) keeps one row per
// request_id: running → done (with the response) or failed.
import { supabase } from '../config/db.js';
import { creditStatus, reserveCredits, commitCredits, releaseCredits, outOfCreditsMessage } from './aiCredits.js';
import { creditsFor } from '../config/aiPlans.js';
import { logGeneration } from './aiGenerationLog.js';

export const REQ_ID = /^[A-Za-z0-9_-]{8,80}$/;
const LOCK_MS = 5 * 60000;
const now = () => new Date().toISOString();
const fail = (res, status, error, extra = {}) => res.status(status).json({ success: false, error, ...extra });

/**
 * @param opts.ledger      table name (story_ai_requests | content_ai_requests)
 * @param opts.kind        step name stored in the ledger
 * @param opts.action      credit action in config/aiPlans.js
 * @param opts.costOpts    extra creditsFor options (e.g. { seconds })
 * @param opts.projectId   locks the project to one step at a time
 * @param opts.ledgerExtra extra ledger columns (e.g. { item_type })
 * @param opts.subject     "story" | "post", for the busy message
 * @param opts.log         { feature, model, provider, prompt } for ai_generation_history
 * @param opts.isKnownError(err) → true when err.message/err.status may be shown to the user
 * @param work(status)     does the step; returns { data, usage?, providerCost?, durationSeconds?, outputUrl?, projectId? }
 */
export async function runChargedStep(req, res, opts, work) {
  const { ledger, kind, action, costOpts = {}, projectId = null, ledgerExtra = {}, subject = 'this', log = {}, isKnownError = () => false, recordTokens = false } = opts;
  const userId = req.user.id;
  const requestId = String(req.body?.request_id || '');
  if (!REQ_ID.test(requestId)) return fail(res, 400, 'Missing request id. Please update the app.');

  // Same request again: hand back what it produced, without charging again.
  const { data: prior } = await supabase.from(ledger).select('*').eq('request_id', requestId).maybeSingle();
  if (prior) {
    if (prior.user_id !== userId) return fail(res, 409, 'Request id already used.');
    if (prior.status === 'done') return res.json({ success: true, data: prior.response, replayed: true });
    if (prior.status === 'running' && Date.now() - new Date(prior.created_at).getTime() < LOCK_MS) {
      return fail(res, 409, 'Bascardo AI is still working on this. Give it a moment.');
    }
  }
  if (projectId) {
    const { data: busy } = await supabase.from(ledger).select('request_id')
      .eq('project_id', projectId).eq('status', 'running').neq('request_id', requestId)
      .gt('created_at', new Date(Date.now() - LOCK_MS).toISOString()).limit(1);
    if (busy?.length) return fail(res, 409, `Bascardo AI is already working on ${subject}. Give it a moment.`);
  }

  const status = await creditStatus(userId);
  const cost = creditsFor(action, { premium: status.plan.premiumModels, ...costOpts });
  const outOfCredits = () => fail(res, 402, outOfCreditsMessage(status, cost, ' Your credits renew on the 1st, or get more with a Bascardo AI plan.'), {
    code: 'out_of_credits', credits: { remaining: status.remaining, limit: status.limit, cost, plan: status.plan.name },
  });
  if (status.remaining < cost) return outOfCredits();
  const reservation = await reserveCredits(userId, status.plan, cost, `${ledger}:${requestId}`);
  if (!reservation) return outOfCredits();

  const row = { request_id: requestId, user_id: userId, project_id: projectId, kind, status: 'running', credits: cost, error: null, response: null, created_at: now(), finished_at: null, ...ledgerExtra };
  if (recordTokens) Object.assign(row, { input_tokens: null, output_tokens: null });
  const { error: lockErr } = prior
    ? await supabase.from(ledger).update(row).eq('request_id', requestId)
    : await supabase.from(ledger).insert(row);
  if (lockErr) { await releaseCredits(reservation); return fail(res, 409, 'Bascardo AI is already working on this. Give it a moment.'); }

  const started = Date.now();
  const baseLog = { userId, feature: 'text', provider: 'anthropic', ...log, prompt: undefined, tier: status.plan.id, requestId, inputPrompt: log.prompt };
  try {
    const out = await work(status);
    // Saved first, then charged: a failure above never costs credits.
    await commitCredits(userId, reservation);
    const after = await creditStatus(userId).catch(() => null);
    const data = { ...out.data, credits: after ? { remaining: after.remaining, limit: after.limit, spent: cost } : { spent: cost } };
    const done = { status: 'done', response: data, finished_at: now(), project_id: out.projectId || projectId };
    if (recordTokens && out.usage) Object.assign(done, { input_tokens: out.usage.input ?? null, output_tokens: out.usage.output ?? null });
    await supabase.from(ledger).update(done).eq('request_id', requestId);
    logGeneration({ ...baseLog, success: true, latencyMs: Date.now() - started, providerCost: out.providerCost ?? null, durationSeconds: out.durationSeconds || 0, outputUrl: out.outputUrl || null });
    return res.json({ success: true, data });
  } catch (err) {
    await releaseCredits(reservation);
    console.error(`[${ledger}] ${kind} failed:`, err.message);
    await supabase.from(ledger).update({ status: 'failed', error: String(err.message).slice(0, 500), finished_at: now() }).eq('request_id', requestId);
    logGeneration({ ...baseLog, success: false, errorMessage: err.message, latencyMs: Date.now() - started });
    const known = isKnownError(err);
    return fail(res, known ? err.status || 500 : 500, known ? err.message : 'Bascardo AI could not finish this. Please try again (you were not charged).');
  }
}
