// Backend/config/aiModels.js
// Single source of truth for which Runware model powers each Bascardo AI
// feature/tier, shared by runwareRoutes.js (image/video) and voiceRoutes.js
// (voice). Each default is overridable per-field via its own env var so a
// retired/404'd model can be swapped without a code change.
//
// Every default below was verified live against Runware's own docs
// (runware.ai/docs/models) on 2026-07-18 -- not guessed. See the comment
// blocks in runwareRoutes.js / voiceRoutes.js for why each specific model was
// picked (e.g. why Qwen3-TTS Base was deliberately NOT used for voice/FREE).
// Models Runware has retired or announced for retirement (notice of
// 2026-11-20). A server setting (env var) that still names one is ignored, and
// the working default below is used instead, so a forgotten Render setting
// can't break a feature on the retirement day. Add new notices here.
export const RETIRED_MODELS = {
  'openai:4@1': '2026-12-01',                     // GPT Image 1.5  → openai:gpt-image@2.6-sunburst
  'openai:1@2': '2026-12-01',                     // GPT Image 1 Mini → openai:gpt-image@2.6-flare
  'google:gemini@omni-flash-1.1': '2026-12-03',   // → google:gemini@omni-flash-1.2
  'openai:gpt@5-mini': '2026-12-11',              // → openai:gpt@5.4-mini
  'openai:gpt@5-nano': '2026-12-11',              // → openai:gpt@6-luna (chat-completions endpoint)
  'google:gemini@3.1-flash-tts': '2026-12-18',    // → Fish Audio S2.1 Pro (already our voice)
  'openai:gpt-image@2': '2027-02-10',             // → openai:gpt-image@2.6-*
  'openai:gpt@5.4-nano': '2027-04-01',            // → openai:gpt@6-luna
};

function pick(envName, fallback) {
  const v = process.env[envName];
  if (!v) return fallback;
  if (RETIRED_MODELS[v]) {
    console.warn(`[ai models] ${envName}=${v} is retired by Runware (${RETIRED_MODELS[v]}); using ${fallback}. Remove ${envName} from the server settings.`);
    return fallback;
  }
  return v;
}

export const AI_MODELS = {
  IMAGE: {
    FREE: pick('RUNWARE_IMAGE_FREE_MODEL', 'runware:z-image@turbo'),
    PREMIUM: pick('RUNWARE_IMAGE_HD_MODEL', 'bfl:5@1'), // FLUX.2 [pro]
    // FLUX Redux is the Runware model specifically designed for reference-
    // image-conditioned generation (referenceImages). It preserves the
    // reference's identity/style much more strongly than seedImage img2img.
    // Docs confirmed: referenceImages param + this model = identity/style
    // preservation. IMPORTANT (2026-08-19): Runware now validates the `model`
    // field against *AIR identifiers* (provider:model@version), NOT raw
    // display names like 'civitai:flux1-redux@dev' -- anything else fails
    // with "Invalid value for 'model' parameter. Model must be a string value
    // representing a valid AR identifier." The current docs explicitly use
    // `runware:400@1` as the valid AIR reference-model id. Override via
    // RUNWARE_IMAGE_REFERENCE_MODEL if your dashboard uses a different id.
    REFERENCE: pick('RUNWARE_IMAGE_REFERENCE_MODEL', 'runware:400@1'),
  },
  VIDEO: {
    // 'alibaba:wan@2.6-flash' was never a real Runware model id -- confirmed
    // live 2026-08-06 (see runwareRoutes.js's buildVideoTask comment): any
    // videoInference request naming it failed with a generic, misleading
    // "Invalid type for 'inputs'. 'inputs' must be an object" error instead
    // of a clear "model not found", because Runware can't validate a request
    // against an unrecognized model's actual schema. Replaced with the
    // '-fast' (cheap/quick) sibling of the already-correct PREMIUM model --
    // same vendor family, verified live via Runware's modelSearch API.
    FREE: pick('RUNWARE_VIDEO_FREE_MODEL', 'bytedance:seedance@2.0-fast'),
    PREMIUM: pick('RUNWARE_VIDEO_HD_MODEL', 'bytedance:seedance@2.0'),
  },
  VOICE: {
    // 2026-11-20, measured on Runware: Gemini 3.1 Flash TTS cost $0.034-0.061 a
    // minute, Fish Audio S2.1 Pro $0.0135 a minute. The "free" voice was both
    // worse and 3-4x dearer, so every plan now uses Fish Audio.
    FREE: pick('RUNWARE_VOICE_FREE_MODEL', 'fishaudio:s2.1@pro'),
    PREMIUM: pick('RUNWARE_VOICE_HD_MODEL', 'fishaudio:s2.1@pro'),
  },
};

// Preset voice ids -- only relevant for VOICE, kept alongside the model map
// since a voice id is meaningless without knowing which model it belongs to.
export const AI_VOICE_PRESETS = {
  FREE: (RETIRED_MODELS[process.env.RUNWARE_VOICE_FREE_MODEL] ? null : process.env.RUNWARE_VOICE_FREE_PRESET) || '98655a12fa944e26b274c535e5e03842', // same Fish Audio preset as premium
  PREMIUM: process.env.RUNWARE_VOICE_HD_PRESET || '98655a12fa944e26b274c535e5e03842', // Fish Audio preset "Egirl"
};
