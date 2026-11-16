// Minimal Paystack client for the marketplace (no SDK).
// The same Paystack account is shared with One Dream, so every reference made
// here starts with "bom" to keep the two apps' transactions apart, and nothing
// here depends on Paystack webhooks (that URL belongs to One Dream): payments,
// transfers and refunds are confirmed by asking Paystack directly.

const BASE = 'https://api.paystack.co';

export class PaystackError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export async function paystack(path, { method = 'GET', body } = {}) {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) throw new PaystackError('Paystack is not configured', 500);
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.status === false) {
    throw new PaystackError(json.message || `Paystack error ${res.status}`, res.status, json);
  }
  return json.data;
}

export const bomReference = (prefix) =>
  `bom${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

let bankCache = { at: 0, banks: [] };
export async function listBanks() {
  if (Date.now() - bankCache.at < 12 * 3600_000 && bankCache.banks.length) return bankCache.banks;
  const data = await paystack('/bank?country=nigeria&perPage=500&currency=NGN');
  bankCache = {
    at: Date.now(),
    banks: data.filter((b) => b.active && !b.is_deleted).map((b) => ({ code: b.code, name: b.name })),
  };
  return bankCache.banks;
}

// Account-name check: the bank's name for the account must share at least
// one real name (3+ letters) with the user's profile name.
export function namesMatch(bankName, profileName) {
  const words = (s) => new Set(String(s || '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 3));
  const a = words(bankName);
  for (const w of words(profileName)) if (a.has(w)) return true;
  return false;
}
