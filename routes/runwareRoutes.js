import express from 'express';
import crypto from 'crypto';
import { v2 as cloudinary } from 'cloudinary';
import { supabase } from '../config/db.js';
import { authenticateToken } from '../auth.js';
import { CREDIT_PRICES, formatCredits, creditsToLogUnits, hasCredits, chargeCredits } from '../utils/credits.js';
import { creditStatus, spendCredits, creditsView, outOfCreditsMessage, reserveCredits, commitCredits, releaseCredits } from '../utils/aiCredits.js';
import { registerJobKind, createJob, waitForJob, publicJob, jobsAvailable } from '../utils/studioJobs.js';
import { creditsFor } from '../config/aiPlans.js';
import { logGeneration } from '../utils/aiGenerationLog.js';
import { saveToGallery } from '../utils/gallery.js';
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
// bill, x 5 images/day is not). HD spends in-app credits instead of
// counting against either cap, so a user who blows through their monthly
// free allowance can still pay per-generation rather than being hard-blocked.
// Monthly image/video allowances per plan: config/aiPlans.js.
const IMAGE_HD_COST = CREDIT_PRICES.imageHd;

const VIDEO_FREE_DURATION_SECONDS = 5;
const VIDEO_HD_COST = CREDIT_PRICES.videoHd; // video runs far more than images provider-side -- priced accordingly
const VIDEO_HD_REFERENCE_COST = CREDIT_PRICES.videoHdWithReference;

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

async function generateImage(prompt, { hd, premium, referenceImageUrl }) {
  // When a reference image is provided, use FLUX Redux -- the Runware model
  // purpose-built for reference-conditioned generation (identity/style
  // preservation). Its task schema uses `referenceImages` (NOT `seedImage`);
  // plain seedImage/img2img only loosely guides composition and does NOT
  // preserve the reference's identity, which is exactly the user complaint
  // this fixes. FLUX Redux is designed for exactly this workflow, so when a
  // reference image is attached, prefer it over the generic free/HD models.
  // But unlike seedImage (which works on any model), referenceImages is only
  // valid on models that support it -- using it on z-image@turbo or bfl:5@1
  // would be a no-op or validation error, hence the dedicated REFERENCE model.
  const model = referenceImageUrl
    ? AI_MODELS.IMAGE.REFERENCE
    : (hd || premium ? AI_MODELS.IMAGE.PREMIUM : AI_MODELS.IMAGE.FREE);
  const task = {
    taskType: 'imageInference',
    taskUUID: crypto.randomUUID(),
    positivePrompt: prompt,
    model,
    width: hd ? 1024 : 512,
    height: hd ? 1024 : 512,
    numberResults: 1,
    outputFormat: 'JPG',
    includeCost: true,
  };

  if (referenceImageUrl) {
    // FLUX Redux's referenceImages array is the documented way to condition
    // on a reference image. Unlike seedImage (which is generic img2img that
    // may barely follow the reference), FLUX Redux is trained specifically to
    // preserve identity/reference. Runware docs confirm the field name is
    // `referenceImages` and it belongs on the imageInference task.
    task.referenceImages = [{ url: referenceImageUrl, type: 'reference' }];
  }

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

function buildVideoTask(prompt, { hd, premium, referenceImageUrl }) {
  const useHdModel = hd || premium;
  const task = {
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

  // seedImage/strength for image-to-video, same mechanism the image route
  // uses (see generateImage above) -- Runware's videoInference accepts a
  // seedImage URL to animate a starting frame. Strength follows the same
  // model-family split as images: FLUX-based models need > 0.8 to show any
  // visible change, others are fine lower.
  if (referenceImageUrl) {
    task.seedImage = referenceImageUrl;
    task.strength = task.model.startsWith('bfl:') ? 0.85 : 0.7;
  }

  return task;
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

async function generateVideo(prompt, { hd, premium, referenceImageUrl }) {
  const task = buildVideoTask(prompt, { hd, premium, referenceImageUrl });
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
    // Two-step chain, not one flat step: a single { overlay, width, ... }
    // object only resizes and places the layer -- it never crops or masks
    // it, so the logo keeps whatever shape its source PNG happens to have.
    // Cropping it into an actual circle needs its own transformation step
    // (square thumb crop + radius:max) before the layer_apply step that
    // composites the now-circular result onto the base image.
    { overlay: { public_id: logoPublicId }, width: logoWidth, height: logoWidth, crop: 'thumb', gravity: 'center', radius: 'max' },
    { flags: 'layer_apply', gravity: 'south_east', x: 16, y: logoY, opacity: 90 },
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
const status = await creditStatus(userId);
    const premium = status.plan.premiumModels;
    const image = creditsView(status, 'image');
    const video = creditsView(status, 'video');
    res.json({
      success: true,
      data: {
        premium,
        plan: status.plan.id,
        planName: status.plan.name,
        credits: image.credits,
        image: { limit: Math.floor(status.limit / image.creditCost), remaining: image.remaining, creditCost: image.creditCost, creditCostWithReference: creditsFor('image', { premium, reference: true }), hdCostCredits: IMAGE_HD_COST, watermarkFree: premium, period: 'month' },
        video: { available: premium, needsPlan: !premium, limit: premium ? Math.floor(status.limit / video.creditCost) : 0, remaining: video.remaining, creditCost: video.creditCost, creditCostWithReference: creditsFor('video', { premium, reference: true }), hdCostCredits: VIDEO_HD_COST, hdCostCreditsWithReference: VIDEO_HD_REFERENCE_COST, durationSeconds: VIDEO_FREE_DURATION_SECONDS, watermarkFree: premium, period: 'month' },
      },
    });
  } catch (err) {
    console.error('Runware quota error:', err);
    res.status(500).json({ success: false, error: 'Failed to load quota' });
  }
});

// POST /api/ai/runware/image  Body: { prompt: string, hd?: boolean, referenceImageUrl?: string }
// Free (non-premium): watermarked. Premium or HD: watermark skipped, same
// perk structure as video. referenceImageUrl must already be a public HTTPS
// URL (the client uploads it via /api/upload/message-media first, same
// Cloudinary pipeline chat attachments use) -- Runware's referenceImages
// (FLUX Redux) / seedImage (generic img2img) both accept a URL directly,
// no need to proxy the bytes through this server.
router.post('/image', authenticateToken, async (req, res) => {
  const prompt = req.body?.prompt;
  const hd = !!req.body?.hd;
  const referenceImageUrl = req.body?.referenceImageUrl || null;
  if (!prompt?.trim()) return res.status(400).json({ success: false, error: 'A prompt is required' });
  if (prompt.length > 1000) return res.status(400).json({ success: false, error: 'Prompt too long (max 1000 characters)' });
  if (referenceImageUrl && !/^https:\/\//.test(referenceImageUrl)) {
    return res.status(400).json({ success: false, error: 'referenceImageUrl must be a public HTTPS URL' });
  }
  if (!RUNWARE_API_KEY) return res.status(500).json({ success: false, error: 'AI image generation is not configured' });

  const userId = req.user.id;
  const genStartedAt = Date.now(); // fallback latency source if generateImage() itself is never reached
  let reservation = null;

  try {
const status = await creditStatus(userId);
    const premium = status.plan.premiumModels;
    const cost = creditsFor('image', { premium, reference: !!referenceImageUrl });

    if (hd) {
      if (!(await hasCredits(userId, IMAGE_HD_COST))) {
        return res.status(402).json({ success: false, error: `HD generation costs ${formatCredits(IMAGE_HD_COST)} in credits. Buy credits in your Wallet and try again.` });
      }
    } else {
      // Held atomically before the provider is called (migration 073).
      reservation = status.remaining >= cost ? await reserveCredits(userId, status.plan, cost) : null;
      if (!reservation) {
        return res.status(429).json({ success: false, error: outOfCreditsMessage(status, cost, ' Try HD (paid with wallet credits) or wait for next month.') });
      }
    }

    const { imageUrl: rawImageUrl, taskUUID, modelUsed, latencyMs, providerCost, providerHttpStatus } = await generateImage(prompt.trim(), { hd, premium, referenceImageUrl });
    const skipWatermark = hd || premium;
    const imageUrl = skipWatermark ? rawImageUrl : await watermarkImage(rawImageUrl);
    let charged = false;

    if (hd) {
      charged = await chargeCredits(req, IMAGE_HD_COST, 'Bascardo AI Content — HD image');
    } else {
      await commitCredits(userId, reservation);
      reservation = null;
    }

    logGeneration({ userId, feature: 'image', model: modelUsed, provider: 'runware', requestId: taskUUID, inputPrompt: prompt.trim(), tier: hd ? 'hd' : (premium ? 'premium_free' : 'free'), costTokens: charged ? creditsToLogUnits(IMAGE_HD_COST) : 0, success: true, outputUrl: imageUrl, latencyMs, providerCost, providerHttpStatus });
    saveToGallery({ userId, kind: 'image', url: imageUrl, feature: 'image', prompt: prompt.trim(), model: modelUsed });
    res.json({ success: true, data: { imageUrl, hd, charged, watermarked: !skipWatermark } });
  } catch (err) {
    await releaseCredits(reservation);
    console.error('Runware image generate error:', err);
    logGeneration({ userId, feature: 'image', model: hd ? AI_MODELS.IMAGE.PREMIUM : AI_MODELS.IMAGE.FREE, provider: 'runware', inputPrompt: prompt.trim(), tier: hd ? 'hd' : 'free', success: false, errorMessage: err.message, latencyMs: Date.now() - genStartedAt, providerHttpStatus: err.providerHttpStatus ?? null });
    res.status(500).json({ success: false, error: err.message || 'AI image generation failed' });
  }
});

// ── Video ───────────────────────────────────────────────────────────────

// POST /api/ai/runware/video  Body: { prompt: string, hd?: boolean, referenceImageUrl?: string }
// Free (non-premium): 5s, watermarked, counts against the monthly cap.
// Premium: watermark removed automatically, regardless of hd. HD: no
// watermark, higher-res, costs VIDEO_HD_COST in credits and
// never touches the monthly cap either way. referenceImageUrl must already
// be a public HTTPS URL (the client uploads it via /api/upload/message-media
// first, same Cloudinary pipeline chat attachments use) -- Runware's
// videoInference seedImage accepts a URL directly to animate a starting
// frame, no need to proxy the bytes through this server.
router.post('/video', authenticateToken, async (req, res) => {
  const prompt = req.body?.prompt;
  const hd = !!req.body?.hd;
  const referenceImageUrl = req.body?.referenceImageUrl || null;
  if (!prompt?.trim()) return res.status(400).json({ success: false, error: 'A prompt is required' });
  if (prompt.length > 1000) return res.status(400).json({ success: false, error: 'Prompt too long (max 1000 characters)' });
  if (referenceImageUrl && !/^https:\/\//.test(referenceImageUrl)) {
    return res.status(400).json({ success: false, error: 'referenceImageUrl must be a public HTTPS URL' });
  }
  if (!RUNWARE_API_KEY) return res.status(500).json({ success: false, error: 'AI video generation is not configured' });

  const userId = req.user.id;
  const genStartedAt = Date.now(); // fallback latency source if generateVideo() itself is never reached
  let reservation = null;

  try {
const status = await creditStatus(userId);
    const premium = status.plan.premiumModels;
    // Video is a subscription feature (owner's decision, 2026-11-20): Free
    // users see what the video engine can do on a plan, rather than a cut-down
    // clip. Neither the monthly pool nor wallet credits unlock it on Free.
    if (!premium) {
      return res.status(403).json({
        success: false, code: 'video_needs_plan',
        error: 'AI video is part of the Bascardo AI Pro and Business plans. Upgrade to make videos with the full video engine.',
      });
    }
    const cost = creditsFor('video', { premium, reference: !!referenceImageUrl });
    const hdCost = referenceImageUrl ? VIDEO_HD_REFERENCE_COST : VIDEO_HD_COST;

    if (hd) {
      if (!(await hasCredits(userId, hdCost))) {
        return res.status(402).json({ success: false, error: `HD video costs ${formatCredits(hdCost)} in credits. Buy credits in your Wallet and try again.` });
      }
    } else {
      reservation = status.remaining >= cost ? await reserveCredits(userId, status.plan, cost, null, 30) : null;
      if (!reservation) {
        return res.status(429).json({ success: false, error: outOfCreditsMessage(status, cost, ' Try HD (paid with wallet credits) or wait for next month.') });
      }
    }

    // As a background job (migration 073): the clip is finished, saved to the
    // Gallery and charged even if the phone disconnects or this server restarts.
    if (jobsAvailable()) {
      const rid = String(req.body?.request_id || '');
      const projectKind = typeof req.body?.project_kind === 'string' ? req.body.project_kind.slice(0, 20) : null;
      const projectId = /^[0-9a-f-]{36}$/i.test(String(req.body?.project_id || '')) ? req.body.project_id : null;
      const { job, existed } = await createJob({
        userId, kind: 'video_clip', requestId: /^[A-Za-z0-9_-]{8,80}$/.test(rid) ? `video:${rid}` : `video:${crypto.randomUUID()}`,
        input: { prompt: prompt.trim(), hd, premium, referenceImageUrl, tier: status.plan.id, role: req.body?.role || null },
        projectKind, projectId, reservation: hd ? null : reservation, credits: hd ? 0 : cost,
        memory: hd ? { authorization: req.headers.authorization, hdCost } : null,
      });
      if (existed) await releaseCredits(reservation); // a retry of a job that already exists holds nothing new
      reservation = null;
      if (req.body?.async) return res.status(202).json({ success: true, data: { job: publicJob(job) } });
      const settled = await waitForJob(job.id);
      if (settled?.status === 'done') return res.json({ success: true, data: { ...settled.result, job_id: job.id } });
      if (settled?.status === 'failed') return res.status(500).json({ success: false, error: settled.error || 'AI video generation failed. You were not charged.' });
      return res.status(202).json({ success: true, data: { job: publicJob(settled), pending: true, message: 'Still making your video. It will be in your Gallery when it is ready.' } });
    }

    const { videoUrl: rawVideoUrl, taskUUID, modelUsed, latencyMs, providerCost, providerHttpStatus } = await generateVideo(prompt.trim(), { hd, premium, referenceImageUrl });
    const skipWatermark = hd || premium; // Premium's plan perk: no watermark even on the free monthly allowance
    const videoUrl = skipWatermark ? rawVideoUrl : await watermarkVideo(rawVideoUrl);
    let charged = false;

    if (hd) {
      charged = await chargeCredits(req, hdCost, 'Bascardo AI Content — HD video');
    } else {
      await commitCredits(userId, reservation);
      reservation = null;
    }

    logGeneration({ userId, feature: 'video', model: modelUsed, provider: 'runware', requestId: taskUUID, inputPrompt: prompt.trim(), durationSeconds: VIDEO_FREE_DURATION_SECONDS, tier: hd ? 'hd' : (premium ? 'premium_free' : 'free'), costTokens: charged ? creditsToLogUnits(hdCost) : 0, success: true, outputUrl: videoUrl, latencyMs, providerCost, providerHttpStatus });
    saveToGallery({ userId, kind: 'video', url: videoUrl, feature: 'video', prompt: prompt.trim(), model: modelUsed, durationSeconds: VIDEO_FREE_DURATION_SECONDS });
    res.json({ success: true, data: { videoUrl, hd, charged, watermarked: !skipWatermark } });
  } catch (err) {
    await releaseCredits(reservation);
    console.error('Runware video generate error:', err);
    logGeneration({ userId, feature: 'video', model: hd ? AI_MODELS.VIDEO.PREMIUM : AI_MODELS.VIDEO.FREE, provider: 'runware', inputPrompt: prompt.trim(), tier: hd ? 'hd' : 'free', success: false, errorMessage: err.message, latencyMs: Date.now() - genStartedAt, providerHttpStatus: err.providerHttpStatus ?? null });
    res.status(500).json({ success: false, error: err.message || 'AI video generation failed' });
  }
});

// ── Video clip as a background job (utils/studioJobs.js) ────────────────────
registerJobKind('video_clip', {
  pollEveryMs: 5000,
  async start(job) {
    const { prompt, hd, premium, referenceImageUrl } = job.input;
    const task = buildVideoTask(prompt, { hd, premium, referenceImageUrl });
    // Keep our own task id: polling resumes with it after a restart.
    await callRunwareTasks([{ ...task, taskUUID: job.provider_task_id || task.taskUUID }]);
    return { provider: 'runware', providerTaskId: task.taskUUID, model: task.model };
  },
  async poll(job) {
    const { data } = await callRunwareTasks([{ taskType: 'getResponse', taskUUID: job.provider_task_id }]);
    const [r] = data;
    if (r?.status === 'success') return { result: r };
    if (r?.status === 'error') throw Object.assign(new Error(r?.errorMessage || 'Video generation failed'), { permanent: true });
    return null;
  },
  async finish(job, r, ctx) {
    const { prompt, hd, premium, referenceImageUrl, tier, role } = job.input;
    if (!r?.videoURL) throw Object.assign(new Error('Runware returned no video'), { permanent: true });
    const model = hd || premium ? AI_MODELS.VIDEO.PREMIUM : AI_MODELS.VIDEO.FREE;
    const videoUrl = hd || premium ? r.videoURL : await watermarkVideo(r.videoURL);
    let charged = false;
    if (hd) {
      // Wallet charge needs the user's session, kept only in memory. After a
      // restart it's gone: the clip is then delivered uncharged (our loss,
      // never the user's), and logged.
      if (ctx.authorization) charged = await chargeCredits({ headers: { authorization: ctx.authorization } }, ctx.hdCost, 'Bascardo AI Content — HD video').catch(() => false);
      if (!charged) console.warn(`[jobs] HD video ${job.id} delivered without a wallet charge`);
    }
    const latencyMs = Date.now() - new Date(job.created_at).getTime();
    logGeneration({ userId: job.user_id, feature: 'video', model, provider: 'runware', requestId: job.provider_task_id, inputPrompt: prompt, durationSeconds: VIDEO_FREE_DURATION_SECONDS, tier: hd ? 'hd' : (premium ? 'premium_free' : tier || 'free'), costTokens: charged ? creditsToLogUnits(ctx.hdCost) : 0, success: true, outputUrl: videoUrl, latencyMs, providerCost: r.cost ?? null });
    saveToGallery({
      userId: job.user_id, kind: 'video', url: videoUrl, feature: 'video', prompt, model, durationSeconds: VIDEO_FREE_DURATION_SECONDS,
      projectKind: job.project_kind, projectId: job.project_id, role: role || null, provider: 'runware', providerCost: r.cost ?? null, credits: job.credits, jobId: job.id,
    });
    return { videoUrl, hd, charged, watermarked: !(hd || premium), referenceImageUrl: referenceImageUrl || null };
  },
  failed(job, err) {
    logGeneration({ userId: job.user_id, feature: 'video', model: job.input?.hd || job.input?.premium ? AI_MODELS.VIDEO.PREMIUM : AI_MODELS.VIDEO.FREE, provider: 'runware', inputPrompt: job.input?.prompt, tier: job.input?.hd ? 'hd' : 'free', success: false, errorMessage: err.message, latencyMs: Date.now() - new Date(job.created_at).getTime() });
  },
});

export default router;
