// The standard deposit package ladder for wallet-link deposits (migrations 060-062).
//
// Book of Memes is an auction marketplace for digital assets, so prices are
// set by bidders, from a few dollars to tens of thousands. Deposits only fund
// the buyer's marketplace funds; they never cap a bid. A buyer adds as many
// deposits as they need and they stack up; the deposit planner
// (routes/depositRoutes.js) combines these tiers to cover any shortfall, and
// an open-amount link per currency (the buyer types the amount) covers
// anything in between.
//
// 13 tiers per currency, from about US$5 to the ceiling
// (market_settings.link_deposit_max_package_usd, $50,000). Amounts are round
// numbers people expect in each currency; the top tier of non-dollar
// currencies sits ~10% under the ceiling so rate moves never push it over.
// Deposits of $1,000 or more are confirmed by an admin (link_deposit_large_usd).
//
// This is the plan; the payment links themselves live in the database
// (market_deposit_links), because each one is created in the wallet app,
// can be switched off or replaced at any time, and must change without a new
// app release. The admin Setup screen shows this ladder with a slot per tier.
export const DEPOSIT_TIERS = {
  USD: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000],
  EUR: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 40000],
  GBP: [5, 10, 20, 40, 80, 200, 400, 800, 2000, 4000, 8000, 20000, 35000],
  JPY: [1000, 1500, 3000, 7500, 15000, 40000, 75000, 150000, 400000, 750000, 1500000, 4000000, 6500000],
  CNY: [50, 100, 200, 400, 700, 2000, 3500, 7000, 18000, 35000, 70000, 180000, 320000],
  AUD: [10, 15, 40, 75, 150, 400, 750, 1500, 4000, 7500, 15000, 40000, 65000],
  CAD: [10, 15, 35, 70, 140, 350, 700, 1400, 3500, 7000, 14000, 35000, 60000],
  CHF: [5, 10, 20, 45, 90, 220, 450, 900, 2200, 4500, 9000, 22000, 38000],
  HKD: [50, 100, 200, 400, 800, 2000, 4000, 8000, 20000, 40000, 80000, 200000, 350000],
  SGD: [10, 15, 35, 70, 140, 350, 700, 1400, 3500, 7000, 14000, 35000, 60000],
};

export const DEPOSIT_CURRENCIES = Object.keys(DEPOSIT_TIERS);

// Most packages one plan may combine (also market_settings.link_deposit_max_open).
export const MAX_PLAN_PACKAGES = 10;

/**
 * Picks deposit packages that together cover `targetUsd` of credited funds.
 * `options` = [{ id, credit_usd, open?, min_credit_usd?, max_credit_usd? }].
 * Prefers one open-amount link when it can cover the target exactly; otherwise
 * takes the largest fixed packages that fit, then the smallest one that covers
 * what is left. Returns { items: [{ id, amount? }], fixedCredit } or null.
 */
export function planDeposits(targetUsd, fixed, openLink = null, amountForCredit = null) {
  if (!(targetUsd > 0)) return null;
  if (openLink && amountForCredit) {
    const amount = amountForCredit(targetUsd);
    if (amount && amount >= openLink.min_amount && amount <= openLink.max_amount) {
      return { items: [{ id: openLink.id, amount, open: true }] };
    }
  }
  const tiers = fixed.filter((t) => t.credit_usd > 0).sort((a, b) => b.credit_usd - a.credit_usd);
  if (!tiers.length) return null;
  const items = [];
  let left = Math.round(targetUsd * 100) / 100;
  // Fewer, slightly bigger packages beat many small ones: each is a separate
  // payment for the buyer. Up to 10% extra (it stays in their funds) is fine.
  const slack = Math.max(tiers[tiers.length - 1].credit_usd, targetUsd * 0.1);
  while (left > 0 && items.length < MAX_PLAN_PACKAGES) {
    const fits = tiers.find((t) => t.credit_usd <= left);                 // largest that doesn't overshoot
    const covers = [...tiers].reverse().find((t) => t.credit_usd >= left); // smallest that finishes it
    // Finish with one package when its overshoot is within the slack (or
    // nothing else fits / this is the last slot); otherwise keep filling with
    // the largest that fits.
    const finish = covers && (!fits || covers.credit_usd - left <= slack || items.length === MAX_PLAN_PACKAGES - 1);
    const pick = finish ? covers : (fits || covers);
    items.push({ id: pick.id, credit_usd: pick.credit_usd });
    left = Math.round((left - pick.credit_usd) * 100) / 100;
  }
  if (left > 0) return null; // needs more than MAX_PLAN_PACKAGES packages
  return { items, fixedCredit: items.reduce((s, i) => s + i.credit_usd, 0) };
}
