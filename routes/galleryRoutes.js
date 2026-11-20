// Bascardo Gallery API (migration 072, utils/gallery.js).
//   GET    /api/gallery?kind=image|video|audio&before=<iso>   my Bascardo creations and uploads
//   GET    /api/gallery/posts?kind=image|video|audio          media from my published posts
//   POST   /api/gallery   { url, kind }                       keep a file uploaded from the phone
//   DELETE /api/gallery/:id                                   remove from the gallery (published posts keep their media)
import express from 'express';
import { supabase } from '../config/db.js';
import { authenticateToken } from '../auth.js';
import { isOurCloudinary } from '../utils/gallery.js';

const router = express.Router();
const KINDS = ['image', 'video', 'audio'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE = 60;
const fail = (res, status, error) => res.status(status).json({ success: false, error });

router.get('/', authenticateToken, async (req, res) => {
  let q = supabase.from('gallery_assets').select('id, kind, url, source, feature, prompt, duration_seconds, created_at')
    .eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(PAGE);
  if (KINDS.includes(req.query.kind)) q = q.eq('kind', req.query.kind);
  if (req.query.before && !Number.isNaN(Date.parse(req.query.before))) q = q.lt('created_at', new Date(req.query.before).toISOString());
  const { data, error } = await q;
  if (error) return fail(res, 500, 'Could not load your gallery');
  res.json({ success: true, data: data || [], more: (data || []).length === PAGE });
});

// Media already in the user's published posts, so it can be reused too.
const POST_MEDIA = [
  { table: 'memes', type: 'memes', fields: [['image_url', 'image']] },
  { table: 'stories', type: 'stories', fields: [['cover_image_url', 'image']] },
  { table: 'kids_collections', type: 'kids_collections', fields: [['cover_image_url', 'image']] },
  { table: 'books_library', type: 'books_library', fields: [['cover_image_url', 'image']] },
  { table: 'music_box', type: 'music_box', fields: [['cover_image_url', 'image'], ['audio_url', 'audio']] },
  { table: 'podcast_box', type: 'podcast_box', fields: [['cover_image_url', 'image'], ['audio_url', 'audio']] },
  { table: 'tv_box', type: 'tv_box', fields: [['thumbnail_url', 'image'], ['video_url', 'video']] },
];

router.get('/posts', authenticateToken, async (req, res) => {
  const kind = KINDS.includes(req.query.kind) ? req.query.kind : null;
  const out = [];
  await Promise.all(POST_MEDIA.map(async ({ table, type, fields }) => {
    const wanted = fields.filter(([, k]) => !kind || k === kind);
    if (!wanted.length) return;
    const { data } = await supabase.from(table).select(`id, title, created_at, ${wanted.map(([c]) => c).join(', ')}`)
      .eq('author_id', req.user.id).order('created_at', { ascending: false }).limit(40);
    for (const row of data || []) {
      for (const [col, k] of wanted) {
        if (row[col] && /^https:\/\//.test(row[col])) out.push({ id: `${type}:${row.id}:${col}`, kind: k, url: row[col], item_type: type, item_id: row.id, title: row.title, created_at: row.created_at });
      }
    }
  }));
  if (!kind || kind === 'image') {
    const { data } = await supabase.from('book_pages').select('id, book_id, page_number, image_url, created_at')
      .eq('author_id', req.user.id).not('image_url', 'is', null).order('created_at', { ascending: false }).limit(40);
    for (const p of data || []) {
      if (/^https:\/\//.test(p.image_url)) out.push({ id: `book_pages:${p.id}`, kind: 'image', url: p.image_url, item_type: 'books_library', item_id: p.book_id, title: `Page ${p.page_number}`, created_at: p.created_at });
    }
  }
  const seen = new Set();
  const unique = out.filter((m) => (seen.has(m.url) ? false : seen.add(m.url)));
  unique.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  res.json({ success: true, data: unique.slice(0, 120) });
});

// A file the user uploaded from their phone (already on our Cloudinary via /api/upload).
router.post('/', authenticateToken, async (req, res) => {
  const url = String(req.body?.url || '');
  const kind = String(req.body?.kind || '');
  if (!KINDS.includes(kind)) return fail(res, 400, 'Unknown kind of file');
  if (!isOurCloudinary(url)) return fail(res, 400, 'Upload the file first');
  const { data, error } = await supabase.from('gallery_assets')
    .upsert({ user_id: req.user.id, kind, url, source: 'upload', feature: 'upload' }, { onConflict: 'user_id,url' })
    .select('id, kind, url, source, feature, prompt, duration_seconds, created_at').single();
  if (error) return fail(res, 500, 'Could not save to your gallery');
  res.json({ success: true, data });
});

router.delete('/:id', authenticateToken, async (req, res) => {
  if (!UUID.test(req.params.id)) return fail(res, 404, 'Not found');
  const { error } = await supabase.from('gallery_assets').delete().eq('id', req.params.id).eq('user_id', req.user.id);
  if (error) return fail(res, 500, 'Could not remove it');
  res.json({ success: true });
});

export default router;
