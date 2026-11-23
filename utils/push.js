// Push notifications that pop up over other apps (Android "heads-up", with sound), the
// way WhatsApp and Facebook alerts do. Sent straight to Firebase Cloud Messaging (HTTP v1)
// with a service account; the app registers each phone's FCM token (push_devices, 087).
//
// Setup (once): FIREBASE_SERVICE_ACCOUNT = the service account JSON (raw or base64) from
// Firebase console → Project settings → Service accounts → Generate new private key.
// Without it nothing is sent and notifications stay in the in-app inbox.
//
// The app creates the Android channel "bom_alerts" with MAX importance + sound, which is
// what makes a notification drop down over whatever is on screen.
import { GoogleAuth } from 'google-auth-library';
import { supabase } from '../config/db.js';

export const CHANNEL_ID = 'bom_alerts';
let auth = null;
let projectId = null;

function credentials() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;
  try {
    const json = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch (err) { console.error('[push] FIREBASE_SERVICE_ACCOUNT is not valid JSON:', err.message); return null; }
}

export function pushConfigured() {
  if (auth) return true;
  const c = credentials();
  if (!c) return false;
  projectId = c.project_id;
  auth = new GoogleAuth({ credentials: c, scopes: ['https://www.googleapis.com/auth/firebase.messaging'] });
  return true;
}

/**
 * Sends one notification to one phone. data values must be strings (FCM rule).
 * Returns 'sent' | 'invalid_token' | 'failed'.
 */
export async function sendToToken(token, { title, body, image = null, data = {} }) {
  if (!pushConfigured()) return 'failed';
  const client = await auth.getClient();
  const { token: access } = await client.getAccessToken();
  const message = {
    token,
    notification: { title: String(title || 'Book of Memes').slice(0, 120), body: String(body || '').slice(0, 400), ...(image ? { image } : {}) },
    data: Object.fromEntries(Object.entries(data).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, String(v)])),
    android: {
      priority: 'HIGH',
      notification: {
        channel_id: CHANNEL_ID, sound: 'default', notification_priority: 'PRIORITY_MAX', visibility: 'PUBLIC',
        default_vibrate_timings: true, ...(image ? { image } : {}),
      },
    },
    apns: { payload: { aps: { sound: 'default' } } },
  };
  const r = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: 'POST', headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ message }),
  });
  if (r.ok) return 'sent';
  const j = await r.json().catch(() => ({}));
  const code = j?.error?.details?.find?.((d) => d.errorCode)?.errorCode || j?.error?.status;
  if (r.status === 404 || code === 'UNREGISTERED' || code === 'INVALID_ARGUMENT') return 'invalid_token';
  console.warn('[push] FCM', r.status, code || '', j?.error?.message || '');
  return 'failed';
}

/** Sends to every phone of a user; switches off tokens Firebase says are gone. Returns how many got it. */
export async function sendToUser(userId, payload) {
  const { data: devices } = await supabase.from('push_devices').select('id, token').eq('user_id', userId).eq('enabled', true).limit(10);
  let sent = 0;
  for (const d of devices || []) {
    const r = await sendToToken(d.token, payload).catch((err) => { console.warn('[push] send:', err.message); return 'failed'; });
    if (r === 'sent') sent += 1;
    if (r === 'invalid_token') await supabase.from('push_devices').update({ enabled: false }).eq('id', d.id);
  }
  return { sent, devices: (devices || []).length };
}
