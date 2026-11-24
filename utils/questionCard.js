// Puzzle-type cards (memes, puzzles, kids): the question written INSIDE the picture, in the
// middle, the way the app shows a quiz question (MediaViewer: the picture, answers below).
// Cloudinary draws the words, so spelling is exact (AI pictures can't spell). Free.
import { v2 as cloudinary } from 'cloudinary';
import { isOurCloudinary } from './gallery.js';

cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET });

export const CARD_SIZE = 1080; // square, like the quiz picture frame

/** Font size that keeps a question of this length inside the picture. */
export const cardFontSize = (text) => {
  const n = String(text || '').length;
  return n <= 30 ? 88 : n <= 60 ? 74 : n <= 100 ? 62 : n <= 140 ? 54 : 46;
};

async function basePublicId(imageUrl, folder) {
  const m = isOurCloudinary(imageUrl) && imageUrl.match(/\/image\/upload\/(?:.*?\/)?v\d+\/(.+?)\.[a-z0-9]+(\?.*)?$/i);
  if (m && !/\/l_/.test(imageUrl)) return m[1];
  return (await cloudinary.uploader.upload(imageUrl, { resource_type: 'image', folder })).public_id;
}

/**
 * Writes the question on the picture. style: 'band' (white words on a soft dark band, the
 * default: readable on any picture) or 'outline' (white words, black outline, no band).
 * Returns { url, base_url }.
 */
export async function composeQuestionCard({ imageUrl, text, style = 'band', folder = 'bookofmemes/quiz-cards' }) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 220);
  if (!words) throw Object.assign(new Error('Write the question first'), { status: 400 });
  const publicId = await basePublicId(imageUrl, `${folder}/base`);
  const size = cardFontSize(words);
  // 'band' (checked visually 2026-11-24): white bold words on a see-through dark band, readable
  // on any picture. 'outline': the classic meme look (white, black stroke), no band.
  const textLayer = style === 'outline'
    ? { overlay: { font_family: 'Arial', font_size: size, font_weight: 'bold', stroke: 'stroke', text_align: 'center', text: words }, color: 'white', border: '5px_solid_black', width: 920, crop: 'fit' }
    : { overlay: { font_family: 'Arial', font_size: size, font_weight: 'bold', text_align: 'center', text: words }, color: 'white', background: 'rgb:00000099', width: 920, crop: 'fit' };
  const transformation = [
    { width: CARD_SIZE, height: CARD_SIZE, crop: 'fill', gravity: 'auto' },
    textLayer,
    { flags: 'layer_apply', gravity: 'center' },
  ];
  const url = cloudinary.url(publicId, { secure: true, transformation });
  const check = await fetch(url);
  if (!check.ok) throw new Error(`card ${check.status} ${check.headers.get('x-cld-error') || ''}`);
  const kept = await cloudinary.uploader.upload(url, { resource_type: 'image', folder });
  return { url: kept.secure_url, base_url: imageUrl };
}
