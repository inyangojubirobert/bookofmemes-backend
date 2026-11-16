// Google Play Developer API credentials (service account).
//
// Set ONE of these in Backend/.env (and on the live server):
//   GOOGLE_PLAY_SERVICE_ACCOUNT_FILE=./secrets/play-service-account.json
//       path to the downloaded key file (relative to Backend/), easiest locally
//   GOOGLE_PLAY_SERVICE_ACCOUNT_JSON={"type":"service_account",...}
//       the whole key as one line, easiest on hosting dashboards
//
// The service account must be invited in Play Console → Users and permissions
// with "View financial data" and "Manage orders and subscriptions" (and
// "Manage store presence" if you use scripts/playBilling.js --create).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleAuth } from 'google-auth-library';

const BACKEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadPlayServiceAccount() {
  const file = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_FILE;
  if (file) {
    const full = path.isAbsolute(file) ? file : path.join(BACKEND_DIR, file);
    return JSON.parse(fs.readFileSync(full, 'utf8'));
  }
  const raw = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
  if (raw) return JSON.parse(raw);
  throw new Error('Google Play service account not configured: set GOOGLE_PLAY_SERVICE_ACCOUNT_FILE or GOOGLE_PLAY_SERVICE_ACCOUNT_JSON');
}

export function isPlayAuthConfigured() {
  const file = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_FILE;
  if (file) return fs.existsSync(path.isAbsolute(file) ? file : path.join(BACKEND_DIR, file));
  return !!process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
}

export async function createPlayAuthClient() {
  const auth = new GoogleAuth({
    credentials: loadPlayServiceAccount(),
    scopes: ['https://www.googleapis.com/auth/androidpublisher'],
  });
  return auth.getClient();
}
