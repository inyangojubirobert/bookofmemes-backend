// Bascardo AI plans for Book of Memes, on One Dream's model (flymaddcreative
// lib/aiFeature.js): one pool of AI credits a month per plan, and every AI
// action costs credits in proportion to what it really costs us.
//
//   Free      10 credits a month     $0
//   Pro      500 credits a month     $9   (Google keeps 15%: we receive $7.65)  4 video clips
//   Business 1500 credits a month    $20  (we receive $17.00)  12 video clips
//   (2026-11-24: raised from 200 / 750 so the plans buy a useful number of clips; clip price kept at 125.
//   Checked with scripts/aiPlanEconomics.js: both still carry 32 free users each in the worst case.)
//
// A credit is worth exactly what One Dream's is: one AI chat on Claude Haiku
// with a short answer (≤650 tokens) and a short history, at most ~$0.0065.
// Anything costlier (search, images, video, narration) costs proportionally
// more credits, so a Pro or Business subscriber costs us no more than a One
// Dream subscriber with the same plan: at most $1.30 / $4.88 a month even if
// every credit is spent on the most expensive thing.
//
// Most users will stay on Free and their AI is paid for by subscribers, so
// Free is a taste, not a workload: 10 credits (≤ $0.065 a month), no video,
// no automatic correction. Run `node scripts/aiPlanEconomics.js` after
// changing anything here; it fails if any plan stops paying for itself and
// its free users.
//
// Provider prices checked 2026-11-17 (ACTION_COST_USD). The real cost of
// every generation is logged in ai_generation_history.provider_cost; compare
// after a month live. When the month's credits run out, writing, images,
// video and narration can still be bought one at a time with wallet credits
// (HD, utils/credits.js).
export const CREDIT_COST_CEILING_USD = 0.0065;

export const AI_PLANS = {
  free: {
    id: 'free',
    name: 'Free',
    priceUsd: 0,
    monthlyCredits: 10,
    correctionsPerDay: 0,  // automatic spelling/grammar fixes while typing a chat message
    googlePlayProductId: null,
    premiumModels: false, // fast models, watermarked
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceUsd: 9,
    monthlyCredits: 500,
    correctionsPerDay: 20,
    googlePlayProductId: process.env.GOOGLE_PLAY_AI_PRO_PRODUCT_ID || 'bom_ai_pro_monthly',
    premiumModels: true, // flagship models, no watermark
  },
  business: {
    id: 'business',
    name: 'Business',
    priceUsd: 20,
    monthlyCredits: 1500,
    correctionsPerDay: 40,
    googlePlayProductId: process.env.GOOGLE_PLAY_AI_BUSINESS_PRODUCT_ID || 'bom_ai_business_monthly',
    premiumModels: true,
  },
};

// Credits per action. "fast" = the Free plan's models, "premium" = Pro and
// Business models.
export const ACTION_COSTS = {
  research: { fast: 1, premium: 1 },          // AI chat (the unit: same as One Dream's chat)
  translate: { fast: 1, premium: 1 },         // translate a chat message
  writing: { fast: 1, premium: 1 },           // captions, titles, scripts
  search: { fast: 2, premium: 2 },            // AI search over app content (longer answers)
  image: { fast: 1, premium: 7, premiumWithReference: 12 },
  // From a start picture or cast references costs Runware the same as text-to-video (480p, $0.07 a second:
  // measured $0.37 for 5 s from a start picture on 2026-11-22), so it's no longer priced 2.5x higher.
  video: { fast: 50, premium: 125, premiumWithReference: 125 }, // Pro/Business only: Free can't make video (routes/runwareRoutes.js)
  narrationPerMinute: { fast: 3, premium: 3 },  // both plans use Fish Audio S2.1 Pro (config/aiModels.js)
  // Story Studio (routes/storyRoutes.js, config/storyEngine.js)
  storyPlan: { fast: 4, premium: 4 },         // read the idea/script, plan the story, offer 3 directions
  storyChapter: { fast: 6, premium: 6 },      // write a chapter, then update the story memory + next ideas
  storyIdeas: { fast: 2, premium: 2 },        // fresh ideas for what happens next
  storyContinue: { fast: 4, premium: 4 },     // read an existing story to continue it
  // Content Studio (routes/contentStudioRoutes.js, config/contentEngine.js):
  // the same method for memes, puzzles, kids, music, podcasts and TV
  contentIdeas: { fast: 2, premium: 2 },      // read the idea, offer 3 concepts for the post
  contentDraft: { fast: 2, premium: 2 },      // write the finished post (meme, puzzle, kids, song, TV clip)
  contentDraftLong: { fast: 4, premium: 4 },  // write a podcast episode script
  contentDraftVerified: { fast: 3, premium: 3 }, // puzzle: write it, then solve it independently to prove the answer
  // Book Studio (config/bookEngine.js)
  bookConcepts: { fast: 3, premium: 3 },      // 3 book ideas, each with a page plan and a visual identity
  bookPagesShort: { fast: 2, premium: 2 },    // up to 4 picture-book / early-reader / poetry pages
  bookPagesLong: { fast: 4, premium: 4 },     // up to 4 chapter-book / guide pages
  // Video Studio (config/videoEngine.js); clips use the video price, Pro/Business only
  videoPlan: { fast: 5, premium: 5 },         // storyline -> shot list fitted to the chosen length + its sound & light plan (083)
  videoPlanWithReference: { fast: 6, premium: 6 }, // ... plus reading 3 frames of a reference video
  videoRender: { fast: 2, premium: 2 },       // join the clips + voice-over/music into one MP4
  // Music (ACE-Step 1.5 XL turbo on Runware)
  songPerMinute: { fast: 1, premium: 1 },     // a song or instrumental, per started minute
  // Video Studio finishing (config/soundStudio.js, migration 083)
  sfxPerSecond: { fast: 2, premium: 2 },      // a sound effect (Mirelo SFX 1.5) or sound made for a clip, per second
  voiceLine: { fast: 1, premium: 1 },         // one spoken line (≤400 characters) in a chosen voice and tone
  // Auto Episode Engine (config/episodeEngine.js, utils/episodePipeline.js, migration 084)
  episodeBreakdown: { fast: 9, premium: 9 },      // script → cast, scenes, shots, lines, sounds (episodes up to ~2 min)
  episodeBreakdownLong: { fast: 15, premium: 15 }, // ... for 3-5 minute episodes (up to 60 shots)
  keyframe: { fast: 13, premium: 13 },            // a shot's still + its continuity check, with 3 references (typical); charged by references sent (REF_PRICING)
  stillMotion: { fast: 1, premium: 1 },           // turn a keyframe into a moving shot (slow zoom / pan)
  episodeRender: { fast: 4, premium: 4 },         // assemble scenes, title and end cards, music into the episode
  episodeLedger: { fast: 3, premium: 3 },         // write the continuity ledger for the next episode
  backgroundRemoval: { fast: 2, premium: 2 }, // cut a cast picture out of its background (ideogram remove-background, $0.01)
};

// Our worst-case cost per action in USD (Haiku 4.5: $1 / $5 per million input / output tokens):
//   chat       ≤3.2k input (system, 8 messages × 1,000 chars, question) + 650 output  ≈ $0.0065
//   translate  ≤1.1k input + 1,024 output                                              ≈ $0.0062
//   writing    ≤1.2k input + 650 output                                                ≈ $0.0045
//   search     ≤4.7k input (adds app content) + 1,300 output                           ≈ $0.0112
//   image      fast: Runware z-image turbo (measured) $0.0006; premium FLUX.2 [pro] $0.045, from a reference $0.075
//   video      fast: Seedance 2.0 fast 5 s (measured) $0.30; premium Seedance 2.0 5 s ~$0.80 (Runware's 6 s
//              example is $0.95), from a start image up to ~$2 (Runware examples)
//   narration  Fish Audio S2.1 pro for every plan: measured $0.0135 a minute on 2026-11-20 (priced at $0.015);
//              Gemini flash TTS, the old free voice, measured $0.034-0.061 a minute, so it was dropped
//   correction ≤500 characters in, 200 tokens out                                      ≈ $0.0011
//   storyPlan     ≤5.2k input (idea/script capped at 16,000 characters) + 4,000 output  ≈ $0.0252
//   storyChapter  write ≤4.6k in + 3,500 out, then memory ≤5.5k in + 2,000 out        ≈ $0.0376
//   storyIdeas    ≤3k input + 900 output                                               ≈ $0.0075
//   storyContinue ≤7k input (synopsis + recent chapters, 24,000 characters) + 3,000 out ≈ $0.0220
//   contentIdeas     ≤2.2k input (idea capped at 4,000 characters) + 900 output        ≈ $0.0067
//   contentDraft     ≤2.5k input + 1,800 output (the largest non-podcast draft)       ≈ $0.0115
//   contentDraftLong ≤2.5k input + 3,600 output (podcast script)                      ≈ $0.0205
//   contentDraftVerified  draft (as contentDraft) + an independent solve ≤1.5k in + 400 out ≈ $0.0150
//   bookConcepts     ≤2.5k input + 3,000 output (3 concepts, ≤12-page plans, identity) ≈ $0.0175
//   bookPagesShort   ≤4k input (plan, identity, memory) + 1,200 output (4 short pages)   ≈ $0.0100
//   bookPagesLong    ≤4k input + 3,800 output (4 pages of ≤380 words; measured 2,987)    ≈ $0.0230
//   videoPlan        ≤8k input (storyline + the 50-sound/voice/theme catalog) + 4,000 output (≤12 shots with
//                    sound & light plan; measured 1.7k in / 1.2k out for 4 shots on 2026-11-23) ≈ $0.0280
//   videoPlanWithReference  + 3 video frames read (≈4.8k input)                           ≈ $0.0328
//   videoRender      Cloudinary splice (measured 4 s for 2 clips; plan quota, not per call) ≈ $0.0100 budget
//   sfxPerSecond     Mirelo SFX 1.5, measured $0.01 a second (2 s $0.02, 10 s $0.10, a 5 s clip $0.05)
//   voiceLine        Fish Audio S2.1 pro, ≤400 characters ≈ 27 s at $0.0135 a minute (measured $0.0014 a line) ≈ $0.0061
//   episodeBreakdown     ≤12k input (script ≤30k chars + catalog) + 8,000 output                ≈ $0.0520
//   episodeBreakdownLong ≤12k input + 16,000 output (up to 60 shots)                           ≈ $0.0920
//   keyframe         FLUX.2 [pro] with references $0.075 + Haiku vision check (≤4 pictures) ≈ $0.0075 ≈ $0.0825
//   stillMotion      Cloudinary zoompan + upload (plan quota)                                  ≈ $0.0050 budget
//   episodeRender    several Cloudinary splices + cards (plan quota)                           ≈ $0.0200 budget
//   episodeLedger    ≤6k input + 2,000 output                                                  ≈ $0.0160
//   songPerMinute    ACE-Step 1.5 XL turbo, measured $0.00225 per 60 s song               ≈ $0.0023
export const ACTION_COST_USD = {
  research: { fast: 0.0065, premium: 0.0065 },
  translate: { fast: 0.0062, premium: 0.0062 },
  writing: { fast: 0.0045, premium: 0.0045 },
  search: { fast: 0.0112, premium: 0.0112 },
  image: { fast: 0.0006, premium: 0.045, premiumWithReference: 0.075 },
  video: { fast: 0.30, premium: 0.80, premiumWithReference: 0.80 },
  narrationPerMinute: { fast: 0.015, premium: 0.015 },
  storyPlan: { fast: 0.0252, premium: 0.0252 },
  storyChapter: { fast: 0.0376, premium: 0.0376 },
  storyIdeas: { fast: 0.0075, premium: 0.0075 },
  storyContinue: { fast: 0.0220, premium: 0.0220 },
  contentIdeas: { fast: 0.0067, premium: 0.0067 },
  contentDraft: { fast: 0.0115, premium: 0.0115 },
  contentDraftLong: { fast: 0.0205, premium: 0.0205 },
  contentDraftVerified: { fast: 0.0150, premium: 0.0150 },
  bookConcepts: { fast: 0.0175, premium: 0.0175 },
  bookPagesShort: { fast: 0.0100, premium: 0.0100 },
  bookPagesLong: { fast: 0.0230, premium: 0.0230 },
  videoPlan: { fast: 0.0280, premium: 0.0280 },
  videoPlanWithReference: { fast: 0.0328, premium: 0.0328 },
  videoRender: { fast: 0.0100, premium: 0.0100 },
  songPerMinute: { fast: 0.0023, premium: 0.0023 },
  backgroundRemoval: { fast: 0.01, premium: 0.01 },
  sfxPerSecond: { fast: 0.01, premium: 0.01 },
  episodeBreakdown: { fast: 0.052, premium: 0.052 },
  episodeBreakdownLong: { fast: 0.092, premium: 0.092 },
  keyframe: { fast: 0.0825, premium: 0.0825 },
  stillMotion: { fast: 0.005, premium: 0.005 },
  episodeRender: { fast: 0.02, premium: 0.02 },
  episodeLedger: { fast: 0.016, premium: 0.016 },
  voiceLine: { fast: 0.0061, premium: 0.0061 },
};

// ── Top-ups: extra AI credits, bought with Google Play or wallet balance ─────
// For anyone (Free included) who has used the month's credits. They never
// expire and are spent only after the plan's monthly credits. Each pack is one
// consumable Google Play product (googlePlayProductId, migration 089), created in
// Play Console with the same price; it can also be paid from the wallet. Priced
// ABOVE a subscription's per-credit price (Pro: $9 / 500 = $0.018), so a plan stays the
// better deal, and far above our worst cost per credit even after Google's cut
// of the wallet purchase. scripts/aiPlanEconomics.js checks both.
export const TOPUP_PACKS = {
  ai_topup_60: { id: 'ai_topup_60', credits: 60, priceUsd: 3, googlePlayProductId: 'bom_ai_credits_60' },     // $0.050 a credit
  ai_topup_150: { id: 'ai_topup_150', credits: 150, priceUsd: 7, googlePlayProductId: 'bom_ai_credits_150' },  // $0.047
  ai_topup_400: { id: 'ai_topup_400', credits: 400, priceUsd: 19, googlePlayProductId: 'bom_ai_credits_400' }, // $0.0475
};
export const TOPUP_PACK_BY_PLAY_ID = Object.fromEntries(Object.values(TOPUP_PACKS).filter((p) => p.googlePlayProductId).map((p) => [p.googlePlayProductId, p]));
export const CORRECTION_COST_USD = 0.0011;

// The $1 new-title fee when it's paid with AI credits instead of wallet
// credits (utils/titleFee.js): $1 at the top-up price ($0.05 a credit), so a
// title never costs less in AI credits than those credits sell for.
export const NEW_TITLE_AI_CREDITS = 20;

// Pictures made from reference pictures (FLUX.2 [pro]) cost $0.03 + $0.015 for every
// reference sent — measured 2026-11-23: 0 refs $0.03, 2 → $0.06, 4 → $0.09, 9 → $0.165.
// A shot with a full cast sends up to 9, so these are priced by the number sent, never flat.
export const REF_PRICING = {
  image: { baseUsd: 0.03, perRefUsd: 0.015 },      // Video Studio still preview (Model 1)
  keyframe: { baseUsd: 0.0375, perRefUsd: 0.015 }, // episode keyframe + its continuity check (Haiku vision ≤ $0.0075)
};
export const refCredits = (action, refs) => {
  const r = REF_PRICING[action];
  return Math.ceil((r.baseUsd + r.perRefUsd * Math.max(0, Math.min(9, Math.round(refs)))) / CREDIT_COST_CEILING_USD);
};

export function creditsFor(action, { premium = false, reference = false, seconds = 0, units = 1, refs } = {}) {
  const key = action === 'narration' ? 'narrationPerMinute' : action === 'song' ? 'songPerMinute' : action === 'sfx' ? 'sfxPerSecond' : action;
  const c = ACTION_COSTS[key];
  if (!c) throw new Error(`unknown AI action ${action}`);
  if (premium && refs !== undefined && REF_PRICING[key] && (refs > 0 || key === 'keyframe')) return refCredits(key, refs) * Math.max(1, Math.floor(units) || 1);
  let n = premium ? (reference && c.premiumWithReference ? c.premiumWithReference : c.premium) : c.fast;
  if (action === 'narration' || action === 'song') n *= Math.max(1, Math.ceil(seconds / 60));
  if (action === 'sfx') n *= Math.max(1, Math.ceil(seconds));
  return n * Math.max(1, Math.floor(units) || 1); // units: e.g. several voice lines at once
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
    videos: p.premiumModels ? Math.floor(p.monthlyCredits / ACTION_COSTS.video[kind]) : 0, // video is subscription-only
    narration_minutes: Math.floor(p.monthlyCredits / ACTION_COSTS.narrationPerMinute[kind]),
  };
}

export const publicPlan = (p) => ({
  id: p.id, name: p.name, price_usd: p.priceUsd, monthly_credits: p.monthlyCredits,
  google_play_product_id: p.googlePlayProductId, base_plan_id: p.googlePlayProductId ? AI_BASE_PLAN_ID : null,
  premium_models: p.premiumModels, corrections_per_day: p.correctionsPerDay, examples: planExamples(p),
  action_costs: Object.fromEntries(Object.entries(ACTION_COSTS).map(([k, v]) => [k, p.premiumModels ? v.premium : v.fast])),
});
