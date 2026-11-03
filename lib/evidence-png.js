/**
 * lib/evidence-png.js — the PNG reader behind the `pixel` and `screenshot`
 * receipts (COMP-DOGFOOD-EVIDENCE-GATE-1).
 *
 * node:zlib only. `pngjs` sits in node_modules as a transitive dependency of
 * `qrcode`, not of compose, so importing it would be an undeclared dependency
 * that breaks the day qrcode drops it. A screenshot (macOS `screencapture`,
 * Playwright, Chrome) is 8-bit RGB or RGBA, non-interlaced, which is what this
 * decodes; anything else is refused with the reason, never sampled wrongly.
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** colour type → channels per pixel (8-bit). 3 = palette index. */
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function chunks(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG (bad signature)');
  const out = [];
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    if (off + 12 + len > buf.length) throw new Error(`truncated PNG chunk ${type}`);
    out.push({ type, data: buf.subarray(off + 8, off + 8 + len) });
    off += 12 + len;
    if (type === 'IEND') break;
  }
  return out;
}

function header(list) {
  const ihdr = list.find((c) => c.type === 'IHDR');
  if (!ihdr || ihdr.data.length < 13) throw new Error('PNG has no IHDR');
  const d = ihdr.data;
  return { width: d.readUInt32BE(0), height: d.readUInt32BE(4), bitDepth: d[8], colorType: d[9], interlace: d[12] };
}

/** Width and height from the IHDR alone (the `screenshot` region check). */
export function pngSize(path) {
  const { width, height } = header(chunks(readFileSync(path)));
  return { width, height };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Decode a PNG to RGB rows. Returns `{ width, height, pixel(x, y) → [r, g, b] }`.
 * Throws with the reason for anything it does not decode.
 */
export function decodePng(path) {
  const list = chunks(readFileSync(path));
  const h = header(list);
  const ch = CHANNELS[h.colorType];
  if (!ch) throw new Error(`PNG colour type ${h.colorType} is not supported`);
  if (h.bitDepth !== 8) throw new Error(`PNG bit depth ${h.bitDepth} is not supported (8 only)`);
  if (h.interlace !== 0) throw new Error('interlaced PNG is not supported');
  const plte = list.find((c) => c.type === 'PLTE')?.data;
  if (h.colorType === 3 && !plte) throw new Error('palette PNG has no PLTE');
  const raw = inflateSync(Buffer.concat(list.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  const stride = h.width * ch;
  if (raw.length < (stride + 1) * h.height) throw new Error('PNG image data is shorter than its size');
  const px = Buffer.alloc(stride * h.height);
  for (let y = 0; y < h.height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i];
      const a = i >= ch ? px[dst + i - ch] : 0;
      const b = y > 0 ? px[dst - stride + i] : 0;
      const c = i >= ch && y > 0 ? px[dst - stride + i - ch] : 0;
      let v;
      switch (f) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: v = x + paeth(a, b, c); break;
        default: throw new Error(`PNG row ${y} has unknown filter ${f}`);
      }
      px[dst + i] = v & 0xff;
    }
  }
  return {
    width: h.width,
    height: h.height,
    pixel(x, y) {
      const o = y * stride + x * ch;
      if (h.colorType === 0 || h.colorType === 4) return [px[o], px[o], px[o]];
      if (h.colorType === 3) return [plte[px[o] * 3], plte[px[o] * 3 + 1], plte[px[o] * 3 + 2]];
      return [px[o], px[o + 1], px[o + 2]];
    },
  };
}
