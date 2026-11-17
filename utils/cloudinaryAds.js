// Cloudinary for advertising media (ported from One Dream lib/cloudinaryAds.js).
// Binaries live only in Cloudinary; the database stores verified references
// (advertising_media).
//
// Uploads are signed by the server (the API secret never leaves it) into the
// advertiser's own folder, with a server-chosen public_id, an allow-list of
// formats and delivery type "authenticated": until an admin approves the
// asset it can only be viewed through signed URLs generated here, and those
// are only given to the owner and admins. Approval converts the asset to
// public ("upload") delivery; withdrawing approval converts it back.
//
// Credentials: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET.
import crypto from 'crypto';

export const AD_MEDIA_RULES = {
  image: { formats: ['jpg', 'jpeg', 'png', 'webp'], maxBytes: 10 * 1024 * 1024 },
  video: { formats: ['mp4', 'mov', 'webm'], maxBytes: 100 * 1024 * 1024, maxSeconds: 60 },
};

export const AD_FOLDER_ROOT = 'bom_ads';
export const HOUSE_FOLDER = 'bom_house_ads';

export function cloudinaryConfig() {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) throw new Error('cloudinary_not_configured');
  return { cloudName, apiKey, apiSecret };
}

/** Cloudinary API signature: sha1 of the sorted params + secret. */
export function signParams(params, apiSecret) {
  const toSign = Object.keys(params)
    .filter((key) => params[key] !== undefined && params[key] !== null && params[key] !== '')
    .sort()
    .map((key) => `${key}=${Array.isArray(params[key]) ? params[key].join(',') : params[key]}`)
    .join('&');
  return crypto.createHash('sha1').update(toSign + apiSecret).digest('hex');
}

export const adFolder = (ownerId) => `${AD_FOLDER_ROOT}/${ownerId}`;

function signUpload(resourceType, folder, prefix, type) {
  const rules = AD_MEDIA_RULES[resourceType];
  if (!rules) throw new Error('invalid_resource_type');
  const { apiKey, apiSecret, cloudName } = cloudinaryConfig();
  const params = {
    allowed_formats: rules.formats.join(','),
    folder,
    public_id: `${prefix}_${crypto.randomBytes(12).toString('hex')}`,
    timestamp: Math.floor(Date.now() / 1000),
    type,
  };
  return {
    upload_url: `https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/upload`,
    api_key: apiKey,
    signature: signParams(params, apiSecret),
    ...params,
    max_bytes: rules.maxBytes,
    max_seconds: rules.maxSeconds || null,
  };
}

/** Parameters for one direct, private upload by an advertiser (~1 hour). */
export const signAdUpload = (ownerId, resourceType) => signUpload(resourceType, adFolder(ownerId), 'ad', 'authenticated');
/** Parameters for one direct, public upload by an admin (house ads, no review). */
export const signHouseAdUpload = (resourceType) => signUpload(resourceType, HOUSE_FOLDER, 'house', 'upload');

function authHeader() {
  const { apiKey, apiSecret } = cloudinaryConfig();
  return `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString('base64')}`;
}

/** Reads an asset's real metadata from Cloudinary (never trusts the client's description). */
export async function getAdResource(resourceType, publicId, deliveryType = 'authenticated') {
  const { cloudName } = cloudinaryConfig();
  const url = `https://api.cloudinary.com/v1_1/${cloudName}/resources/${resourceType}/${deliveryType}/${publicId.split('/').map(encodeURIComponent).join('/')}`;
  const response = await fetch(url, { headers: { Authorization: authHeader() } });
  if (response.status === 404) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `cloudinary_${response.status}`);
  return data;
}

/** Checks an uploaded asset against the rules. { ok, media } or { ok: false, reason }. */
export function validateAdResource(resource, folder, resourceType, deliveryType = 'authenticated') {
  const rules = AD_MEDIA_RULES[resourceType];
  if (!resource || !rules) return { ok: false, reason: 'Upload not found' };
  if (!String(resource.public_id || '').startsWith(`${folder}/`)) return { ok: false, reason: 'Upload does not belong to you' };
  if (resource.type !== deliveryType) return { ok: false, reason: 'Upload was not made through the advertising uploader' };
  if (resource.resource_type !== resourceType) return { ok: false, reason: 'Unexpected media type' };
  const format = String(resource.format || '').toLowerCase();
  if (!rules.formats.includes(format)) return { ok: false, reason: `Only ${rules.formats.join(', ')} files are accepted` };
  if (!(resource.bytes > 0) || resource.bytes > rules.maxBytes) {
    return { ok: false, reason: `File must be under ${Math.round(rules.maxBytes / 1024 / 1024)} MB` };
  }
  if (resourceType === 'video') {
    const seconds = Number(resource.duration);
    if (!(seconds > 0) || seconds > rules.maxSeconds) return { ok: false, reason: `Videos must be ${rules.maxSeconds} seconds or shorter` };
  }
  return {
    ok: true,
    media: {
      cloudinary_public_id: resource.public_id,
      cloudinary_asset_id: resource.asset_id || null,
      resource_type: resourceType,
      format,
      bytes: resource.bytes,
      width: resource.width || null,
      height: resource.height || null,
      duration_seconds: resourceType === 'video' ? Math.round(Number(resource.duration) * 100) / 100 : null,
      version: resource.version || null,
    },
  };
}

async function signedPost(resourceType, action, params) {
  const { apiKey, apiSecret, cloudName } = cloudinaryConfig();
  const body = { ...params, timestamp: Math.floor(Date.now() / 1000) };
  const form = new URLSearchParams({ ...body, api_key: apiKey, signature: signParams(body, apiSecret) });
  const response = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/${action}`, { method: 'POST', body: form });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw new Error(data?.error?.message || `cloudinary_${action}_failed`);
  return data;
}

/** Approval: private -> public delivery. */
export const publishAdAsset = (resourceType, publicId) => signedPost(resourceType, 'rename', {
  from_public_id: publicId, to_public_id: publicId, type: 'authenticated', to_type: 'upload', overwrite: 'false', invalidate: 'true',
});

/** Withdrawn approval: back to private delivery, CDN cache invalidated. */
export const unpublishAdAsset = (resourceType, publicId) => signedPost(resourceType, 'rename', {
  from_public_id: publicId, to_public_id: publicId, type: 'upload', to_type: 'authenticated', overwrite: 'false', invalidate: 'true',
});

export const destroyAdAsset = (resourceType, publicId, deliveryType = 'authenticated') =>
  signedPost(resourceType, 'destroy', { public_id: publicId, type: deliveryType, invalidate: 'true' });

/** Delivery URL: normal CDN URL once public; signed URL while private. */
export function adDeliveryUrl(media, { width = 1080, poster = false } = {}) {
  const { apiSecret, cloudName } = cloudinaryConfig();
  const isVideo = media.resource_type === 'video';
  const transformation = poster
    ? `so_0,w_${width},c_limit,q_auto`
    : isVideo ? `w_${width},c_limit,q_auto,vc_auto` : `w_${width},c_limit,q_auto,f_auto`;
  const ext = poster ? 'jpg' : isVideo ? 'mp4' : media.format;
  const path = `${transformation}/${media.cloudinary_public_id}.${ext}`;
  if (media.delivery_type === 'upload') {
    return `https://res.cloudinary.com/${cloudName}/${media.resource_type}/upload/${path}`;
  }
  const signature = crypto.createHash('sha1').update(path + apiSecret).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').slice(0, 8);
  return `https://res.cloudinary.com/${cloudName}/${media.resource_type}/authenticated/s--${signature}--/${path}`;
}
