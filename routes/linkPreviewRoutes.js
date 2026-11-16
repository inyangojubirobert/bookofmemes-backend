// routes/linkPreviewRoutes.js
// Fetches link preview metadata (title, description, thumbnail image)
// server-side so the client doesn't run into CORS / User-Agent issues when
// embedding screenshots or favicons directly in <Image>.
//
// Thumbnail resolution order (first hit wins):
//   1. Microlink API  -> og:image / twitter:image of the exact linked page
//   2. Direct HTML scrape of the target URL -> og:image / twitter:image /
//      <link rel="image_src"> / first <img> in the page body
//   3. The site's INDEX PAGE (origin root) -> og:image / twitter:image.
//      A deep link ("site.com/some/article") usually inherits the brand image
//      from the homepage when the article itself declares none.
//   4. Site icon: microlink logo -> <link rel="icon"> on the index page ->
//      Google's favicon service (always resolves, so a card is never blank)
//
// Every payload carries `imageKind` so the client knows whether it received a
// wide hero image ("hero") or a small square site icon ("icon") and can pick
// the matching card layout.
//
// Results are cached in-memory so repeated previews of the same link don't
// hammer Microlink (which rate-limits aggressively).
import express from "express";
import dns from "node:dns/promises";
import net from "node:net";

const router = express.Router();

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// Simple in-memory cache: url -> { at, ttl, payload }
const previewCache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
// A payload with no title and no hero image means every lookup failed, often
// because the site timed us out. Retry those sooner instead of serving a
// favicon-only card for half an hour.
const DEGRADED_TTL_MS = 5 * 60 * 1000;

// Helper: safely extract a hostname from a URL (returns null on failure).
function safeHost(rawUrl) {
  try {
    return new URL(rawUrl).hostname;
  } catch (e) {
    return null;
  }
}

// Helper: the site's index page ("https://host/") for a given link, or null
// when the link already points at the root.
function indexPageOf(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const root = `${parsed.origin}/`;
    return root === parsed.href || `${parsed.origin}${parsed.pathname}` === root ? null : root;
  } catch {
    return null;
  }
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [first, second] = ip.split('.').map(Number);
    return first === 0 || first === 10 || first === 127 || first === 169 && second === 254 ||
      first === 192 && second === 168 || first === 172 && second >= 16 && second <= 31;
  }
  return ip === '::1' || /^f[cd]/i.test(ip) || /^fe80/i.test(ip);
}

async function isSafeUrl(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { return false; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return false;
  if (!parsed.hostname || parsed.hostname.toLowerCase() === 'localhost') return false;
  try {
    const addresses = await dns.lookup(parsed.hostname, { all: true });
    return addresses.length > 0 && addresses.every(({ address }) => !isPrivateIp(address));
  } catch {
    return false;
  }
}

// Helper: decode basic HTML entities that commonly appear in meta content.
// The entity names are assembled from character codes so code formatters
// cannot collapse the entity literals into raw characters in this source.
const AMP = String.fromCharCode(38); // the ampersand character

// Collapse the newlines/indentation that show up inside <title> and meta
// content, and cap the length so a card can't be handed an essay.
function clean(value, max) {
  if (typeof value !== "string") return null;
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  return collapsed.length > max ? `${collapsed.slice(0, max - 1).trimEnd()}…` : collapsed;
}

function decodeEntities(str) {
  return str
    .replace(new RegExp(AMP + "lt;", "g"), "<")
    .replace(new RegExp(AMP + "gt;", "g"), ">")
    .replace(new RegExp(AMP + "quot;", "g"), '"')
    .replace(new RegExp(AMP + "#0?39;", "g"), "'")
    .replace(new RegExp(AMP + "apos;", "g"), "'")
    .replace(new RegExp(AMP + "#x2F;", "gi"), "/")
    .replace(new RegExp(AMP + "amp;", "g"), AMP);
}

// Helper: resolve a possibly-relative image URL against the page URL.
function absolutize(src, baseUrl) {
  if (!src) return null;
  try {
    return new URL(src, baseUrl).href;
  } catch {
    return null;
  }
}

// Helper: extract the first matching attribute value from raw HTML.
// Matches both double- and single-quoted attributes, in either attribute order.
function metaContent(html, patterns) {
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) {
      const val = decodeEntities(m[1].trim());
      if (val) return val;
    }
  }
  return null;
}

// Google's favicon service. Always answers with a PNG icon (a generic globe
// when the site has none), which guarantees the client can render a card.
function googleFavicon(host) {
  return host ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=128` : null;
}

// React Native's <Image> can only load http(s) bitmaps — `data:` placeholders
// (example.com ships `rel="icon" href="data:,"`) and `.ico` files, which
// Android cannot decode, have to be replaced with the PNG favicon service.
function isRenderableImage(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

// Prefer the site's own PNG icon (apple-touch-icon and friends) over anything
// ICO, then fall back to the favicon service.
function pickIcon(candidates, host) {
  for (const candidate of candidates) {
    if (isRenderableImage(candidate) && !/\.ico(\?|#|$)/i.test(candidate)) return candidate;
  }
  return googleFavicon(host);
}

// Steps 2 & 3: fetch the page HTML ourselves and pull the preview metadata out
// of it. This catches pages Microlink can't/won't parse (bot-blocked,
// rate-limited, or simply missing og:image but having twitter:image or a hero
// <img>). Used for both the exact link and the site's index page.
async function scrapePage(normalized) {
  if (!(await isSafeUrl(normalized))) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    let currentUrl = normalized;
    let resp;
    for (let hop = 0; hop <= 5; hop += 1) {
      resp = await fetch(currentUrl, {
        headers: { "User-Agent": BROWSER_UA, Accept: "text/html,application/xhtml+xml" },
        redirect: "manual",
        signal: controller.signal,
      });
      if (![301, 302, 303, 307, 308].includes(resp.status)) break;
      const location = resp.headers.get('location');
      const nextUrl = location ? new URL(location, currentUrl).href : null;
      if (!nextUrl || !(await isSafeUrl(nextUrl))) { clearTimeout(timeout); return null; }
      currentUrl = nextUrl;
    }
    clearTimeout(timeout);
    if (!resp.ok) return null;

    // Only bother parsing HTML responses.
    const ctype = resp.headers.get("content-type") || "";
    if (!ctype.includes("text/html") && !ctype.includes("application/xhtml")) return null;

    // Read at most ~300KB — meta tags live in <head>, no need for the whole doc.
    const reader = resp.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let html = "";
    let received = 0;
    while (received < 300 * 1024) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      html += decoder.decode(value, { stream: true });
      // Early exit once we're past </head> — everything we need is there.
      if (html.includes("</head>")) break;
    }
    try { reader.cancel(); } catch { /* ignore */ }

    // 1) Open Graph image (the canonical "index page" preview image)
    let image = metaContent(html, [
      /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["']/i,
    ]);
    // 2) Twitter card image
    if (!image) {
      image = metaContent(html, [
        /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i,
        /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image(?::src)?["']/i,
      ]);
    }
    // 3) Legacy <link rel="image_src">
    if (!image) {
      image = metaContent(html, [
        /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i,
        /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']image_src["']/i,
      ]);
    }
    // 4) First reasonably-sized <img> in the body as a last scrape resort.
    if (!image) {
      const imgMatch = html.match(/<img[^>]+src=["']([^"']+\.(?:jpe?g|png|webp|gif))["']/i);
      if (imgMatch && imgMatch[1]) image = imgMatch[1];
    }

    // Site icon — used when no hero image exists anywhere.
    const icon = metaContent(html, [
      /<link[^>]+rel=["'](?:apple-touch-icon|apple-touch-icon-precomposed)["'][^>]+href=["']([^"']+)["']/i,
      /<link[^>]+href=["']([^"']+)["'][^>]+rel=["'](?:apple-touch-icon|apple-touch-icon-precomposed)["']/i,
      /<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]+href=["']([^"']+)["']/i,
      /<link[^>]+href=["']([^"']+)["'][^>]+rel=["'][^"']*icon[^"']*["']/i,
    ]);

    const ogTitle = metaContent(html, [
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i,
    ]);
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = ogTitle || (titleMatch ? decodeEntities(titleMatch[1].replace(/<[^>]+>/g, '').trim()) : null);
    const siteName = metaContent(html, [
      /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["']/i,
    ]);
    const description = metaContent(html, [
      /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i,
      /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i,
    ]);

    return {
      title,
      siteName,
      description,
      image: absolutize(image, currentUrl),
      icon: absolutize(icon, currentUrl),
    };
  } catch {
    return null;
  }
}

// Step 1: Microlink API (returns og:image, title, description, logo).
async function microlinkPreview(normalized) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const microlinkUrl = "https://api.microlink.io/?url=" + encodeURIComponent(normalized);
    const response = await fetch(microlinkUrl, {
      headers: { "User-Agent": BROWSER_UA },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) return null;

    const json = await response.json();
    if (!json || !json.data) return null;

    return {
      url: json.data.url || normalized,
      title: json.data.title || null,
      siteName: json.data.publisher || null,
      description: json.data.description || null,
      image: (json.data.image && json.data.image.url) || null,
      imageWidth: (json.data.image && json.data.image.width) || null,
      imageHeight: (json.data.image && json.data.image.height) || null,
      logo: (json.data.logo && json.data.logo.url) || null,
    };
  } catch {
    return null;
  }
}

// Merge a scrape result into the payload without letting nulls clobber values
// an earlier step already resolved.
function mergePreview(base, extra) {
  if (!extra) return base;
  const merged = { ...(base || {}) };
  for (const key of ["title", "siteName", "description", "image", "icon"]) {
    if (!merged[key] && extra[key]) merged[key] = extra[key];
  }
  return merged;
}

// GET /api/link-preview?target=<url>
router.get("/", async (req, res) => {
  const target = req.query.target || req.query.url;
  if (!target) {
    return res.status(400).json({ error: "Missing target url parameter" });
  }

  // Normalise to https:// so the downstream service resolves it.
  const normalized = /^https?:\/\//i.test(target) ? target : "https://" + target;
  const host = safeHost(normalized);
  if (!(await isSafeUrl(normalized))) {
    return res.status(400).json({ error: "URL is not allowed" });
  }

  // Serve from cache when fresh.
  const cached = previewCache.get(normalized);
  if (cached && Date.now() - cached.at < cached.ttl) {
    return res.json(cached.payload);
  }

  // 1) Microlink (og:image of the exact linked page).
  let payload = await microlinkPreview(normalized);

  // 2) Direct scrape of the page HTML for og:image / twitter:image / hero img.
  if (!payload || !payload.image || !payload.title || !payload.description) {
    payload = mergePreview(payload, await scrapePage(normalized));
  }

  // 3) The site's index page. A deep link with no image of its own still gets
  //    the homepage's brand image, title and description.
  const indexPage = indexPageOf(normalized);
  if (indexPage && (!payload || !payload.image || !payload.title)) {
    const indexPreview = await scrapePage(indexPage);
    if (indexPreview) {
      payload = mergePreview(payload, {
        // The linked page's own title/description always win; only fill gaps.
        title: indexPreview.title,
        siteName: indexPreview.siteName,
        description: indexPreview.description,
        image: indexPreview.image,
        icon: indexPreview.icon,
      });
    }
  }

  // 4) Site icon fallback so a card is never blank: microlink logo, the page's
  //    own <link rel="icon">, then Google's favicon service.
  const heroImage = isRenderableImage(payload?.image) ? payload.image : null;
  const iconImage = pickIcon([payload?.icon, payload?.logo], host);

  payload = {
    ...(payload || {}),
    url: normalized,
    host,
    title: clean(payload?.title, 120) || clean(payload?.siteName, 120) || host,
    siteName: clean(payload?.siteName, 60) || host,
    description: clean(payload?.description, 220),
    image: heroImage || iconImage,
    imageKind: heroImage ? "hero" : "icon",
    icon: iconImage,
    logo: payload?.logo || iconImage,
  };

  // Cache successful payloads (including favicon fallbacks) to stay under
  // Microlink's rate limits.
  const degraded = payload.imageKind === "icon" && payload.title === host && !payload.description;
  previewCache.set(normalized, {
    at: Date.now(),
    ttl: degraded ? DEGRADED_TTL_MS : CACHE_TTL_MS,
    payload,
  });
  // Keep the cache bounded.
  if (previewCache.size > 500) {
    const oldestKey = previewCache.keys().next().value;
    previewCache.delete(oldestKey);
  }

  res.json(payload);
});

export default router;
