// Custom voices (migration 086): a user's own recorded voices, used like built-in ones
// by the id "custom:<uuid>" (config/soundStudio.js voiceTask / parseSpeakers).
import { supabase } from '../config/db.js';
import { isCustomVoice, voiceById } from '../config/soundStudio.js';

export const customUuid = (id) => (isCustomVoice(id) ? String(id).slice(7) : null);

/** The user's custom voices by id ("custom:<uuid>" → row). Empty before 086. */
export async function customVoiceMap(userId) {
  const { data, error } = await supabase.from('custom_voices').select('*').eq('user_id', userId).limit(100);
  if (error) return {};
  return Object.fromEntries((data || []).map((v) => [`custom:${v.id}`, v]));
}

/** One custom voice, only if it belongs to this user. */
export async function getCustomVoice(userId, voiceId) {
  const id = customUuid(voiceId);
  if (!id || !userId) return null;
  const { data } = await supabase.from('custom_voices').select('*').eq('id', id).eq('user_id', userId).maybeSingle();
  return data || null;
}

/** A display name for any voice id. */
export const voiceName = (id, customs = {}) => (isCustomVoice(id) ? customs[id]?.name || 'My voice (removed)' : voiceById(id).name);

export const publicCustomVoice = (v) => ({
  id: `custom:${v.id}`, name: v.name, description: v.description, gender: v.gender, sample_url: v.sample_url,
  preview_url: v.preview_url, seconds: v.seconds, custom: true, created_at: v.created_at,
});
