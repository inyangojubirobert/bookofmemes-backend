// Where the sound in an audio file really starts. AI sound effects often begin
// with silence (a Mirelo gunshot measured 2026-11-23 had 1.6 s of it), so "the
// shot at 2 s" would land at 3.6 s. Cloudinary draws a waveform PNG of any
// audio/video; the first column with signal is the onset.
import zlib from 'zlib';

// Minimal PNG reader: non-interlaced grayscale / RGB / RGBA, any bit depth ≤ 8.
export function decodePng(buf) {
  if (buf.toString('latin1', 1, 4) !== 'PNG') throw new Error('not a PNG');
  let p = 8, width = 0, height = 0, depth = 8, type = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), kind = buf.toString('latin1', p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + len);
    if (kind === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; type = data[9]; if (data[12]) throw new Error('interlaced PNG'); }
    else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    p += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  const bpp = Math.max(1, (channels * depth) >> 3);
  const stride = Math.ceil((width * channels * depth) / 8);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), o = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[o + x - bpp] : 0, b = y ? out[o - stride + x] : 0, c = y && x >= bpp ? out[o - stride + x - bpp] : 0;
      let v = row[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[o + x] = v & 255;
    }
  }
  // dark(x, y): is this pixel dark (the waveform is black on white)?
  const dark = (x, y) => {
    if (depth < 8) { const bitPos = x * depth * channels; const byte = out[y * stride + (bitPos >> 3)]; const v = (byte >> (8 - depth - (bitPos & 7))) & ((1 << depth) - 1); return v < (1 << depth) / 2; }
    return out[y * stride + x * channels] < 128;
  };
  return { width, height, dark };
}

/** Amplitude per column (0..1) of a Cloudinary waveform. */
export async function waveform(publicId, { width = 400, height = 60 } = {}) {
  const url = `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/video/upload/fl_waveform,w_${width},h_${height},co_black,b_white/${publicId}.png`;
  let r = await fetch(url);
  for (let i = 0; r.status === 423 && i < 10; i++) { await new Promise((x) => setTimeout(x, 2000)); r = await fetch(url); }
  if (!r.ok) throw new Error(`waveform ${r.status}`);
  const img = decodePng(Buffer.from(await r.arrayBuffer()));
  const mid = img.height / 2;
  return Array.from({ length: img.width }, (_, x) => {
    let far = 0;
    for (let y = 0; y < img.height; y++) if (img.dark(x, y)) far = Math.max(far, Math.abs(y - mid));
    return far / mid;
  });
}

/** { leadIn, tail } seconds of silence at the start and end (0 if it can't be measured). */
export async function silenceBounds(publicId, seconds) {
  try {
    const amp = await waveform(publicId);
    // The drawing has a floor (≈0.35 in true silence, measured). Only near-true silence
    // counts as a gap: quiet ambience before a louder part (birds, fire) is real sound.
    const floor = Math.min(...amp);
    const loud = (v) => v > floor + 0.07;
    const first = amp.findIndex(loud);
    if (first < 0 || !seconds) return { leadIn: 0, tail: 0 };
    const last = amp.length - 1 - [...amp].reverse().findIndex(loud);
    const per = seconds / amp.length;
    return { leadIn: Math.max(0, +((first - 1) * per).toFixed(2)), tail: Math.max(0, +((amp.length - 1 - last - 1) * per).toFixed(2)) };
  } catch (err) {
    console.warn('[audio onset]', err.message);
    return { leadIn: 0, tail: 0 };
  }
}
