import { supabase } from '../config/db.js';

// Records one row per "Generate Bascardo AI Content" attempt (migrations/022,
// detail columns in 023). Best-effort: a logging failure must never break
// the user-facing generation it's describing, so errors here are swallowed
// and just console.error'd.
export async function logGeneration({
  userId, feature, model = null, provider = null, tier, costTokens = 0,
  success, errorMessage = null, outputUrl = null, requestId = null,
  durationSeconds = 0, inputPrompt = null,
  // Operational telemetry (028) -- distinct from costTokens (what the USER
  // paid us) and durationSeconds (content length produced). See that
  // migration's comment for why each of these three exists.
  latencyMs = null, providerCost = null, providerHttpStatus = null,
}) {
  try {
    const { error } = await supabase.from('ai_generation_history').insert({
      user_id: userId,
      feature,
      model,
      provider,
      tier,
      cost_tokens: costTokens,
      success,
      error_message: errorMessage,
      output_url: outputUrl,
      request_id: requestId,
      duration_seconds: durationSeconds,
      input_prompt: inputPrompt,
      latency_ms: latencyMs,
      provider_cost: providerCost,
      provider_http_status: providerHttpStatus,
    });
    if (error) throw error;
  } catch (err) {
    console.error('ai_generation_history log failed:', err.message || err);
  }
}
