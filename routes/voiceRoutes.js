import express from 'express';
import crypto from 'crypto';
import { supabase } from '../config/db.js';
import { authenticateToken } from '../auth.js';
import { isPremium } from '../utils/isPremium.js';
import { userScopedClient, tokenFromRequest } from '../utils/supabaseUserClient.js';
import { monthlyUsage, recordMonthlyUsage } from '../utils/monthlyQuota.js';
import { logGeneration } from '../utils/aiGenerationLog.js';
import { AI_MODELS, AI_VOICE_PRESETS } from '../config/aiModels.js';

/*
  "Generate Bascardo AI Content" — voice narration via Runware (audioInference),
  matching the same provider runwareRoutes.js already uses for image/video --
  no separate ElevenLabs account/key needed.

  Free vs. premium/HD model (2026-07-18, verified live against
  https://runware.ai/docs/models -- not guessed):
    Free:        Gemini 3.1 Flash TTS (google:gemini@3.1-flash-tts)
    Premium/HD:  Fish Audio S2.1 Pro (fishaudio:s2.1@pro)
  Both confirmed to support plain preset-voice text-to-speech (you pick a
  voice id, no reference-audio cloning required) -- some other Runware audio
  models (e.g. Qwen3-TTS Base) turned out to be voice-CLONING-only, requiring
  a reference audio upload this app has no UI for, so they were deliberately
  not used here. Runware returns a hosted audioURL directly (like it does for
  images/video), so unlike the old ElevenLabs version of this route, there's
  no need to re-upload the result to Cloudinary ourselves.

  Setup: Backend/.env already has RUNWARE_API_KEY (shared with
  runwareRoutes.js) -- no ELEVENLABS_API_KEY needed anymore.

  Free-tier budget resets MONTHLY (backed by migrations/021_ai_usage_monthly.sql
  via Backend/utils/monthlyQuota.js), not daily -- narration costs real
  provider money per call, so a monthly cap is what actually bounds spend at
  scale. Requires that migration to be applied.
*/

const router = express.Router();

const RUNWARE_API_URL = 'https://api.runware.ai/v1';
const RUNWARE_API_KEY = process.env.RUNWARE_API_KEY;

// Billed-by-character/token on Runware's side, but the app's own free/premium
// budget is tracked in estimated SECONDS using an average speaking rate --
// simpler and more meaningful to a user than a raw character or token count,
// and independent of whichever provider/model is actually behind the scenes.
const CHARS_PER_SECOND = 15; // ~150 wpm, ~6 chars/word incl. spaces
const FREE_SECONDS_PER_MONTH = 120; // 2 minutes/month
const PREMIUM_SECONDS_PER_MONTH = 1800; // 30 minutes/month
const HD_COST_TOKENS_PER_MINUTE = 10; // matches the $10-credit example: "Podcast: ElevenLabs = 10 credits/minute"
const MAX_CHARS_PER_REQUEST = 1200; // ~80s -- keeps any single call bounded regardless of tier

function estimateSeconds(text) {
  return Math.ceil(text.length / CHARS_PER_SECOND);
}

// Returns { data, status }; on failure the thrown Error carries the same
// status as `.providerHttpStatus` -- see runwareRoutes.js's identical
// helper for why (shared telemetry pattern, kept duplicated per-file rather
// than factored out since these are the only two callers and they're not
// otherwise coupled).
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

async function synthesizeSpeech(text, { useHdModel }) {
  const task = {
    taskType: 'audioInference',
    taskUUID: crypto.randomUUID(),
    model: useHdModel ? AI_MODELS.VOICE.PREMIUM : AI_MODELS.VOICE.FREE,
    speech: {
      text,
      voice: useHdModel ? AI_VOICE_PRESETS.PREMIUM : AI_VOICE_PRESETS.FREE,
    },
    outputFormat: 'MP3',
    includeCost: true,
  };
  const startedAt = Date.now();
  const { data, status } = await callRunwareTasks([task]);
  const latencyMs = Date.now() - startedAt;
  const [result] = data;
  if (!result?.audioURL) throw new Error('Runware returned no audio');
  return {
    audioUrl: result.audioURL,
    taskUUID: task.taskUUID,
    modelUsed: task.model,
    latencyMs,
    providerCost: result.cost ?? null,
    providerHttpStatus: status,
  };
}

// GET /api/ai/voice/quota
router.get('/quota', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const premium = await isPremium(userId);
    const limitSeconds = premium ? PREMIUM_SECONDS_PER_MONTH : FREE_SECONDS_PER_MONTH;
    const usedSeconds = await monthlyUsage(userId, 'voice');
    res.json({
      success: true,
      data: {
        premium,
        limitSeconds,
        remainingSeconds: Math.max(0, limitSeconds - usedSeconds),
        hdCostTokensPerMinute: HD_COST_TOKENS_PER_MINUTE,
        maxCharsPerRequest: MAX_CHARS_PER_REQUEST,
        configured: !!RUNWARE_API_KEY,
        period: 'month',
      },
    });
  } catch (err) {
    console.error('Voice quota error:', err);
    res.status(500).json({ success: false, error: 'Failed to load quota' });
  }
});

// POST /api/ai/voice/narrate
// Body: { text: string, hd?: boolean }
// Free: counts against the monthly 2-minute (30 min for Premium) budget. HD
// (or Premium subscribers automatically): routed to the higher-quality model;
// HD specifically also skips the budget and costs HD_COST_TOKENS_PER_MINUTE
// Bascardo Tokens per minute (rounded up).
router.post('/narrate', authenticateToken, async (req, res) => {
  if (!RUNWARE_API_KEY) {
    return res.status(501).json({ success: false, error: 'Voice narration is not configured yet' });
  }

  const text = req.body?.text;
  const hd = !!req.body?.hd;
  if (!text?.trim()) return res.status(400).json({ success: false, error: 'Text to narrate is required' });
  if (text.length > MAX_CHARS_PER_REQUEST) {
    return res.status(400).json({ success: false, error: `Text too long (max ${MAX_CHARS_PER_REQUEST} characters per request)` });
  }

  const userId = req.user.id;
  const seconds = estimateSeconds(text.trim());
  const genStartedAt = Date.now(); // fallback latency source if synthesizeSpeech() itself is never reached

  try {
    const premium = await isPremium(userId);
    let costTokens = 0;
    if (hd) {
      costTokens = Math.ceil(seconds / 60) * HD_COST_TOKENS_PER_MINUTE;
      const { data: wallet } = await supabase.from('wallets').select('token_balance').eq('user_id', userId).single();
      if ((wallet?.token_balance || 0) < costTokens) {
        return res.status(402).json({ success: false, error: `This would cost ${costTokens} Bascardo Tokens. Top up your balance and try again.` });
      }
    } else {
      const limitSeconds = premium ? PREMIUM_SECONDS_PER_MONTH : FREE_SECONDS_PER_MONTH;
      const usedSeconds = await monthlyUsage(userId, 'voice');
      if (usedSeconds + seconds > limitSeconds) {
        return res.status(429).json({
          success: false,
          error: `This would use more than your remaining free narration time this month (${Math.max(0, limitSeconds - usedSeconds)}s left). Try HD (spends Bascardo Tokens) or shorten the text.`,
        });
      }
    }

    const useHdModel = hd || premium;
    const { audioUrl, taskUUID, modelUsed, latencyMs, providerCost, providerHttpStatus } = await synthesizeSpeech(text.trim(), { useHdModel });
    let charged = false;

    if (hd) {
      const { data: chargeRows, error: chargeError } = await userScopedClient(tokenFromRequest(req)).rpc('spend_tokens', {
        p_amount: costTokens,
        p_description: 'Bascardo AI Content — HD narration',
      });
      if (chargeError) throw chargeError;
      charged = !!chargeRows?.[0]?.success;
    } else {
      await recordMonthlyUsage(userId, 'voice', seconds, 'seconds');
    }

    logGeneration({ userId, feature: 'voice', model: modelUsed, provider: 'runware', requestId: taskUUID, durationSeconds: seconds, inputPrompt: text.trim(), tier: hd ? 'hd' : (premium ? 'premium_free' : 'free'), costTokens: charged ? costTokens : 0, success: true, outputUrl: audioUrl, latencyMs, providerCost, providerHttpStatus });
    res.json({ success: true, data: { audioUrl, hd, charged, estimatedSeconds: seconds } });
  } catch (err) {
    console.error('Voice narration error:', err);
    logGeneration({ userId, feature: 'voice', model: hd ? AI_MODELS.VOICE.PREMIUM : AI_MODELS.VOICE.FREE, provider: 'runware', durationSeconds: seconds, inputPrompt: text.trim(), tier: hd ? 'hd' : 'free', success: false, errorMessage: err.message, latencyMs: Date.now() - genStartedAt, providerHttpStatus: err.providerHttpStatus ?? null });
    res.status(500).json({ success: false, error: err.message || 'Voice narration failed' });
  }
});

export default router;
