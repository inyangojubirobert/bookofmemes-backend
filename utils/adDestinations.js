// Ported unchanged from One Dream lib/adDestinations.js.
// External advertising destinations (stored in Supabase as text, never in
// Cloudinary). A destination must be HTTPS, use a public hostname, and every
// redirect hop is re-checked - our server only ever contacts public internet
// addresses (SSRF protection). Admins still review each destination.

import dns from 'node:dns/promises';
import net from 'node:net';

const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 6000;

export function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)   // carrier-grade NAT
      || (a === 169 && b === 254)             // link-local / cloud metadata
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0)
      || (a === 198 && (b === 18 || b === 19));
  }
  if (net.isIPv6(address)) {
    const lower = address.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice(7));
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(lower);
  }
  return true;
}

/** Syntax rules only (no network). Returns { ok, url } or { ok: false, reason }. */
export function parseDestination(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw || raw.length > 2048) return { ok: false, reason: 'Enter a link up to 2048 characters' };
  let url;
  try { url = new URL(raw); } catch { return { ok: false, reason: 'That is not a valid link' }; }
  if (url.protocol !== 'https:') return { ok: false, reason: 'Links must start with https://' };
  if (url.username || url.password) return { ok: false, reason: 'Links cannot contain a username or password' };
  if (url.port && url.port !== '443') return { ok: false, reason: 'Links cannot use a custom port' };
  const host = url.hostname.toLowerCase();
  if (!host.includes('.') || net.isIP(host.replace(/^\[|\]$/g, ''))) return { ok: false, reason: 'Use a website name, not an IP address' };
  if (/(^|\.)(localhost|local|internal|lan|home|corp|intranet)$/.test(host)) return { ok: false, reason: 'That address is not a public website' };
  url.hash = '';
  return { ok: true, url: url.toString() };
}

async function assertPublicHost(hostname) {
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!records.length || records.some((record) => isPrivateAddress(record.address))) {
    throw new Error('That address is not a public website');
  }
}

/**
 * Follows the link (HEAD, falling back to GET without reading the body) up to
 * 5 redirects, validating every hop. Returns { ok, finalUrl, status } or
 * { ok: false, reason }.
 */
export async function checkDestination(input, { fetchImpl = fetch, lookup = assertPublicHost } = {}) {
  const first = parseDestination(input);
  if (!first.ok) return first;
  let current = first.url;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const parsed = parseDestination(current);
      if (!parsed.ok) return { ok: false, reason: `Redirects to an unsafe link: ${parsed.reason}` };
      await lookup(new URL(parsed.url).hostname);

      let response = await fetchImpl(parsed.url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
      if ([403, 405, 501].includes(response.status)) {
        response = await fetchImpl(parsed.url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
        response.body?.cancel?.();
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) return { ok: false, reason: 'The link redirects nowhere' };
        current = new URL(location, parsed.url).toString();
        continue;
      }
      if (response.status >= 400) return { ok: false, reason: `The website responded with an error (${response.status})` };
      return { ok: true, url: first.url, finalUrl: parsed.url, status: response.status };
    }
    return { ok: false, reason: 'The link redirects too many times' };
  } catch (error) {
    return { ok: false, reason: error?.message === 'That address is not a public website' ? error.message : 'The website could not be reached' };
  }
}
