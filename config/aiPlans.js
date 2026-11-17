// Bascardo AI plans for Book of Memes, on One Dream's model: Free, Pro ($9/month)
// and Business ($20/month), sold as auto-renewing Google Play subscriptions
// (migration 059). The server decides a user's plan (get_ai_plan); these
// limits are what each plan gets. Change limits here; change prices in Play
// Console (existing subscribers keep the price they signed up at).
//
// Pro keeps exactly what the old single "Premium" gave, so nobody who had it
// loses anything; Business is for heavy creators.
export const AI_PLANS = {
  free: {
    id: 'free',
    name: 'Free',
    priceUsd: 0,
    googlePlayProductId: null,
    limits: {
      researchPerDay: 5,
      writingPerDay: 10,
      imagesPerMonth: 5,
      videosPerMonth: 1,
      narrationSecondsPerMonth: 120,
    },
    premiumModels: false, // watermark on, standard models
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceUsd: 9,
    googlePlayProductId: process.env.GOOGLE_PLAY_AI_PRO_PRODUCT_ID || 'bom_ai_pro_monthly',
    limits: {
      researchPerDay: 200,
      writingPerDay: 100,
      imagesPerMonth: 100,
      videosPerMonth: 20,
      narrationSecondsPerMonth: 1800,
    },
    premiumModels: true,
  },
  business: {
    id: 'business',
    name: 'Business',
    priceUsd: 20,
    googlePlayProductId: process.env.GOOGLE_PLAY_AI_BUSINESS_PRODUCT_ID || 'bom_ai_business_monthly',
    limits: {
      researchPerDay: 500,
      writingPerDay: 250,
      imagesPerMonth: 250,
      videosPerMonth: 50,
      narrationSecondsPerMonth: 4500,
    },
    premiumModels: true,
  },
};

// Every Play subscription has exactly one auto-renewing monthly base plan with this id.
export const AI_BASE_PLAN_ID = 'monthly';

export const AI_PLAN_ORDER = ['free', 'pro', 'business'];

export function planFromGoogleProductId(productId) {
  return Object.values(AI_PLANS).find((p) => p.googlePlayProductId && p.googlePlayProductId === productId)?.id || null;
}

export const publicPlan = (p) => ({
  id: p.id, name: p.name, price_usd: p.priceUsd, google_play_product_id: p.googlePlayProductId,
  base_plan_id: p.googlePlayProductId ? AI_BASE_PLAN_ID : null, limits: p.limits, premium_models: p.premiumModels,
});
