// Bascardo AI plans for Book of Memes, on One Dream's model (flymaddcreative
// lib/aiFeature.js): one pool of AI credits a month per plan, and every AI
// action costs credits in proportion to what it really costs us.
//
//   Free      10 credits a month     $0
//   Pro      200 credits a month     $9   (Google keeps 15%: we receive $7.65)
//   Business 750 credits a month     $20  (we receive $17.00)
//
// Pro and Business match One Dream's credits and prices. One credit is worth
// about what One Dream's is (one AI chat): it must never cost us more than
// $0.01. So a subscriber who spends every credit on the most expensive thing
// costs at most $2 (Pro) or $7.50 (Business), and what is left of their
// payment carries the free users, whose AI is paid for by subscribers.
// Free is sized for that: at most $0.10 a month per free user, so one Pro
// subscriber covers ~50 free users even if everybody uses everything.
// Run `node scripts/aiPlanEconomics.js` after changing anything here. Provider prices checked 2026-11-17 (see ACTION_COSTS); the real
// cost of every generation is logged in ai_generation_history.provider_cost,
// so re-check these when that data builds up.
//
// When the month's credits run out, writing, images, video and narration can
// still be bought one at a time with wallet credits (HD, utils/credits.js).
export const CREDIT_COST_CEILING_USD = 0.01;

export const AI_PLANS = {
  free: {
    id: 'free',
    name: 'Free',
    priceUsd: 0,
    monthlyCredits: 10,
    googlePlayProductId: null,
    premiumModels: false, // fast models, watermarked
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceUsd: 9,
    monthlyCredits: 200,
    googlePlayProductId: process.env.GOOGLE_PLAY_AI_PRO_PRODUCT_ID || 'bom_ai_pro_monthly',
    premiumModels: true, // flagship models, no watermark
  },
  business: {
    id: 'business',
    name: 'Business',
    priceUsd: 20,
    monthlyCredits: 750,
    googlePlayProductId: process.env.GOOGLE_PLAY_AI_BUSINESS_PRODUCT_ID || 'bom_ai_business_monthly',
    premiumModels: true,
  },
};

// Credits per action. "fast" = the Free plan's models, "premium" = Pro and
// Business models. Our cost per action, in USD:
//   chat / writing       Claude Haiku 4.5, ≤1k output tokens        ≤ $0.008
//   search               Claude Haiku 4.5, ≤2k output tokens        ≤ $0.014
//   image fast           Runware z-image turbo (measured)              $0.0006
//   image premium        FLUX.2 [pro]: $0.045, with a reference $0.075
//   video fast           Seedance 2.0 fast, 5 s (measured)             $0.30
//   video premium        Seedance 2.0, 5 s: ~$0.80 (Runware's 6 s example
//                        is $0.95); from a start image up to ~$2 (examples)
//   narration            Fish Audio S2.1 pro $15 / 1M bytes ≈ $0.02 a minute;
//                        Gemini flash TTS less
export const ACTION_COSTS = {
  research: { fast: 1, premium: 1 },         // AI chat
  search: { fast: 2, premium: 2 },           // AI search over app content (longer answers)
  writing: { fast: 1, premium: 1 },
  image: { fast: 1, premium: 5, premiumWithReference: 8 },
  video: { fast: 30, premium: 80, premiumWithReference: 200 },
  narrationPerMinute: { fast: 1, premium: 2 },
};

// Our cost per action in USD (worst case), used by scripts/aiPlanEconomics.js.
export const ACTION_COST_USD = {
  research: { fast: 0.008, premium: 0.008 },   // Haiku 4.5, ≤1,024 output tokens + history
  search: { fast: 0.014, premium: 0.014 },     // Haiku 4.5, ≤2,048 output tokens + app content
  writing: { fast: 0.007, premium: 0.007 },
  image: { fast: 0.0006, premium: 0.045, premiumWithReference: 0.075 },
  video: { fast: 0.30, premium: 0.80, premiumWithReference: 2.0 },
  narrationPerMinute: { fast: 0.005, premium: 0.02 },
};

export function creditsFor(action, { premium = false, reference = false, seconds = 0 } = {}) {
  const c = ACTION_COSTS[action === 'narration' ? 'narrationPerMinute' : action];
  if (!c) throw new Error(`unknown AI action ${action}`);
  let n = premium ? (reference && c.premiumWithReference ? c.premiumWithReference : c.premium) : c.fast;
  if (action === 'narration') n *= Math.max(1, Math.ceil(seconds / 60));
  return n;
}

// Every Play subscription has exactly one auto-renewing monthly base plan with this id.
export const AI_BASE_PLAN_ID = 'monthly';

export const AI_PLAN_ORDER = ['free', 'pro', 'business'];

export function planFromGoogleProductId(productId) {
  return Object.values(AI_PLANS).find((p) => p.googlePlayProductId && p.googlePlayProductId === productId)?.id || null;
}

// What a plan's credits buy if spent on one thing only (shown on the plans screen).
export function planExamples(p) {
  const kind = p.premiumModels ? 'premium' : 'fast';
  return {
    research_or_writing: Math.floor(p.monthlyCredits / ACTION_COSTS.research[kind]),
    images: Math.floor(p.monthlyCredits / ACTION_COSTS.image[kind]),
    videos: Math.floor(p.monthlyCredits / ACTION_COSTS.video[kind]),
    narration_minutes: Math.floor(p.monthlyCredits / ACTION_COSTS.narrationPerMinute[kind]),
  };
}

export const publicPlan = (p) => ({
  id: p.id, name: p.name, price_usd: p.priceUsd, monthly_credits: p.monthlyCredits,
  google_play_product_id: p.googlePlayProductId, base_plan_id: p.googlePlayProductId ? AI_BASE_PLAN_ID : null,
  premium_models: p.premiumModels, examples: planExamples(p),
  action_costs: Object.fromEntries(Object.entries(ACTION_COSTS).map(([k, v]) => [k, p.premiumModels ? v.premium : v.fast])),
});
