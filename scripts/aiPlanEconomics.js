// Checks that the Bascardo AI plans pay for themselves and for free users.
//
//   node scripts/aiPlanEconomics.js [conversion%] [free usage%] [paid usage%]
//
// Defaults: 3% of users pay, free users use 50% of their credits, payers 70%.
// Costs are the worst-case USD per action in config/aiPlans.js
// (ACTION_COST_USD); Google keeps 15% of subscriptions.
import { AI_PLANS, ACTION_COSTS, ACTION_COST_USD, CREDIT_COST_CEILING_USD } from '../config/aiPlans.js';

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
const freeWorst = free.monthlyCredits * worstPerCredit(false);
const freeTypical = freeWorst * freeUse / 100;
const freePerPayer = (100 - conv) / conv;
console.log(`\nFree: ${free.monthlyCredits} credits, worst $${freeWorst.toFixed(2)}/user/month, typical $${freeTypical.toFixed(3)}`);
console.log(`At ${conv}% paying there are ${freePerPayer.toFixed(0)} free users per subscriber.\n`);

for (const p of [AI_PLANS.pro, AI_PLANS.business]) {
  const net = p.priceUsd * (1 - GOOGLE_FEE);
  const worst = p.monthlyCredits * worstPerCredit(true);
  const typical = worst * paidUse / 100;
  const carryWorst = net - worst - freePerPayer * freeWorst;
  const carryTypical = net - typical - freePerPayer * freeTypical;
  if (carryWorst < 0) ok = false;
  console.log(`${p.name} $${p.priceUsd}: we receive $${net.toFixed(2)}; AI cost worst $${worst.toFixed(2)}, typical $${typical.toFixed(2)}`);
  console.log(`  left after carrying ${freePerPayer.toFixed(0)} free users: worst $${carryWorst.toFixed(2)}, typical $${carryTypical.toFixed(2)} (${Math.round(carryTypical / net * 100)}% of what we receive)`);
  console.log(`  ${Math.floor((net - worst) / freeWorst)} free users fully covered per subscriber in the worst case`);
}
console.log(ok ? '\n✔ Every plan pays for itself and its free users.' : '\n✘ Something loses money: fix ACTION_COSTS or monthlyCredits.');
process.exit(ok ? 0 : 1);
