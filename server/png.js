// Minimal PNG (RGB, 8-bit, colour type 2) encoder + save-to-file helper.
import zlib from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SHOT_DIR = path.join(__dirname, '..', 'screenshots');

let crcTable = null;
function crc32(b) {
  if (!crcTable) { crcTable = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; } }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// pix: Uint32Array of 0x00RRGGBB, width x height.
export function encodePng(width, height, pix) {
  const W = width | 0, H = height | 0;
  if (!W || !H) return null;
  const raw = Buffer.alloc((W * 3 + 1) * H);
  let o = 0;
  for (let y = 0; y < H; y++) {
    raw[o++] = 0;
    for (let x = 0; x < W; x++) {
      const v = (pix[(y * W + x)] >>> 0);
      raw[o++] = (v >>> 16) & 255;
      raw[o++] = (v >>> 8) & 255;
      raw[o++] = v & 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Save a labelled, timestamped screenshot into the project's screenshots/ dir.
export function saveScreenshot(label, width, height, pix) {
  const png = encodePng(width, height, pix);
  if (!png) return null;
  mkdirSync(SHOT_DIR, { recursive: true });
  const ts = Math.floor(Date.now() / 1000);
  const safe = String(label || 'shot').replace(/[^\w\-]+/g, '_').slice(0, 40);
  const file = path.join(SHOT_DIR, `${ts}_${safe}.png`);
  writeFileSync(file, png);
  return file;
}
