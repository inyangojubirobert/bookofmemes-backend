import express from 'express';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import { Readable } from 'stream';

/*
  Add to Backend/.env:
    CLOUDINARY_CLOUD_NAME=your_cloud_name
    CLOUDINARY_API_KEY=your_api_key
    CLOUDINARY_API_SECRET=your_api_secret
*/

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'application/pdf'];
    cb(null, allowed.includes(file.mimetype));
  },
});

const uploadToCloudinary = (buffer, options) =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
    Readable.from(buffer).pipe(stream);
  });

// POST /api/upload/message-media
// Form-data: { file: <binary>, type: 'image'|'video'|'file' }
router.post('/message-media', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  try {
    const isVideo = req.file.mimetype.startsWith('video/');
    const result = await uploadToCloudinary(req.file.buffer, {
      folder: 'bookofmemes/messages',
      resource_type: isVideo ? 'video' : 'auto',
    });

    res.json({
      url: result.secure_url,
      public_id: result.public_id,
      resource_type: result.resource_type,
      width: result.width,
      height: result.height,
      format: result.format,
      bytes: result.bytes,
    });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// POST /api/upload/group-avatar
router.post('/group-avatar', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  try {
    const result = await uploadToCloudinary(req.file.buffer, {
      folder: 'bookofmemes/group-avatars',
      transformation: [{ width: 400, height: 400, crop: 'fill', gravity: 'face' }],
    });
    res.json({ url: result.secure_url });
  } catch (err) {
    console.error('Group avatar upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

export default router;
