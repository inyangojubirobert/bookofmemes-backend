import express from 'express';
import crypto from 'crypto';
import { v2 as cloudinary } from 'cloudinary';
import { supabase } from '../config/db.js';
import { authenticateToken } from '../auth.js';
import { isPremium } from '../utils/isPremium.js';
import { userScopedClient, tokenFromRequest } from '../utils/supabaseUserClient.js';
import { monthlyUsage, recordMonthlyUsage } from '../utils/monthlyQuota.js';
import { logGeneration } from '../utils/aiGenerationLog.js';
import { AI_MODELS } from '../config/aiModels.js';

/*
  "Generate Bascardo AI Content" — Runware-backed image + video generation.

  Setup: Backend/.env already has RUNWARE_API_KEY. Model ids live in
  Backend/config/aiModels.js (single source of truth, shared with
  voiceRoutes.js) -- override any of them via their RUNWARE_*_MODEL env var
  if a default ever 404s or gets retired (browse models at
  https://runware.ai/docs/models).

  Free vs. premium/HD model selection (2026-07-18): free-tier requests use
  fast/cheap first-party models so the free monthly allowance stays generous
  and affordable at scale; premium subscribers AND explicit HD (token-paid)
  requests get routed to flagship, higher-quality models -- same "premium OR
  hd" rule the watermark logic below already used, just extended to model
  choice too. All four model ids (image free/hd, video free/hd) were verified
  live against Runware's own docs on 2026-07-18 -- not guessed. Exact
  per-generation cost isn't published as a flat rate (Runware bills
  serverless models by compute, fixed-price models per provider agreement),
  so double-check real cost in the Runware dashboard/playground before tuning
  the free monthly caps below.

  Video generation is async on Runware's side (deliveryMethod: async +
  getResponse polling, per their docs) -- exact request field names beyond
  taskType/taskUUID/model/positivePrompt/width/height (duration, fps) were not
  independently verifiable at time of writing; if Runware rejects a video
  request with a field-validation error, adjust the field names in
  buildVideoTask() below to match the message.

  Free-tier caps reset MONTHLY (backed by migrations/021_ai_usage_monthly.sql
  via Backend/utils/monthlyQuota.js), not daily -- images/video cost real
  provider money per generation, so at scale a daily free allowance is far
  more expensive than a monthly one. Requires that migration to be applied.
*/

const router = express.Router();

const RUNWARE_API_URL = 'https://api.runware.ai/v1';
const RUNWARE_API_KEY = process.env.RUNWARE_API_KEY;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Free previews are low-res/short and capped per MONTH (not per day -- images
// and video cost real money per generation, so the free allowance has to
// stay small at scale: e.g. 10k free users x 5 images/month is a bounded
// bill, x 5 images/day is not). HD spends Bascardo Tokens instead of
// counting against either cap, so a user who blows through their monthly
// free allowance can still pay per-generation rather than being hard-blocked.
const IMAGE_FREE_MONTHLY_LIMIT = 5;
const IMAGE_PREMIUM_MONTHLY_LIMIT = 100;
const IMAGE_HD_COST_TOKENS = 15; // 100 BASC = $1 (tokenRoutes.js pack_100), so 15 BASC ~= $0.15/HD image

const VIDEO_FREE_MONTHLY_LIMIT = 1;
const VIDEO_PREMIUM_MONTHLY_LIMIT = 20;
const VIDEO_FREE_DURATION_SECONDS = 5;
const VIDEO_HD_COST_TOKENS = 60; // video generation runs far more than images provider-side -- priced accordingly

// Returns { data, status } -- status is the raw HTTP status Runware
// responded with, carried through so callers can log it even on success (not
// just failure), e.g. to later ask "which model gets 200s slower than others."
// On failure, the thrown Error carries the same status as `.providerHttpStatus`
// so route handlers can still log it from their catch block.
async function callRunwareTasks(tasks) {
  const response = await fetch(RUNWARE_API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${RUNWARE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(tasks),
  });
  const json = await response.json().catch(() => null);
  if (!response.ok || json?.errors?.length) {
    const err = new Error(json?.errors?.[0]?.message || `Runware request failed (${response.status})`);
    err.providerHttpStatus = response.status;
    throw err;
  }
  return { data: json?.data || [], status: response.status };
}

async function generateImage(prompt, { hd, premium }) {
  const useHdModel = hd || premium;
  const task = {
    taskType: 'imageInference',
    taskUUID: crypto.randomUUID(),
    positivePrompt: prompt,
    model: useHdModel ? AI_MODELS.IMAGE.PREMIUM : AI_MODELS.IMAGE.FREE,
    width: hd ? 1024 : 512,
    height: hd ? 1024 : 512,
    numberResults: 1,
    outputFormat: 'JPG',
    includeCost: true,
  };
  const startedAt = Date.now();
  const { data, status } = await callRunwareTasks([task]);
  const latencyMs = Date.now() - startedAt;
  const [result] = data;
  if (!result?.imageURL) throw new Error('Runware returned no image');
  return {
    imageUrl: result.imageURL,
    taskUUID: task.taskUUID,
    modelUsed: task.model,
    latencyMs,
    providerCost: result.cost ?? null,
    providerHttpStatus: status,
  };
}

function buildVideoTask(prompt, { hd, premium }) {
  const useHdModel = hd || premium;
  return {
    taskType: 'videoInference',
    taskUUID: crypto.randomUUID(),
    positivePrompt: prompt,
    model: useHdModel ? AI_MODELS.VIDEO.PREMIUM : AI_MODELS.VIDEO.FREE,
    // 864x496 (not the old 854x480) and 1280x720 are both confirmed-valid
    // resolutions for the seedance/seedance-fast model family (verified live
    // 2026-08-06) -- 854x480 isn't an allowed resolution for either model,
    // so this would have 400'd for premium (non-HD) users too, not only free
    // ones, once the model-id bug above stopped masking it.
    width: hd ? 1280 : 864,
    height: hd ? 720 : 496,
    duration: VIDEO_FREE_DURATION_SECONDS,
    numberResults: 1,
    deliveryMethod: 'async',
    includeCost: true,
  };
}

// Returns { result, status } -- status is the HTTP status of the getResponse
// poll call that finally resolved (success/error), for the same "which model
// gets rate-limited" telemetry callRunwareTasks already exposes.
async function pollForResult(taskUUID, { intervalMs = 3000, timeoutMs = 120000 } = {}) {
  const startedAt = Date.now();
  let delay = intervalMs;
  while (Date.now() - startedAt < timeoutMs) {
    await new Promise((r) => setTimeout(r, delay));
    const { data, status } = await callRunwareTasks([{ taskType: 'getResponse', taskUUID }]);
    const [result] = data;
    if (result?.status === 'success') return { result, status };
    if (result?.status === 'error') throw new Error(result?.errorMessage || 'Video generation failed');
    delay = Math.min(delay * 1.3, 8000); // gentle backoff, per Runware's own guidance
  }
  throw new Error('Video generation timed out. Please try again.');
}

async function generateVideo(prompt, { hd, premium }) {
  const task = buildVideoTask(prompt, { hd, premium });
  const startedAt = Date.now();
  const { data: queuedData, status: submitStatus } = await callRunwareTasks([task]);
  const [queued] = queuedData;
  const taskUUID = queued?.taskUUID || task.taskUUID;
  // Latency spans submit -> final poll result, since that's the actual
  // user-facing wait -- not just the initial (near-instant) queueing call.
  const { result, status: pollStatus } = await pollForResult(taskUUID);
  const latencyMs = Date.now() - startedAt;
  if (!result?.videoURL) throw new Error('Runware returned no video');
  return {
    videoUrl: result.videoURL,
    taskUUID,
    modelUsed: task.model,
    latencyMs,
    providerCost: result.cost ?? null,
    providerHttpStatus: pollStatus ?? submitStatus,
  };
}

// Watermark = the Bascardo coin logo + "Bascardo Ai Token" text, baked onto
// free-tier images/video via Cloudinary (already configured for uploads
// elsewhere -- see uploadRoutes.js) instead of running our own ffmpeg/sharp
// pipeline. Cloudinary can ingest remote URLs directly, so neither the logo
// nor the Runware output ever has to pass through our server.
const WATERMARK_LOGO_URL = 'https://res.cloudinary.com/dljcj00ht/image/upload/v1756325607/BAscardoCoin_Logo_bvq8tx.png';
// Flat (no subfolders) on purpose -- a nested public_id like
// 'bookofmemes/watermark/bascardo_coin_logo' broke every watermarked
// generation with a 400 from Cloudinary ("Invalid transformation parameter -
// bascardo"). The Node SDK's overlay/underlay public_id escaping only
// converts the FIRST '/' in a public_id to ':' (the syntax an overlay layer
// needs), not every '/' -- with two levels of nesting, the second slash was
// left literal and Cloudinary's URL parser read it as the start of a new
// transformation component, corrupting the whole chain. Confirmed live by
// fetching the actual failing URL and reading Cloudinary's x-cld-error
// header directly. A single-segment public_id has no slash left to mis-escape.
const WATERMARK_LOGO_PUBLIC_ID = 'bascardo_watermark_logo';

// Idempotent: Cloudinary treats an upload with an explicit public_id and
// overwrite:false as "return the existing asset if there is one", so this is
// cheap to call on every watermark request rather than needing a one-time
// setup step.
async function ensureWatermarkLogoUploaded() {
  const uploaded = await cloudinary.uploader.upload(WATERMARK_LOGO_URL, {
    public_id: WATERMARK_LOGO_PUBLIC_ID,
    overwrite: false,
  });
  return uploaded.public_id;
}

function watermarkLayers(logoPublicId, { logoWidth, fontSize, logoY, textY }) {
  return [
    { overlay: { public_id: logoPublicId }, gravity: 'south_east', x: 16, y: logoY, width: logoWidth, opacity: 90 },
    { overlay: { font_family: 'Arial', font_weight: 'bold', font_size: fontSize, text: 'Bascardo Ai Token' }, gravity: 'south_east', x: 16, y: textY, opacity: 90, color: 'white' },
  ];
}

async function watermarkVideo(remoteVideoUrl) {
  const [logoPublicId, uploaded] = await Promise.all([
    ensureWatermarkLogoUploaded(),
    cloudinary.uploader.upload(remoteVideoUrl, { resource_type: 'video', folder: 'bookofmemes/ai-generated' }),
  ]);
  return cloudinary.url(uploaded.public_id, {
    resource_type: 'video',
    transformation: watermarkLayers(logoPublicId, { logoWidth: 60, fontSize: 28, logoY: 16, textY: 84 }),
  });
}

async function watermarkImage(remoteImageUrl) {
  const [logoPublicId, uploaded] = await Promise.all([
    ensureWatermarkLogoUploaded(),
    cloudinary.uploader.upload(remoteImageUrl, { resource_type: 'image', folder: 'bookofmemes/ai-generated' }),
  ]);
  return cloudinary.url(uploaded.public_id, {
    transformation: watermarkLayers(logoPublicId, { logoWidth: 48, fontSize: 22, logoY: 16, textY: 70 }),
  });
}

// ── Images ──────────────────────────────────────────────────────────────

router.get('/quota', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const premium = await isPremium(userId);
    const imageLimit = premium ? IMAGE_PREMIUM_MONTHLY_LIMIT : IMAGE_FREE_MONTHLY_LIMIT;
    const videoLimit = premium ? VIDEO_PREMIUM_MONTHLY_LIMIT : VIDEO_FREE_MONTHLY_LIMIT;
    const [imageUsed, videoUsed] = await Promise.all([monthlyUsage(userId, 'image'), monthlyUsage(userId, 'video')]);
    res.json({
      success: true,
      data: {
        premium,
        image: { limit: imageLimit, remaining: Math.max(0, imageLimit - imageUsed), hdCostTokens: IMAGE_HD_COST_TOKENS, watermarkFree: premium, period: 'month' },
        video: { limit: videoLimit, remaining: Math.max(0, videoLimit - videoUsed), hdCostTokens: VIDEO_HD_COST_TOKENS, durationSeconds: VIDEO_FREE_DURATION_SECONDS, watermarkFree: premium, period: 'month' },
      },
    });
  } catch (err) {
    console.error('Runware quota error:', err);
    res.status(500).json({ success: false, error: 'Failed to load quota' });
  }
});

// POST /api/ai/runware/image  Body: { prompt: string, hd?: boolean }
// Free (non-premium): watermarked. Premium or HD: watermark skipped, same
// perk structure as video.
router.post('/image', authenticateToken, async (req, res) => {
  const prompt = req.body?.prompt;
  const hd = !!req.body?.hd;
  if (!prompt?.trim()) return res.status(400).json({ success: false, error: 'A prompt is required' });
  if (prompt.length > 1000) return res.status(400).json({ success: false, error: 'Prompt too long (max 1000 characters)' });
  if (!RUNWARE_API_KEY) return res.status(500).json({ success: false, error: 'AI image generation is not configured' });

  const userId = req.user.id;
  const genStartedAt = Date.now(); // fallback latency source if generateImage() itself is never reached

  try {
    const premium = await isPremium(userId);

    if (hd) {
      const { data: wallet } = await supabase.from('wallets').select('token_balance').eq('user_id', userId).single();
      if ((wallet?.token_balance || 0) < IMAGE_HD_COST_TOKENS) {
        return res.status(402).json({ success: false, error: `HD generation costs ${IMAGE_HD_COST_TOKENS} Bascardo Tokens. Top up your balance and try again.` });
      }
    } else {
      const limit = premium ? IMAGE_PREMIUM_MONTHLY_LIMIT : IMAGE_FREE_MONTHLY_LIMIT;
      if ((await monthlyUsage(userId, 'image')) >= limit) {
        return res.status(429).json({ success: false, error: `Free monthly limit of ${limit} images reached. Try HD (spends Bascardo Tokens) or wait for next month.` });
      }
    }

    const { imageUrl: rawImageUrl, taskUUID, modelUsed, latencyMs, providerCost, providerHttpStatus } = await generateImage(prompt.trim(), { hd, premium });
    const skipWatermark = hd || premium;
    const imageUrl = skipWatermark ? rawImageUrl : await watermarkImage(rawImageUrl);
    let charged = false;

    if (hd) {
      const { data: chargeRows, error: chargeError } = await userScopedClient(tokenFromRequest(req)).rpc('spend_tokens', {
        p_amount: IMAGE_HD_COST_TOKENS,
        p_description: 'Bascardo AI Content — HD image',
      });
      if (chargeError) throw chargeError;
      charged = !!chargeRows?.[0]?.success;
    } else {
      await recordMonthlyUsage(userId, 'image');
    }

    logGeneration({ userId, feature: 'image', model: modelUsed, provider: 'runware', requestId: taskUUID, inputPrompt: prompt.trim(), tier: hd ? 'hd' : (premium ? 'premium_free' : 'free'), costTokens: charged ? IMAGE_HD_COST_TOKENS : 0, success: true, outputUrl: imageUrl, latencyMs, providerCost, providerHttpStatus });
    res.json({ success: true, data: { imageUrl, hd, charged, watermarked: !skipWatermark } });
  } catch (err) {
    console.error('Runware image generate error:', err);
    logGeneration({ userId, feature: 'image', model: hd ? AI_MODELS.IMAGE.PREMIUM : AI_MODELS.IMAGE.FREE, provider: 'runware', inputPrompt: prompt.trim(), tier: hd ? 'hd' : 'free', success: false, errorMessage: err.message, latencyMs: Date.now() - genStartedAt, providerHttpStatus: err.providerHttpStatus ?? null });
    res.status(500).json({ success: false, error: err.message || 'AI image generation failed' });
  }
});

// ── Video ───────────────────────────────────────────────────────────────

// POST /api/ai/runware/video  Body: { prompt: string, hd?: boolean }
// Free (non-premium): 5s, watermarked, counts against the monthly cap.
// Premium: watermark removed automatically, regardless of hd. HD: no
// watermark, higher-res, costs VIDEO_HD_COST_TOKENS Bascardo Tokens and
// never touches the monthly cap either way.
router.post('/video', authenticateToken, async (req, res) => {
  const prompt = req.body?.prompt;
  const hd = !!req.body?.hd;
  if (!prompt?.trim()) return res.status(400).json({ success: false, error: 'A prompt is required' });
  if (prompt.length > 1000) return res.status(400).json({ success: false, error: 'Prompt too long (max 1000 characters)' });
  if (!RUNWARE_API_KEY) return res.status(500).json({ success: false, error: 'AI video generation is not configured' });

  const userId = req.user.id;
  const genStartedAt = Date.now(); // fallback latency source if generateVideo() itself is never reached

  try {
    const premium = await isPremium(userId);

    if (hd) {
      const { data: wallet } = await supabase.from('wallets').select('token_balance').eq('user_id', userId).single();
      if ((wallet?.token_balance || 0) < VIDEO_HD_COST_TOKENS) {
        return res.status(402).json({ success: false, error: `HD video costs ${VIDEO_HD_COST_TOKENS} Bascardo Tokens. Top up your balance and try again.` });
      }
    } else {
      const limit = premium ? VIDEO_PREMIUM_MONTHLY_LIMIT : VIDEO_FREE_MONTHLY_LIMIT;
      if ((await monthlyUsage(userId, 'video')) >= limit) {
        return res.status(429).json({ success: false, error: `Free monthly limit of ${limit} video${limit === 1 ? '' : 's'} reached. Try HD (spends Bascardo Tokens) or wait for next month.` });
      }
    }

    const { videoUrl: rawVideoUrl, taskUUID, modelUsed, latencyMs, providerCost, providerHttpStatus } = await generateVideo(prompt.trim(), { hd, premium });
    const skipWatermark = hd || premium; // Premium's plan perk: no watermark even on the free monthly allowance
    const videoUrl = skipWatermark ? rawVideoUrl : await watermarkVideo(rawVideoUrl);
    let charged = false;

    if (hd) {
      const { data: chargeRows, error: chargeError } = await userScopedClient(tokenFromRequest(req)).rpc('spend_tokens', {
        p_amount: VIDEO_HD_COST_TOKENS,
        p_description: 'Bascardo AI Content — HD video',
      });
      if (chargeError) throw chargeError;
      charged = !!chargeRows?.[0]?.success;
    } else {
      await recordMonthlyUsage(userId, 'video');
    }

    logGeneration({ userId, feature: 'video', model: modelUsed, provider: 'runware', requestId: taskUUID, inputPrompt: prompt.trim(), durationSeconds: VIDEO_FREE_DURATION_SECONDS, tier: hd ? 'hd' : (premium ? 'premium_free' : 'free'), costTokens: charged ? VIDEO_HD_COST_TOKENS : 0, success: true, outputUrl: videoUrl, latencyMs, providerCost, providerHttpStatus });
    res.json({ success: true, data: { videoUrl, hd, charged, watermarked: !skipWatermark } });
  } catch (err) {
    console.error('Runware video generate error:', err);
    logGeneration({ userId, feature: 'video', model: hd ? AI_MODELS.VIDEO.PREMIUM : AI_MODELS.VIDEO.FREE, provider: 'runware', inputPrompt: prompt.trim(), tier: hd ? 'hd' : 'free', success: false, errorMessage: err.message, latencyMs: Date.now() - genStartedAt, providerHttpStatus: err.providerHttpStatus ?? null });
    res.status(500).json({ success: false, error: err.message || 'AI video generation failed' });
  }
});

export default router;
