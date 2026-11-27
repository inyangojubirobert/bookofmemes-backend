// Runware balance watch (2026-11-27). Every Bascardo AI picture, clip, voice and song is paid
// from our Runware account. When it ran low, full video clips failed (Seedance needs a $6
// minimum balance) and nobody knew until a subscriber's clips kept failing.
//
// Now the server reads the balance every 30 minutes and alerts the admins once at each step
// down: $100, $50, $20, $10, $5, then empty. Each alert shows the spend over the last 24 hours,
// about how many days are left, and, from $20 down, how many attempts failed because of the
// balance (subscribers counted separately from free users). While requests are being refused
// an update goes out at most once an hour with the running count. A top-up is noticed on the
// next check and announced once. Customers are never told about any of this: they only see
// the usual "could not be made, you were not charged".
//
// State lives in provider_balance_state (migration 093) so a deploy never repeats an alert;
// before 093 is run it is kept in memory.
import { AsyncLocalStorage } from 'node:async_hooks';
import { supabase } from '../config/db.js';

// Set while a studio job calls the provider, so a refusal inside a job (already recorded in
// studio_jobs) isn't counted twice.
export const jobScope = new AsyncLocalStorage();

const PROVIDER = 'runware';
const STEPS = (process.env.RUNWARE_BALANCE_ALERTS || '100,50,20,10,5')
  .split(',').map(Number).filter((n) => n > 0).sort((a, b) => b - a);
const LOW_FROM = 20;                    // failure counts are included from this step down
const VIDEO_MINIMUM_USD = 6;            // Runware refuses full (Seedance) clips below this balance
const CHECK_EVERY_MS = 30 * 60 * 1000;
const REFUSAL_UPDATE_MS = 60 * 60 * 1000;
const KEEP_READINGS_MS = 7 * 24 * 60 * 60 * 1000;
const BALANCE_ERROR = /insufficient credits|minimum balance|top-?up your balance/i;

export const isBalanceError = (message) => BALANCE_ERROR.test(String(message || ''));

let memoryState = null;     // used until migration 093 is run
let tableMissing = false;
let lastRefusalUpdate = 0;
let refusedOutsideJobs = 0; // refusals of direct (non-job) requests since the server started

const money = (n) => `$${Number(n).toFixed(2)}`;
// The lowest step the balance is at or under (0 = empty), or null while above every step.
export function stepFor(balance) {
  if (balance <= 0) return 0;
  const under = STEPS.filter((s) => balance <= s);
  return under.length ? under[under.length - 1] : null;
}
const stepLabel = (s) => (s === 0 ? 'EMPTY' : `under ${money(s)}`);

async function loadState() {
  if (!tableMissing) {
    const { data, error } = await supabase.from('provider_balance_state').select('*').eq('provider', PROVIDER).maybeSingle();
    if (!error) return data || { provider: PROVIDER, readings: [] };
    if (/provider_balance_state|does not exist|schema cache/i.test(error.message)) {
      tableMissing = true;
      console.warn('[balance] run migration 093 (provider_balance_state); keeping alert state in memory until then');
    } else throw error;
  }
  return memoryState || { provider: PROVIDER, readings: [] };
}

async function saveState(state) {
  const row = { ...state, provider: PROVIDER, updated_at: new Date().toISOString() };
  if (tableMissing) { memoryState = row; return; }
  const { error } = await supabase.from('provider_balance_state').upsert(row, { onConflict: 'provider' });
  if (error) { console.warn('[balance] save failed:', error.message); memoryState = row; }
}

export async function fetchRunwareBalance() {
  const res = await fetch('https://api.runware.ai/v1', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RUNWARE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([{ taskType: 'accountManagement', taskUUID: crypto.randomUUID(), operation: 'getDetails' }]),
    signal: AbortSignal.timeout(20_000),
  });
  const json = await res.json().catch(() => null);
  const balance = Number(json?.data?.[0]?.balance);
  if (!res.ok || !Number.isFinite(balance)) throw new Error(json?.errors?.[0]?.message || `Runware account check failed (${res.status})`);
  return balance;
}

// Money spent in the last 24 hours (falls only; top-ups are ignored) and days left at that rate.
export function spendRate(readings, balance, now = Date.now()) {
  const day = readings.filter((r) => now - new Date(r.at).getTime() <= 24 * 60 * 60 * 1000);
  let spent = 0;
  for (let i = 1; i < day.length; i++) spent += Math.max(0, day[i - 1].b - day[i].b);
  const hours = day.length > 1 ? (new Date(day[day.length - 1].at) - new Date(day[0].at)) / 3_600_000 : 0;
  if (hours < 1) return { spent24h: null, daysLeft: null };
  const perDay = spent * (24 / hours);
  return { spent24h: perDay, daysLeft: perDay > 0 ? balance / perDay : null };
}

// Attempts that failed because the balance was too low, since `since`. Jobs record the plan
// they were made on (input.tier), so subscribers and free users are counted apart.
export async function countBalanceFailures(since) {
  const { data, error } = await supabase.from('studio_jobs')
    .select('user_id, kind, input->>tier')
    .eq('status', 'failed')
    .ilike('result->>provider_error', '%insufficient credits%')
    .gte('created_at', since)
    .limit(5000);
  if (error) { console.warn('[balance] failure count:', error.message); return null; }
  const paid = data.filter((j) => j.tier && j.tier !== 'free');
  const free = data.length - paid.length;
  return {
    attempts: data.length, subscriberAttempts: paid.length, subscribers: new Set(paid.map((j) => j.user_id)).size,
    freeAttempts: free, freeUsers: new Set(data.filter((j) => !j.tier || j.tier === 'free').map((j) => j.user_id)).size,
    otherRequests: refusedOutsideJobs,
  };
}

function failureLines(f) {
  if (!f || (!f.attempts && !f.otherRequests)) return ['No attempts have failed because of the balance yet.'];
  const lines = [`Failed because of the balance: ${f.attempts} attempt${f.attempts === 1 ? '' : 's'}`];
  lines.push(`  • subscribers: ${f.subscriberAttempts} attempt${f.subscriberAttempts === 1 ? '' : 's'} by ${f.subscribers} user${f.subscribers === 1 ? '' : 's'}`);
  lines.push(`  • free users: ${f.freeAttempts} attempt${f.freeAttempts === 1 ? '' : 's'} by ${f.freeUsers} user${f.freeUsers === 1 ? '' : 's'}`);
  if (f.otherRequests) lines.push(`  • plus ${f.otherRequests} direct request${f.otherRequests === 1 ? '' : 's'} (pictures, voices, episode steps) refused since the last server start`);
  return lines;
}

export function alertText({ balance, step, rate, failures, toppedUp = false }) {
  if (toppedUp) return `✅ Runware topped up: balance is now ${money(balance)}.\nAlerts start again at ${money(STEPS[0])}.`;
  const lines = [step === 0 ? `🛑 Runware balance EMPTY (${money(balance)}): AI requests are being refused.` : `${step <= 10 ? '⚠️' : 'ℹ️'} Runware balance ${money(balance)}: ${stepLabel(step)}.`];
  if (rate?.spent24h != null) lines.push(`Spent in the last 24 h: ${money(rate.spent24h)}${rate.daysLeft != null ? `, about ${rate.daysLeft < 1 ? 'less than a day' : `${Math.floor(rate.daysLeft)} day${Math.floor(rate.daysLeft) === 1 ? '' : 's'}`} left at that rate` : ''}.`);
  if (balance < VIDEO_MINIMUM_USD) lines.push(`Full video clips stop below ${money(VIDEO_MINIMUM_USD)} (only drafts, pictures and voices still run).`);
  else if (step != null && step <= 10) lines.push(`Full video clips stop below ${money(VIDEO_MINIMUM_USD)}.`);
  if (failures) lines.push(...failureLines(failures));
  lines.push('Top up: https://my.runware.ai/wallet');
  return lines.join('\n');
}

async function notify(text) {
  try {
    const { notifyAdmins } = await import('../routes/supportRoutes.js');
    const sent = await notifyAdmins(text);
    if (!sent) console.warn('[balance] admin alerts are off or not connected; alert was:\n' + text);
    return sent;
  } catch (err) { console.warn('[balance] alert failed:', err.message); return false; }
}

/** One check: read the balance, record it, alert on a new step down or a top-up. */
export async function checkRunwareBalance({ refused = false } = {}) {
  const balance = await fetchRunwareBalance();
  const state = await loadState();
  const now = new Date();
  const readings = [...(state.readings || []), { at: now.toISOString(), b: balance }]
    .filter((r) => now - new Date(r.at) <= KEEP_READINGS_MS).slice(-500);
  // A refusal means we're under the provider's minimum: treat it as empty whatever the number.
  const step = refused ? 0 : stepFor(balance);
  const prev = state.alerted_step == null ? null : Number(state.alerted_step);
  const next = { ...state, balance, readings, checked_at: now.toISOString() };

  const worse = step != null && (prev == null || step < prev);
  const better = prev != null && (step == null || step > prev);
  if (step != null && step <= LOW_FROM && !next.low_since) next.low_since = now.toISOString();

  if (worse) {
    next.alerted_step = step;
    const failures = step <= LOW_FROM ? await countBalanceFailures(next.low_since) : null;
    if (step === 0) lastRefusalUpdate = Date.now();
    await notify(alertText({ balance, step, rate: spendRate(readings, balance), failures }));
  } else if (better) {
    next.alerted_step = step;
    if (step == null || step > LOW_FROM) { next.low_since = null; refusedOutsideJobs = 0; }
    await notify(alertText({ balance, step, toppedUp: true }));
  } else if (refused && Date.now() - lastRefusalUpdate >= REFUSAL_UPDATE_MS) {
    // Still empty and still refusing: an hourly running count of who is affected.
    lastRefusalUpdate = Date.now();
    await notify(alertText({ balance, step: 0, rate: spendRate(readings, balance), failures: await countBalanceFailures(next.low_since || new Date(Date.now() - 86_400_000).toISOString()) }));
  }
  await saveState(next);
  return { balance, step, alerted: worse || better };
}

/**
 * Called by the Runware client when a request is refused for the balance. `inJob` = the
 * failure is recorded in studio_jobs (counted from there); otherwise it's counted here.
 */
let refusalCheck = null;
export function balanceRefused({ inJob = !!jobScope.getStore() } = {}) {
  if (!inJob) refusedOutsideJobs++;
  if (refusalCheck) return;
  // Wait a moment so the failed job is saved before it is counted.
  refusalCheck = setTimeout(() => {
    checkRunwareBalance({ refused: true }).catch((e) => console.warn('[balance] check after refusal:', e.message))
      .finally(() => { refusalCheck = null; });
  }, 5_000);
}

export function startProviderBalanceTimer() {
  if (!process.env.RUNWARE_API_KEY) return;
  const run = () => checkRunwareBalance().catch((e) => console.warn('[balance] check failed:', e.message));
  setTimeout(run, 30_000);
  setInterval(run, CHECK_EVERY_MS);
}
