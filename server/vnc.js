// Minimal RFB 3.8 server over WebSocket, bridging the live iRMC AVR stream
// (IrmcClient framebuffer) to a browser VNC client (noVNC-style, canvas).
// Security: none (the WebSocket endpoint is authenticated by session token),
// raw encoding only. Keyboard/mouse events are forwarded to the iRMC.

const RFB = Buffer.from('RFB 003.008\n', 'ascii');

// iRMC 0xd1 KeyStateChange wants a USB HID usage code (u16le). noVNC instead
// sends X11 keysyms over RFB (e.g. 'a'=0x61, Enter=0xff0d). Shift/alt/ctrl
// arrive as *separate* modifier keysym events, so here each keysym maps to its
// BASE (unshifted) HID code and the modifier state is driven by those events.
const KEYSYM_TO_HID = {
  // letters (both cases -> base key)
  0x61: 4, 0x62: 5, 0x63: 6, 0x64: 7, 0x65: 8, 0x66: 9, 0x67: 10, 0x68: 11,
  0x69: 12, 0x6a: 13, 0x6b: 14, 0x6c: 15, 0x6d: 16, 0x6e: 17, 0x6f: 18, 0x70: 19,
  0x71: 20, 0x72: 21, 0x73: 22, 0x74: 23, 0x75: 24, 0x76: 25, 0x77: 26, 0x78: 27,
  0x79: 28, 0x7a: 29,
  0x41: 4, 0x42: 5, 0x43: 6, 0x44: 7, 0x45: 8, 0x46: 9, 0x47: 10, 0x48: 11,
  0x49: 12, 0x4a: 13, 0x4b: 14, 0x4c: 15, 0x4d: 16, 0x4e: 17, 0x4f: 18, 0x50: 19,
  0x51: 20, 0x52: 21, 0x53: 22, 0x54: 23, 0x55: 24, 0x56: 25, 0x57: 26, 0x58: 27,
  0x59: 28, 0x5a: 29,
  0x20: 44, // space
  0x30: 39, 0x31: 30, 0x32: 31, 0x33: 32, 0x34: 33, 0x35: 34,
  0x36: 35, 0x37: 36, 0x38: 37, 0x39: 38,
  // unshifted punctuation
  0x2d: 45, 0x3d: 46, 0x5b: 47, 0x5d: 48, 0x5c: 49, 0x3b: 51,
  0x27: 52, 0x60: 53, 0x2c: 54, 0x2e: 55, 0x2f: 56,
  // shifted punctuation -> base key (shift handled by modifier events)
  0x21: 30, 0x40: 31, 0x23: 32, 0x24: 33, 0x25: 34, 0x5e: 35,
  0x26: 36, 0x2a: 37, 0x28: 38, 0x29: 39, 0x5f: 45, 0x2b: 46,
  0x7b: 47, 0x7d: 48, 0x7c: 49, 0x3a: 51, 0x22: 52, 0x7e: 53,
  0x3c: 54, 0x3e: 55, 0x3f: 56,
  // specials / navigation
  0xff08: 42, 0xff09: 43, 0xff0d: 40, 0xff1b: 41, 0x7f: 42, 0xffff: 76,
  0xff50: 74, 0xff57: 77, 0xff55: 75, 0xff56: 78, 0xff63: 73,
  0xff51: 80, 0xff52: 82, 0xff53: 79, 0xff54: 81,
  0xff61: 70, 0xff13: 72, 0xff14: 71, 0xff7f: 83, 0xffe5: 57,
  0xff8d: 40, // KP_Enter
  // function keys
  0xffbe: 58, 0xffbf: 59, 0xffc0: 60, 0xffc1: 61, 0xffc2: 62, 0xffc3: 63,
  0xffc4: 64, 0xffc5: 65, 0xffc6: 66, 0xffc7: 67, 0xffc8: 68, 0xffc9: 69,
  // modifiers (sent as their own events)
  0xffe1: 225, 0xffe2: 229, 0xffe3: 224, 0xffe4: 228,
  0xffe9: 226, 0xffea: 230, 0xffeb: 227, 0xffec: 231,
};

export function attachVnc(ws, sess) {
  // sess: { fb(), subscribe(cb), unsubscribe(cb), key(scancode,down), mouseMove(x,y), buttonState(x,y,mask), onClose() }
  const write = (b) => { if (ws.readyState === 1) ws.send(b); };

  let buf = Buffer.alloc(0);
  let phase = 'version';
  let clientFmt = null; // {bpp, redShift, greenShift, blueShift, redMax, greenMax, blueMax}
  let keepalive = null;

  // Update scheduling: iRMC frames are pushed; coalesce to at most one wire
  // update per tick and never queue unbounded (backpressure), otherwise the
  // browser renders minutes-old frames and input appears to lag by tens of s.
  let pendingRects = null;   // null = nothing pending; [] merges to full screen
  let pendingFull = false;
  let flushTimer = null;
  let flushing = false;
  const MAX_BUFFERED = 1 << 20; // skip frames while >1MB is unsent in the socket
  const FRAME_MS = 40;          // ~25 fps cap

  // FramebufferSize last told to noVNC; a change -> emit DesktopSize + full.
  let sentW = 0, sentH = 0;

  const frameCb = (fb, rects) => {
    if (phase !== 'ready') return;
    if (pendingRects === null) pendingRects = [];
    if (rects && rects.length) pendingRects.push(...rects);
    scheduleFlush();
  };

  // Registered by the session for periodic "keyframe" (full redraw) requests.
  const forceFullCb = () => {
    if (phase !== 'ready') return;
    pendingRects = null;
    pendingFull = true;
    scheduleFlush();
  };
  if (sess.onFull) sess.onFull(forceFullCb);

  function scheduleFlush() {
    if (flushTimer || flushing || phase !== 'ready') return;
    flushTimer = setTimeout(() => { flushTimer = null; doFlush(); }, FRAME_MS);
  }

  function sizeOf() { return (sess.fbSize ? sess.fbSize() : sess.fb()); }

  function doFlush() {
    if (flushing) return;
    flushing = true;
    try {
      if (ws.readyState !== 1) return;
      if (ws.bufferedAmount > MAX_BUFFERED) {
        // Client can't keep up: drop the stale partial queue, resend a full
        // frame once the socket drains.
        pendingRects = null;
        pendingFull = true;
        setTimeout(scheduleFlush, 100);
        return;
      }
      const d = sizeOf();
      // Resolution changed under us -> full redraw (client display was cleared
      // by DesktopSize). sentW==0 marks the very first frame (matches ServerInit).
      if (d.width !== sentW || d.height !== sentH) {
        pendingRects = null;
        pendingFull = true;
      }
      const full = pendingFull || pendingRects === null;
      const rects = pendingRects;
      pendingRects = null;
      pendingFull = false;
      if (full) sendUpdate(null);
      else if (rects && rects.length) sendUpdate(rects);
    } finally {
      flushing = false;
    }
  }

  function fail(msg) { try { ws.close(1002, msg); } catch {} atexit(); }

  function atexit() {
    if (keepalive) clearInterval(keepalive);
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (sess.offFull) sess.offFull(forceFullCb);
    sess.unsubscribe(frameCb);
  }

  function sendUpdate(rects) {
    const d = sizeOf();
    const w = d.width, h = d.height;
    if (!w || !h) return;
    // Validate rects; too many small rects -> one full-screen rect.
    let rs;
    if (rects && rects.length) {
      rs = rects.filter((r) => r.w > 0 && r.h > 0 && r.x >= 0 && r.y >= 0 && r.x < w && r.y < h);
      if (rs.length > 64) rs = null;
    } else rs = null;
    if (!rs) rs = [{ x: 0, y: 0, w, h }];
    const fb = sess.fb(rs); // expand only the regions we are about to send
    // RFB FramebufferUpdate layout REQUIRES each rect header to be immediately
    // followed by its own data: [msg hdr][hdr1][pix1][hdr2][pix2]... NOT all
    // headers first then all payloads (noVNC reads them interleaved -> desync
    // once numRects >= 2).
    let numRects = rs.length;
    const leads = [];
    // DesktopSize без условия sentW!==0: если WS-клиент подключился ДО первого
    // IVTP-кадра, ServerInit ушёл с 0x0 (canvas noVNC 0x0), и БЕЗ DesktopSize
    // первый реальный кадр рендерился в нулевой canvas (невидим).
    if (w !== sentW || h !== sentH) {
      const ds = Buffer.alloc(12);
      ds.writeUInt16BE(0, 0);
      ds.writeUInt16BE(0, 2);
      ds.writeUInt16BE(w, 4);
      ds.writeUInt16BE(h, 6);
      ds.writeUInt32BE(0xFFFFFF21, 8); // DesktopSize (-223)
      leads.push(ds);
      numRects += 1;
    }
    sentW = w; sentH = h;
    const msg = Buffer.alloc(4);
    msg[0] = 0; // FramebufferUpdate
    msg[1] = 0;
    msg.writeUInt16BE(numRects, 2);
    const parts = [msg, ...leads];
    for (const r of rs) {
      const W = Math.min(r.w, w - r.x);
      const H = Math.min(r.h, h - r.y);
      const rh = Buffer.alloc(12);
      rh.writeUInt16BE(r.x, 0);
      rh.writeUInt16BE(r.y, 2);
      rh.writeUInt16BE(W, 4);
      rh.writeUInt16BE(H, 6);
      rh.writeUInt32BE(0, 8); // Raw encoding
      const conv = convertRect(fb, r.x, r.y, W, H);
      parts.push(rh, conv);
    }
    const composed = Buffer.concat(parts);
    write(composed);
  }

  const DEFAULT_FMT = { bpp: 32, depth: 24, bigEndian: 0, trueColor: 1, redMax: 255, greenMax: 255, blueMax: 255, redShift: 16, greenShift: 8, blueShift: 0 };

  // Honour the client's SetPixelFormat (noVNC requests its own format); if we
  // ignore it and force 32bpp, noVNC misreads the byte stream -> garbled image.
  function convertRect(fb, x, y, W, H) {
    const fmt = clientFmt || DEFAULT_FMT;
    const bpp = fmt.bpp || 32;
    const bppB = Math.max(1, Math.round(bpp / 8));
    const out = Buffer.alloc(W * H * bppB);
    const pix = fb.pix, w = fb.width;
    const redMax = fmt.redMax || 255, greenMax = fmt.greenMax || 255, blueMax = fmt.blueMax || 255;
    const rs = fmt.redShift || 0, gs = fmt.greenShift || 0, bs = fmt.blueShift || 0;
    const big = !!fmt.bigEndian;
    // Fast path: 32bpp little-endian full-range RGB with shifts 16/8/0. pix is
    // a Uint32Array of 0x00RRGGBB; on LE hosts its bytes already ARE B,G,R,0,
    // so blit rows without touching individual pixels.
    if (pix && bpp >= 24 && !big && redMax === 255 && greenMax === 255 && blueMax === 255
        && rs === 16 && gs === 8 && bs === 0) {
      const src = Buffer.from(pix.buffer, pix.byteOffset, pix.byteLength);
      for (let yy = 0; yy < H; yy++) {
        const rowStart = ((y + yy) * w + x) * 4;
        src.copy(out, yy * W * 4, rowStart, rowStart + W * 4);
        if (bppB === 3) {
          // squeeze 4-byte pixels to 3 bytes each
          for (let xx = W - 1; xx >= 0; xx--) {
            const s = yy * W * 4 + xx * 4, d = yy * W * 3 + xx * 3;
            out[d] = out[s]; out[d + 1] = out[s + 1]; out[d + 2] = out[s + 2];
          }
        }
      }
      return out;
    }
    let o = 0;
    for (let yy = 0; yy < H; yy++) {
      let i = (y + yy) * w + x;
      for (let xx = 0; xx < W; xx++) {
        const v = pix ? pix[i] : 0;
        const r = (v >>> 16) & 255, g = (v >>> 8) & 255, b = v & 255;
        const R = Math.round(r * redMax / 255), G = Math.round(g * greenMax / 255), B = Math.round(b * blueMax / 255);
        if (bpp === 32) {
          // Учитываем РЕАЛЬНЫЕ сдвиги клиента и endianness (раньше жёстко
          // B,G,R — ломало клиентов с redShift=0/blueShift=16 → оранжевый).
          const px = ((R << rs) | (G << gs) | (B << bs)) >>> 0;
          if (big) { out[o] = (px >>> 24) & 0xFF; out[o + 1] = (px >>> 16) & 0xFF; out[o + 2] = (px >>> 8) & 0xFF; out[o + 3] = px & 0xFF; }
          else { out[o] = px & 0xFF; out[o + 1] = (px >>> 8) & 0xFF; out[o + 2] = (px >>> 16) & 0xFF; out[o + 3] = (px >>> 24) & 0xFF; }
        } else if (bpp >= 24 && bpp < 32) {
          // 24bpp: общий случай — порядок RGB по сдвигам, 3 байта без альфы.
          if (big) { out[o] = R; out[o + 1] = G; out[o + 2] = B; }
          else { out[o] = B; out[o + 1] = G; out[o + 2] = R; }
        } else if (bpp === 16) {
          const px = (R << rs) | (G << gs) | (B << bs);
          if (big) { out[o] = (px >> 8) & 0xFF; out[o + 1] = px & 0xFF; }
          else { out[o] = px & 0xFF; out[o + 1] = (px >> 8) & 0xFF; }
        } else { // 8bpp truecolor palette-ish: send index as grey
          const idx = Math.round((r * 0.299 + g * 0.587 + b * 0.114));
          out[o] = idx;
        }
        o += bppB;
        i++;
      }
    }
    return out;
  }

  function sendPixelFormat() {
    // 32bpp depth24 true-color, RGB shifts 16/8/0 (bytes B,G,R,X)
    const pf = Buffer.alloc(16);
    pf[0] = 32;            // bits-per-pixel
    pf[1] = 24;            // depth
    pf[2] = 0;             // big-endian
    pf[3] = 1;             // true-color
    pf.writeUInt16BE(255, 4);   // red max
    pf.writeUInt16BE(255, 6);   // green max
    pf.writeUInt16BE(255, 8);   // blue max
    pf[10] = 16;           // red shift
    pf[11] = 8;            // green shift
    pf[12] = 0;            // blue shift
    const fb = sess.fb();
    const name = Buffer.from('iRMC AVR', 'latin1');
    const hdr = Buffer.alloc(4 + 16 + 4 + name.length);
    hdr.writeUInt16BE(fb.width, 0);
    hdr.writeUInt16BE(fb.height, 2);
    pf.copy(hdr, 4);
    hdr.writeUInt32BE(name.length, 20);
    name.copy(hdr, 24);
    write(hdr);
  }

  function sendSecurityNone() {
    const s = Buffer.from([1, 1]); // count=1, SecurityNone
    write(s);
  }

  // ---- input ------------------------------------------------------------
  function onKeyEvent(p) {
    if (p.length < 8) return;
    // RFB KeyEvent: [type=4][down-flag][pad][pad][keysym(u32)]
    const down = p[1] !== 0;
    const keysym = p.readUInt32BE(4);
    const hid = KEYSYM_TO_HID[keysym];
    if (hid) sess && sess.key && sess.key(hid, down);
  }
  // Legacy parity (MouseAbsoluteDelegate): MouseMove(181) on every movement,
  // ButtonStateAtAbsolute(179) only when the button/wheel state changes.
  // VNC wheel bits 8/16 -> iRMC trackwheel rotation -1/+1 (64±1).
  let lastInputState = -1;
  function onPointerEvent(p) {
    if (p.length < 6) return;
    // RFB PointerEvent: [type=5][button-mask][x(u16)][y(u16)]
    const vncMask = p[1]; // VNC: 1=left,2=middle,4=right, 8=wheelup,16=wheeldown
    const px = p.readUInt16BE(2);
    const py = p.readUInt16BE(4);
    // map to iRMC button mask: bit0 left, bit1 right, bit2 middle
    const mask = ((vncMask & 1) ? 1 : 0) | ((vncMask & 4) ? 2 : 0) | ((vncMask & 2) ? 4 : 0);
    const wheel = (vncMask & 16) ? 1 : (vncMask & 8) ? -1 : 0;
    const state = mask | (wheel ? vncMask & 24 : 0);
    sess && sess.mouseMove && sess.mouseMove(px, py);
    if (state !== lastInputState) {
      lastInputState = state;
      sess && sess.buttonState && sess.buttonState(px, py, mask, wheel);
    }
  }

  function onClientMessage(p) {
    const t = p[0];
    if (t === 0) { // SetPixelFormat (accept; we always send 32bpp)
      clientFmt = { bpp: p[4], depth: p[5], bigEndian: p[6], trueColor: p[7],
        redMax: p.readUInt16BE(8), greenMax: p.readUInt16BE(10), blueMax: p.readUInt16BE(12),
        redShift: p[14], greenShift: p[15], blueShift: p[16] };
      if (process.env.IRMC_DEBUG === '1') console.log('[vnc] clientFmt =', JSON.stringify(clientFmt));
    } else if (t === 2) { // SetEncodings — ignore (raw only)
    } else if (t === 3) { // FramebufferUpdateRequest
      const incremental = p[1] !== 0;
      if (incremental) {
        // Push-driven: a full screen is sent only when the socket drained and is
        // marked stale; otherwise this re-arm request is a no-op.
        scheduleFlush();
      } else {
        pendingRects = null;
        pendingFull = true;
        scheduleFlush();
      }
    } else if (t === 4) {
      onKeyEvent(p);
    } else if (t === 5) {
      onPointerEvent(p);
    } else if (t === 6) { // ClientCutText
    }
  }

  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    let chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    buf = Buffer.concat([buf, chunk]);
    try {
      if (phase === 'version') {
        if (buf.length < 12) return;
        const ver = buf.slice(0, 12).toString('ascii');
        if (!/^RFB 003\.\d{3}\n$/.test(ver)) return fail('bad version');
        buf = buf.slice(12);
        sendSecurityNone();
        phase = 'security';
      } else if (phase === 'security') {
        if (buf.length < 1) return;
        const sec = buf[0];
        if (sec !== 1) return fail('security type not supported');
        buf = buf.slice(1);
        const ok = Buffer.alloc(4);
        write(ok); // SecurityResult OK
        phase = 'clientinit';
      } else if (phase === 'clientinit') {
        if (buf.length < 1) return;
        // shared flag ignored
        buf = buf.slice(1);
        sendPixelFormat();
        phase = 'ready';
        sess.subscribe(frameCb);
        sendUpdate(null);   // initial full frame
      } else if (phase === 'ready') {
        // message type + length
        if (buf.length < 4) return;
        const t = buf[0];
        let need = 4;
        if (t === 3) need = 10;      // FBUpdateRequest
        else if (t === 4) need = 8;  // KeyEvent
        else if (t === 5) need = 6;  // PointerEvent
        else if (t === 6) need = 8 + buf.readUInt32BE(4); // ClientCutText
        else if (t === 0) need = 20; // SetPixelFormat
        else if (t === 2) need = 4 + buf.readUInt16BE(2) * 4; // SetEncodings: type,pad,nenc(u16),nenc*4
        if (buf.length < need) return;
        onClientMessage(buf.slice(0, need));
        buf = buf.slice(need);
      }
    } catch { fail('decode error'); }
  });

  ws.on('close', () => atexit());
  ws.on('error', () => atexit());

  write(RFB);
  ws.on('pong', () => {});
}
