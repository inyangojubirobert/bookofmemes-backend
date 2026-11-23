// Model 1 (Video Studio) vs Model 2 (Auto Episode Engine): credits, our real cost and what
// each plan earns, for the same length of finished video. Real costs measured on Runware
// (ai_generation_history, 2026-11): Seedance clip 5 s $0.37, FLUX.2 [pro] $0.03 + $0.015 per
// reference, Fish voice line ~$0.0015, Haiku calls ~$0.004-0.05.
// Run: node scripts/episodeEconomics.js
import { creditsFor, AI_PLANS, TOPUP_PACKS } from '../config/aiPlans.js';
import { estimateCredits, shotRange } from '../config/episodeEngine.js';

const REAL = { clip: 0.37, still3: 0.075, keyframe3: 0.0825, castPic: 0.03, line: 0.0015, plan: 0.02, breakdown: 0.05, cards: 0.01, ledger: 0.01 };
const perCredit = {
  Pro: (AI_PLANS.pro.priceUsd * 0.85) / AI_PLANS.pro.monthlyCredits,
  Business: (AI_PLANS.business.priceUsd * 0.85) / AI_PLANS.business.monthlyCredits,
  'Top-up': TOPUP_PACKS.ai_topup_150.priceUsd * 0.85 / TOPUP_PACKS.ai_topup_150.credits,
};
const row = (name, credits, cost) => {
  const earn = Object.entries(perCredit).map(([k, v]) => `${k} $${(credits * v).toFixed(2)}`).join(' · ');
  console.log(`${name.padEnd(46)} ${String(credits).padStart(5)} credits   our cost $${cost.toFixed(2)}   ($${(cost / credits).toFixed(4)}/credit)   earns ${earn}`);
};

for (const seconds of [30, 60, 180]) {
  const shots = shotRange(seconds).target;
  console.log(`\n== ${seconds} s finished video (${shots} shots) ==`);
  // Model 1: plan, a still preview per shot (good practice), a clip per shot, a line per shot, render.
  const m1 = creditsFor('videoPlan', { premium: true }) + shots * (creditsFor('image', { premium: true, refs: 3 }) + creditsFor('video', { premium: true }) + creditsFor('voiceLine', { premium: true })) + creditsFor('videoRender', { premium: true });
  row('Model 1: every shot a clip (+ still preview)', m1, REAL.plan + shots * (REAL.still3 + REAL.clip + REAL.line) + REAL.cards);
  const m1bare = creditsFor('videoPlan', { premium: true }) + shots * (creditsFor('video', { premium: true }) + creditsFor('voiceLine', { premium: true })) + creditsFor('videoRender', { premium: true });
  row('Model 1: every shot a clip (no previews)', m1bare, REAL.plan + shots * (REAL.clip + REAL.line) + REAL.cards);
  for (const vm of ['clips', 'mixed', 'stills']) {
    if (vm === 'clips' && seconds > 60) continue;
    const e = estimateCredits({ seconds, visual_mode: vm, newCast: 3 }, creditsFor);
    const redraws = Math.ceil(shots * 0.2);
    const cost = REAL.breakdown + 3 * REAL.castPic + (shots + redraws) * REAL.keyframe3 + e.clips * REAL.clip + (shots - e.clips) * 0.003 + Math.round(shots * 1.2) * REAL.line + REAL.cards + REAL.ledger;
    row(`Model 2: ${vm}`, e.total, cost);
  }
}
console.log('\nPlans: Pro 200 credits/month, Business 750/month; earnings are after Google\'s 15%.');
