// Checks that the Bascardo AI plans pay for themselves and for free users.
//
//   node scripts/aiPlanEconomics.js [conversion%] [free usage%] [paid usage%]
//
// Defaults: 3% of users pay, free users use 50% of their credits, payers 70%.
// Costs are the worst-case USD per action in config/aiPlans.js
// (ACTION_COST_USD); Google keeps 15% of subscriptions.
import { AI_PLANS, ACTION_COSTS, ACTION_COST_USD, CREDIT_COST_CEILING_USD, CORRECTION_COST_USD, TOPUP_PACKS, REF_PRICING, refCredits } from '../config/aiPlans.js';

const [conv = 3, freeUse = 50, paidUse = 70] = process.argv.slice(2).map(Number);
const GOOGLE_FEE = 0.15;
let ok = true;

console.log(`Ceiling: one credit may cost at most $${CREDIT_COST_CEILING_USD}\n`);
console.log('Cost per credit, by action:');
for (const [action, credits] of Object.entries(ACTION_COSTS)) {
  for (const [kind, n] of Object.entries(credits)) {
    const perCredit = ACTION_COST_USD[action][kind] / n;
    const flag = perCredit > CREDIT_COST_CEILING_USD + 1e-9 ? '  ✘ OVER CEILING' : '';
    if (flag) ok = false;
    console.log(`  ${action.padEnd(19)} ${kind.padEnd(21)} ${String(n).padStart(4)} credits  $${ACTION_COST_USD[action][kind].toFixed(4).padStart(7)}  = $${perCredit.toFixed(4)}/credit${flag}`);
  }
}

// Worst case per user: every credit spent on the most expensive per-credit action.
const worstPerCredit = (premium) => Math.max(...Object.entries(ACTION_COSTS).flatMap(([a, c]) =>
  Object.entries(c).filter(([k]) => (premium ? k !== 'fast' : k === 'fast')).map(([k, n]) => ACTION_COST_USD[a][k] / n)));

const free = AI_PLANS.free;
const corrections = (p) => p.correctionsPerDay * 30 * CORRECTION_COST_USD;
const freeWorst = free.monthlyCredits * worstPerCredit(false) + corrections(free);
const freeTypical = freeWorst * freeUse / 100;
const freePerPayer = (100 - conv) / conv;
console.log(`\nFree: ${free.monthlyCredits} credits, worst $${freeWorst.toFixed(2)}/user/month, typical $${freeTypical.toFixed(3)}`);
console.log(`At ${conv}% paying there are ${freePerPayer.toFixed(0)} free users per subscriber.\n`);

for (const p of [AI_PLANS.pro, AI_PLANS.business]) {
  const net = p.priceUsd * (1 - GOOGLE_FEE);
  const worst = p.monthlyCredits * worstPerCredit(true) + corrections(p);
  if (p.correctionsPerDay) console.log(`${p.name} includes ${p.correctionsPerDay} chat corrections a day: up to $${corrections(p).toFixed(2)} a month`);
  const typical = worst * paidUse / 100;
  const carryWorst = net - worst - freePerPayer * freeWorst;
  const carryTypical = net - typical - freePerPayer * freeTypical;
  if (carryWorst < 0) ok = false;
  console.log(`${p.name} $${p.priceUsd}: we receive $${net.toFixed(2)}; AI cost worst $${worst.toFixed(2)}, typical $${typical.toFixed(2)}`);
  console.log(`  left after carrying ${freePerPayer.toFixed(0)} free users: worst $${carryWorst.toFixed(2)}, typical $${carryTypical.toFixed(2)} (${Math.round(carryTypical / net * 100)}% of what we receive)`);
  console.log(`  ${Math.floor((net - worst) / freeWorst)} free users fully covered per subscriber in the worst case`);
}
// Top-ups: must cost more per credit than the cheapest subscription credit,
// and still beat the worst cost per credit after Google's cut (up to 30% on
// wallet purchases).
const PLAY_FEE_MAX = 0.30;
const bestPlanPerCredit = Math.min(...[AI_PLANS.pro, AI_PLANS.business].map((p) => p.priceUsd / p.monthlyCredits));
const worstAny = Math.max(worstPerCredit(true), worstPerCredit(false));
console.log(`\nTop-ups (best subscription price per credit $${bestPlanPerCredit.toFixed(4)}, worst cost per credit $${worstAny.toFixed(4)}):`);
for (const p of Object.values(TOPUP_PACKS)) {
  const per = p.priceUsd / p.credits;
  const net = per * (1 - PLAY_FEE_MAX);
  const flags = [per < bestPlanPerCredit - 1e-9 && 'CHEAPER THAN A PLAN', net < worstAny && 'LOSES MONEY'].filter(Boolean);
  if (flags.length) ok = false;
  console.log(`  ${p.id.padEnd(14)} ${String(p.credits).padStart(4)} credits $${p.priceUsd.toFixed(2)} = $${per.toFixed(4)}/credit, after Google's cut $${net.toFixed(4)} (${Math.round(net / worstAny)}x worst cost)${flags.length ? '  ✘ ' + flags.join(', ') : ''}`);
}

// Pictures priced by the number of references sent (0-9): each count must pay for itself.
console.log('\nPictures from references (priced per reference sent)');
for (const [a, r] of Object.entries(REF_PRICING)) {
  const worst = Math.max(...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (r.baseUsd + r.perRefUsd * n) / refCredits(a, n)));
  const okRef = worst <= CREDIT_COST_CEILING_USD + 1e-9;
  if (!okRef) ok = false;
  console.log(`  ${okRef ? '✔' : '✘'} ${a}: ${refCredits(a, 0)}-${refCredits(a, 9)} credits for 0-9 references, worst $${worst.toFixed(4)}/credit`);
}

// Free plan: can a free user finish one thing in each studio within its credits?
const f = (a, n = 1) => ACTION_COSTS[a === 'narration' ? 'narrationPerMinute' : a === 'song' ? 'songPerMinute' : a].fast * n;
const taste = {
  'story (plan + chapter 1)': f('storyPlan') + f('storyChapter'),
  '4-page picture book (ideas, pages, 4 pictures)': f('bookConcepts') + f('bookPagesShort') + f('image', 4),
  'meme (ideas, draft, picture)': f('contentIdeas') + f('contentDraft') + f('image'),
  'puzzle (ideas, verified draft, picture)': f('contentIdeas') + f('contentDraftVerified') + f('image'),
  'kids post (ideas, draft, picture)': f('contentIdeas') + f('contentDraft') + f('image'),
  'song (ideas, lyrics, 1-minute song, cover)': f('contentIdeas') + f('contentDraft') + f('song') + f('image'),
  '1-minute podcast (ideas, script, narration)': f('contentIdeas') + f('contentDraftLong') + f('narration', 1),
};
console.log(`\nFree plan (${AI_PLANS.free.monthlyCredits} credits): one finished piece per studio`);
for (const [k, v] of Object.entries(taste)) console.log(`  ${v <= AI_PLANS.free.monthlyCredits ? '✔' : '·'} ${k}: ${v} credits${v > AI_PLANS.free.monthlyCredits ? ' (needs a top-up or a plan)' : ''}`);
console.log('  · video: Pro and Business only (by decision)');

console.log(ok ? '\n✔ Every plan pays for itself and its free users.' : '\n✘ Something loses money: fix ACTION_COSTS or monthlyCredits.');
process.exit(ok ? 0 : 1);
