// What each media model can really do and what it really costs: measured
// with real calls, not taken from price lists. This is the source of truth
// for planning (how long a clip is, so how many shots a video needs) and for
// pricing (config/aiPlans.js credits must cover realCostUsd).
//
// Re-measure with `node --env-file=.env scripts/measureMedia.js` when a model
// changes. Every entry carries the date it was verified. Licence notes are
// what we know, not legal advice: a model is marked commercialUse 'unverified'
// until its terms have been read.
export const MEDIA_CAPABILITIES = {
  video: {
    'bytedance:seedance@2.0-fast': {
      label: 'Seedance 2.0 fast', status: 'in_use', tier: 'standard',
      clipSeconds: { used: 5, min: null, max: null }, sizes: ['864x496', '1280x720'],
      startPicture: true, endPicture: 'unverified', referenceVideo: 'unverified',
      realCostUsd: { per5s: 0.304 }, waitSeconds: 74, verified: '2026-11-20',
    },
    'bytedance:seedance@2.0': {
      label: 'Seedance 2.0', status: 'in_use', tier: 'premium',
      clipSeconds: { used: 5, min: null, max: null }, sizes: ['1280x720'],
      startPicture: true, endPicture: 'unverified', referenceVideo: 'unverified',
      realCostUsd: { per5s: 0.80 }, costSource: 'Runware price list (not yet measured)', waitSeconds: null, verified: null,
    },
    'bytedance:seedance@2.0-mini': {
      label: 'Seedance 2.0 mini', status: 'candidate', tier: 'standard',
      clipSeconds: { min: 4, max: 15 }, sizes: ['864x496'],
      startPicture: 'unverified', endPicture: 'unverified', referenceVideo: 'unverified',
      realCostUsd: { perSecond: 0.038, per5s: 0.190 }, waitSeconds: 74, verified: '2026-11-20',
    },
    'lightricks:ltx@2.3-fast': {
      label: 'LTX 2.3 fast', status: 'candidate', tier: 'standard',
      clipSeconds: { tested: 6, actual: 5.8 }, sizes: ['768x448'], sizeRule: 'height a multiple of 64',
      startPicture: 'unverified', endPicture: 'unverified', referenceVideo: 'unverified',
      realCostUsd: { per6s: 0.18 }, waitSeconds: 32, verified: '2026-11-20',
    },
    'runware:201@1': {
      label: 'Runware video', status: 'candidate', tier: 'standard',
      clipSeconds: { tested: 5 }, sizes: ['832x480', '480x832', '624x624', '1280x720', '720x1280', '960x960'],
      realCostUsd: { per5s: 0.227 }, waitSeconds: 80, verified: '2026-11-20',
    },
  },
  music: {
    'runware:ace-step@v1.5-xl-turbo': {
      label: 'ACE-Step 1.5 XL turbo', status: 'candidate',
      lyrics: 'settings.lyrics', durationParam: true, tested: { requested: 60, actual: 60.0 },
      realCostUsd: { per60s: 0.00225 }, waitSeconds: 20,
      commercialUse: 'unverified (open-source model; read its licence before launch)', verified: '2026-11-20',
      sample: 'https://res.cloudinary.com/dljcj00ht/video/upload/v1795204234/bookofmemes/phase0/xrsg7ayxgi70z1z6cax0.mp3',
    },
    'runware:ace-step@v1.5-turbo': {
      label: 'ACE-Step 1.5 turbo', status: 'candidate',
      lyrics: 'settings.lyrics', durationParam: true, tested: { requested: 60 },
      realCostUsd: { per60s: 0.00225 }, waitSeconds: 23, commercialUse: 'unverified', verified: '2026-11-20',
    },
    'minimax:music@2.6': {
      label: 'MiniMax Music 2.6', status: 'candidate',
      lyrics: 'settings.lyrics (≤3,500 chars)', durationParam: false, tested: { actual: 37.9 },
      realCostUsd: { perSong: 0.15 }, waitSeconds: 71, commercialUse: 'unverified (not stated on Runware)', verified: '2026-11-20',
      sample: 'https://res.cloudinary.com/dljcj00ht/video/upload/v1795204227/bookofmemes/phase0/kyw78elmltewr8oxsdfj.mp3',
    },
  },
  voice: {
    'fishaudio:s2.1@pro': { label: 'Fish Audio S2.1 Pro', status: 'in_use', maxCharsPerCall: 1200, realCostUsd: { perMinute: 0.0135 }, verified: '2026-11-20' },
    'google:gemini@3.1-flash-tts': { label: 'Gemini 3.1 Flash TTS', status: 'retired', retiredByRunware: '2026-12-18', realCostUsd: { perMinute: [0.034, 0.061] }, verified: '2026-11-20' },
  },
  merge: {
    cloudinary_splice: {
      label: 'Cloudinary video splice', status: 'candidate',
      tested: { clips: 2, inputSeconds: [5.09, 5.8], outputSeconds: 10.87, renderSeconds: 4, mixedSizes: true },
      note: 'Clips are scaled to one size before joining. Long timelines and audio mixing not yet tested.', verified: '2026-11-20',
    },
  },
};

// Planning helper: how many shots a finished video of `seconds` needs with this model.
export function shotsFor(seconds, modelId) {
  const m = MEDIA_CAPABILITIES.video[modelId];
  const clip = m?.clipSeconds?.used || m?.clipSeconds?.tested || m?.clipSeconds?.min;
  if (!clip) throw new Error(`clip length of ${modelId} is not measured`);
  return Math.ceil(seconds / clip);
}
