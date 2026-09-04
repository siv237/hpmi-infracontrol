// Framebuffer decoder for the Avocent/Mahogany (Fujitsu iRMC AVR) video stream.
// Faithful port of com.serverengines.mahogany.PixelBufferImage / GraphicsMgr.
//
// Internal representation: Uint32Array `pix` of 0x00RRGGBB (width*height).
// For 8bpp palette modes we fill `idx` (palette indices) instead; the VNC
// layer always consumes true-colour 0xRRGGBB via getRGB().

const TRIPLET = 85, REPEAT = 170;

const SHIFT_3BPP_16 = [4, 10, 15];
const SHIFT_3BPP_24 = [7, 15, 23];
const SHIFT_8BPP_16 = [3, 4, 7, 8, 9, 10, 14, 15];
const SHIFT_8BPP_24 = [6, 7, 12, 13, 14, 15, 22, 23];
const MASK_3BPP_16 = [16, 1024, 32768];
const MASK_3BPP_24 = [128, 32768, 0x800000];
const MASK_8BPP_16 = [24, 1920, 49152];
const MASK_8BPP_24 = [192, 61440, 0xC00000];
const INTENSE_16 = [31, 2016, 63488];
const INTENSE_24 = [255, 65280, 0xFF0000];
const GREY_16 = 50712, WHITE_16 = 51096;
const GREY_24 = 0xC0C0C0, WHITE_24 = 0xC0F0C0;

export class IrmcFramebuffer {
  constructor() {
    this.width = 0;
    this.height = 0;
    this.bpp = 0;
    this.mode = -1;
    this.pix = new Uint32Array(0);
    this.idx = new Uint8Array(0);
    this.palette = new Uint32Array(256);
    this.isText = false;
    this.special4bpp = false;
    this._dirty = [];
    // cached 8bpp palette expansion + invalidation counter
    this._rgb = null;
    this.paletteVer = 0;
    this._paletteVer = -1;
  }

  setVesaMode(mode, bpp, w, h) {
    const eff = (bpp < 8) ? 8 : (bpp === 15 ? 16 : bpp);
    if (w * h !== this.pix.length || mode !== this.mode || eff !== this.bpp) {
      this.mode = mode;
      this.bpp = eff;
      this.width = w;
      this.height = h;
      this.pix = new Uint32Array(w * h);
      this.idx = new Uint8Array(w * h);
      this.isText = false;
      this.special4bpp = false;
    }
  }

  standbyPower() {
    this.pix.fill(0);
    this.idx.fill(0);
    this.dirtyPush({ x: 0, y: 0, w: this.width, h: this.height });
  }

  setPalette(paletteArray, paletteSize) {
    for (let i = 0; i < paletteSize && i < 256; i++) this.palette[i] = paletteArray[i] >>> 0;
    this.paletteVer++; // invalidate the 8bpp palette-expansion cache
  }

  dirtyPush(r) {
    if (r.w > 0 && r.h > 0) this._dirty.push(r);
  }
  takeDirty() {
    const d = this._dirty;
    this._dirty = [];
    return d;
  }

  // Render the current buffer into a flat 32bpp RGB array (naturally 0xRRGGBB).
  getRGB() { return this.getRGBFor(null); }

  // Like getRGB() but expands only the given rects from the 8bpp palette index
  // buffer, returning a persistent cached array (no allocation per update).
  getRGBFor(rects) {
    if (this.bpp !== 8) return this.pix;
    if (this.paletteVer !== this._paletteVer) {
      this._paletteVer = this.paletteVer;
      this._rgb = null;
    }
    if (!this._rgb || this._rgb.length !== this.idx.length) this._rgb = new Uint32Array(this.idx.length);
    const rgb = this._rgb;
    const w = this.width;
    if (!rects || !rects.length) {
      for (let i = 0; i < this.idx.length; i++) rgb[i] = this.palette[this.idx[i]] >>> 0;
      return rgb;
    }
    for (const r of rects) {
      const x0 = Math.max(0, r.x), y0 = Math.max(0, r.y);
      const x1 = Math.min(this.width, r.x + r.w), y1 = Math.min(this.height, r.y + r.h);
      for (let y = y0; y < y1; y++) {
        let p = y * w + x0;
        for (let x = x0; x < x1; x++, p++) rgb[p] = this.palette[this.idx[p]] >>> 0;
      }
    }
    return rgb;
  }

  // ---- bitBlt (226) ---------------------------------------------------------
  bitBlt(x, y, w, h, bltType, fontW, fontH, data, offset = 0) {
    if (y + h > this.height) h -= (y + h) - this.height;
    if (x + w > this.width) w -= (x + w) - this.width;
    if (h < 1 || w < 1) return;
    const bppBytes = this.bpp >> 3;
    if (this.bpp > 8) {
      let o = offset;
      for (let i = 0; i < h; i++) {
        let p = (y + i) * this.width + x;
        for (let j = 0; j < w; j++) {
          let px = 0;
          if (this.bpp > 16) px |= (data[o + 2] & 0xFF) << 16;
          px |= (data[o + 1] & 0xFF) << 8;
          px |= data[o] & 0xFF;
          this.pix[p] = px >>> 0;
          o += bppBytes;
          p++;
        }
      }
    } else if (this.bpp === 8 && !this.isText) {
      let o = offset;
      for (let i = 0; i < h; i++) {
        const n = (y + i) * this.width + x;
        for (let j = 0; j < w; j++) this.idx[n + j] = data[o++];
      }
    } else if (this.bpp === 8 && this.isText) {
      // Text mode: fontW/fontH are cell size; we only preserve the index nibbles.
      let o = offset;
      for (let i = 0; i < h; i++) {
        const n = (y + i) * this.width + x;
        for (let j = 0; j < w; j++) this.idx[n + j] = data[o++];
      }
    }
    this.dirtyPush({ x, y, w, h });
  }

  // ---- enhanceBitBlt (227) : raw BLT, tiles selected by snoop map ----------
  enhanceBitBlt(tileW, tileH, tripletCode, repeatCode, rawSize, scrunchSize, snoopLow, snoopHigh, data, offset = 0) {
    const n = tileW & 0xFF, m = tileH & 0xFF;
    const sw = log2shift(n), sh = log2shift(m);
    let tx = Math.min(Math.ceil(this.width / n), 64);
    let ty = Math.min(Math.ceil(this.height / m), 64);
    const bppBytes = this.bpp >> 3;
    let o = offset;
    let nx = 0, ny = 0;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < ty; i++) {
      for (let j = 0; j < tx; j++) {
        const bits = (j < 32) ? (snoopLow[i] >>> 0) : (snoopHigh[i] >>> 0);
        if (!((bits >>> j) & 1)) continue;
        if (minY === Infinity) minY = i;
        maxY = i;
        if (j < minX) minX = j;
        if (j > maxX) maxX = j;
        const tileY = i << sh;
        const rowBase = tileY * this.width;
        const tileX = j << sw;
        for (let k = 0; k < m; k++) {
          if (k + tileY >= this.height) { o += (m - k) * n * bppBytes; break; }
          let p = (k + tileY) * this.width + tileX;
          for (let i2 = 0; i2 < n; i2++) {
            if (i2 + tileX < this.width) {
              if (this.bpp > 8) {
                let px = 0;
                if (this.bpp > 16) px |= (data[o + 2] & 0xFF) << 16;
                px |= (data[o + 1] & 0xFF) << 8;
                px |= data[o] & 0xFF;
                this.pix[p] = px >>> 0;
              } else {
                this.idx[p] = data[o] & 0xFF;
              }
              p++;
            }
            o += bppBytes;
          }
        }
      }
    }
    if (minX !== Infinity) {
      const rx = minX << sw, ry = minY << sh;
      const rw = (maxX << sw) - rx + n, rh = (maxY << sh) - ry + m;
      this.dirtyPush({ x: rx, y: ry, w: rw, h: rh });
    }
  }

  // enhanceBitBlt HLC variant (498): separate triplet/repeat runs per channel.
  // Header (bpp>8): 3 x u32 = blueLen, greenLen, reserved; data starts at +12.
  // blue stream at +12, green at +12+blueLen, red (bpp>16) at +12+blueLen+greenLen
  // (red has no length prefix — it runs to the end of the payload).
  enhanceBitBltHLC(tileW, tileH, tripletCode, repeatCode, rawSize, scrunchSize, snoopLow, snoopHigh, data, offset = 0) {
    const n = tileW & 0xFF, m = tileH & 0xFF;
    const sw = log2shift(n), sh = log2shift(m);
    let tx = Math.min(Math.ceil(this.width / n), 64);
    let ty = Math.min(Math.ceil(this.height / m), 64);
    const tc = tripletCode >>> 0, rc = repeatCode >>> 0;
    const bpp = this.bpp;
    const blueLen = bpp > 8 ? ld32(data, offset) : data.length - offset;
    const greenLen = bpp > 8 ? ld32(data, offset + 4) : 0;
    const blueOff = bpp > 8 ? offset + 12 : offset;
    const greenOff = blueOff + blueLen;
    const redOff = bpp > 16 ? greenOff + greenLen : 0;
    const decB = new Rle(data, blueOff, tc, rc);
    const decG = bpp > 8 ? new Rle(data, greenOff, tc, rc) : null;
    const decR = bpp > 16 ? new Rle(data, redOff, tc, rc) : null;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < ty; i++) {
      for (let j = 0; j < tx; j++) {
        const bits = (j < 32) ? (snoopLow[i] >>> 0) : (snoopHigh[i] >>> 0);
        if (!((bits >>> j) & 1)) continue;
        if (minY === Infinity) minY = i;
        maxY = i;
        if (j < minX) minX = j;
        if (j > maxX) maxX = j;
        const tileY = i << sh, tileX = j << sw;
        for (let k = 0; k < m; k++) {
          // Java walks ALL m rows and only guards the pixel write; the RLE
          // streams must keep being consumed even past the bottom edge,
          // otherwise every following tile decodes from a desynced stream.
          const inY = k + tileY < this.height;
          let p = (k + tileY) * this.width + tileX;
          for (let i2 = 0; i2 < n; i2++) {
            const blue = decB.next();
            if (inY && i2 + tileX < this.width) {
              if (bpp > 8) {
                const green = decG.next();
                const red = bpp > 16 ? decR.next() : 0;
                this.pix[p] = ((red & 0xFF) | ((green & 0xFF) << 8) | ((blue & 0xFF) << 16)) >>> 0;
              } else {
                this.idx[p] = blue & 0xFF;
              }
              p++;
            } else {
              if (bpp > 8) { decG.next(); if (bpp > 16) decR.next(); }
            }
          }
        }
      }
    }
    if (minX !== Infinity) {
      const rx = minX << sw, ry = minY << sh;
      this.dirtyPush({ x: rx, y: ry, w: (maxX << sw) - rx + n, h: (maxY << sh) - ry + m });
    }
  }

  // enhanceBitBlt Force8bpp HLC (501): 8bpp 2-2-4 coded into 16/24bpp.
  enhanceBitBltForce8bppHLC(tileW, tileH, tripletCode, repeatCode, rawSize, scrunchSize, snoopLow, snoopHigh, data, offset = 0) {
    const n = tileW & 0xFF, m = tileH & 0xFF;
    const sw = log2shift(n), sh = log2shift(m);
    let tx = Math.min(Math.ceil(this.width / n), 64);
    let ty = Math.min(Math.ceil(this.height / m), 64);
    const tc = tripletCode >>> 0, rc = repeatCode >>> 0;
    const dec = new Rle(data, offset, tc, rc);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < ty; i++) {
      for (let j = 0; j < tx; j++) {
        const bits = (j < 32) ? (snoopLow[i] >>> 0) : (snoopHigh[i] >>> 0);
        if (!((bits >>> j) & 1)) continue;
        if (minY === Infinity) minY = i;
        maxY = i;
        if (j < minX) minX = j;
        if (j > maxX) maxX = j;
        const tileY = i << sh, tileX = j << sw;
        for (let k = 0; k < m; k++) {
          // Keep consuming the RLE stream past the bottom edge (Java walks all
          // m rows and only guards the write).
          const inY = k + tileY < this.height;
          let p = (k + tileY) * this.width + tileX;
          for (let i2 = 0; i2 < n; i2++) {
            if (inY && i2 + tileX < this.width) {
              const v = dec.next() & 0xFF;
              if (this.bpp > 16) {
                let px = 0;
                let t = v & 0xC0;
                px |= (t === 0xC0) ? 0xFF0000 : (t << 16);
                t = v & 0x3C;
                px |= (t === 0x3C) ? 0xFF00 : (t << 10);
                t = v & 0x03;
                px |= (t === 0x03) ? 0xFF : (t << 6);
                this.pix[p] = px >>> 0;
              } else {
                let px = 0;
                let t = v & 0xC0;
                px |= (t === 0xC0) ? 0xF800 : (t << 8);
                t = v & 0x3C;
                px |= (t === 0x3C) ? 0x07E0 : (t << 5);
                t = v & 0x03;
                px |= (t === 0x03) ? 0x1F : (t << 3);
                this.pix[p] = px >>> 0;
              }
              p++;
            } else {
              dec.next();
            }
          }
        }
      }
    }
    if (minX !== Infinity) {
      const rx = minX << sw, ry = minY << sh;
      this.dirtyPush({ x: rx, y: ry, w: (maxX << sw) - rx + n, h: (maxY << sh) - ry + m });
    }
  }

  // ---- BSE (231) ------------------------------------------------------------
  BSEBitBlt(bltType, top, left, bottom, right, compLen, uncompLen, data, offset = 0) {
    if (bltType === 3) this.BSEBitBlt8(3, top, left, bottom, right, data, offset);
    else if (bltType === 8) this.BSEBitBlt8(8, top, left, bottom, right, data, offset);
  }

  BSEBitBlt8(blt, top, left, bottom, right, data, offset = 0) {
    const hStart = (top & 0xFF) << 5;
    const hEnd = Math.min(((bottom & 0xFF) + 1) << 5, this.height);
    const wStart = (left & 0xFF) << 5;
    const wEnd = Math.min(((right & 0xFF) + 1) << 5, this.width);
    const shift = (this.bpp > 16) ? (blt === 3 ? SHIFT_3BPP_24 : SHIFT_8BPP_24)
                                   : (blt === 3 ? SHIFT_3BPP_16 : SHIFT_8BPP_16);
    const mask = (this.bpp > 16) ? (blt === 3 ? MASK_3BPP_24 : MASK_8BPP_24)
                                   : (blt === 3 ? MASK_3BPP_16 : MASK_8BPP_16);
    const intense = (this.bpp > 16) ? INTENSE_24 : INTENSE_16;
    const grey = (this.bpp > 16) ? GREY_24 : GREY_16;
    const greyInt = grey, white = (this.bpp > 16) ? WHITE_24 : WHITE_16;
    const nChan = (blt === 3) ? 3 : 8;
    let o = offset;
    let repeat = 0, cur = 0;
    for (let ch = 0; ch < nChan; ch++) {
      const shf = shift[ch];
      repeat = 0; // each channel is an independent RLE stream
      for (let y = hStart; y < hEnd; y++) {
        let p = y * this.width + wStart;
        for (let x = wStart; x < wEnd; x += 8) {
          if (repeat < 1) {
            cur = data[o++] & 0xFF;
            if (cur === TRIPLET) { repeat = 3; cur = data[o++] & 0xFF; }
            else if (cur === REPEAT) {
              repeat = data[o++] & 0xFF;
              if (repeat === 1) { repeat = 1; cur = TRIPLET; }
              else if (repeat === 0) { repeat = 1; cur = REPEAT; }
              else { repeat++; cur = data[o++] & 0xFF; }
            } else repeat = 1;
          }
          for (let k = 0; k < 8; k++) {
            const px = y * this.width + x + k;
            if (x + k < wEnd) {
              if (ch === 0) this.pix[px] = ((cur >> k) & 1) << shf;
              else this.pix[px] |= ((cur >> k) & 1) << shf;
            }
          }
          repeat--;
        }
      }
    }
    this.dirtyPush({ x: wStart, y: hStart, w: wEnd - wStart, h: hEnd - hStart });
  }
}

function log2shift(x) {
  let s = 0;
  while (x >> s !== 0) s++;
  return s - 1;
}

function ld32(b, o) {
  return (b[o] & 0xFF) | ((b[o + 1] & 0xFF) << 8) | ((b[o + 2] & 0xFF) << 16) | ((b[o + 3] & 0xFF) << 24);
}

// Stateful triplet/repeat RLE decoder, faithful to the Java counters.
// A run 'count' emits the same value for 'count' consecutive pixels; the
// underlying data pointer only advances when the run is exhausted.
class Rle {
  constructor(data, o, triplet, repeat) {
    this.data = data;
    this.o = o;
    this.triplet = triplet;
    this.repeat = repeat;
    this.counter = 0;
    this.val = 0;
  }
  next() {
    if (this.counter < 1) {
      let v = this.data[this.o++] & 0xFF;
      if (v === this.triplet) {
        this.counter = 3;
        v = this.data[this.o++] & 0xFF;
      } else if (v === this.repeat) {
        this.counter = this.data[this.o++] & 0xFF;
        if (this.counter === 1) { this.counter = 1; v = this.triplet; }
        else if (this.counter === 0) { this.counter = 1; v = this.repeat; }
        else { this.counter++; v = this.data[this.o++] & 0xFF; }
      } else {
        this.counter = 1;
      }
      this.val = v;
    }
    this.counter--;
    return this.val;
  }
}
