// Fujitsu iRMC Advanced Video Redirection client (Avocent "Mahogany" protocol).
// Reimplementation of com.serverengines.mahogany.* in Node.js.
//
// Wire format: little-endian, no global framing. Each message starts with a
// 1-byte command id; the remaining fields are self-delimiting. We therefore
// parse sequentially from a growing buffer and roll back the read cursor on a
// short read (NeedMore) until more bytes arrive.

import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { IrmcFramebuffer } from './irmc-decode.js';

// Command ids (client <-> server)
const ID = {
  ServerHandshake: 200, FirmwareVersion: 201, MultiUserState: 197,
  ServerDisconnect: 198, InformVesaMode: 225, BitBlt: 226,
  EnhanceBitBlt: 227, BSEBitBlt: 231, SSPBitBlt: 237,
  LowBandwidthSSPBitBlt: 224, SetPalette: 230, SetTextCursor: 234,
  SpecialGraphicsBit: 235, MatroxGraphicsCursor: 236, StandbyPower: 228,
  InformCPUUtilization: 229, InformKeyIndicators: 213, SequenceNumber: 239,
  StorageStatus: 137, OemMsg: 222, NativeMessage: 248,
  OemCurrentLocalMonitorState: 199, OemLocalMonitorState: 64,
  GraphicsRegisterValue: 238,

  ClientNOP: 210, ClientHandshake: 221, RequestVesaMode: 241,
  Invalidate: 242, InformHLevelCompression: 243,
  ClientAbsoluteMode: 177, ClientRelativeMode: 178,
  ButtonStateAtAbsolute: 179, ButtonStateAtRelative: 180, MouseMove: 181,
  RequestKeyIndicators: 193, KeyStateChange: 209, RequestPrimaryControl: 211,
  RelinquishFullControl: 215, ClientDisconnect: 216, InformSleepMode: 244,
  InformBSEMode: 247, InformForce8BPPMode: 246, InformNativeCapable: 248,
  OemPowerControlAction: 65, SequenceNumberOut: 239,
  StorageClientConnect: 153, StorageClientDisconnect: 154, StorageStatus: 137,
};

const SIG_EMBEDDED = 0x5A5A5A5A;
const SIG_STANDALONE = 0x12121212;
const SIG_DIGEST = 0x13131313;

// Handshake config bits: video|mouse|keyboard|storage0|storage1
const CONFIG_ALL = 31;

class NeedMore extends Error {}
const NEEDMORE = new NeedMore();

// Debug diagnostics gate: enabled via start.sh --debug (env IRMC_DEBUG=1).
const IRMC_DBG = process.env.IRMC_DEBUG === '1';
function irmcDbg() { return IRMC_DBG; }

// Permissive TLS for old iRMC firmware: allow TLS 1.0/1.1 and legacy ciphers /
// SHA-1 signatures. Node defaults to TLSv1.2 + security level 2, which old
// iRMC refuses (ssl_choose_client_version).
function permissiveTls(hard) {
  const legacyReneg =
    (crypto.constants && crypto.constants.SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION) ||
    0x00040000;
  const opts = {
    rejectUnauthorized: false,
    minVersion: 'TLSv1',
    maxVersion: 'TLSv1.2',
    honorCipherOrder: true,
    ciphers: 'ALL:!aNULL:!eNULL:!NULL:@SECLEVEL=0',
    sigalgs: 'RSA-PSS+SHA256:RSA-PSS+SHA384:RSA-PSS+SHA512:'
          + 'RSA+SHA1:RSA+SHA224:RSA+SHA256:RSA+SHA384:RSA+SHA512:'
          + 'ECDSA+SHA1:ECDSA+SHA224:ECDSA+SHA256:ECDSA+SHA384:ECDSA+SHA512',
    // Old iRMC brute-force attempts TLS renegotiation during handshake.
    secureOptions: legacyReneg,
  };
  return opts;
}

class Reader {
  constructor() { this.data = Buffer.alloc(0); this.pos = 0; }
  push(c) { this.data = Buffer.concat([this.data.slice(this.pos), c]); this.pos = 0; }
  avail() { return this.data.length - this.pos; }
  need(n) { if (this.avail() < n) throw NEEDMORE; }
  u8() { this.need(1); return this.data[this.pos++]; }
  u16() { this.need(2); const v = this.data.readUInt16LE(this.pos); this.pos += 2; return v; }
  u32() { this.need(4); const v = this.data.readUInt32LE(this.pos); this.pos += 4; return v; }
  i32() { this.need(4); const v = this.data.readInt32LE(this.pos); this.pos += 4; return v; }
  bool() { return this.u8() !== 0; }
  bytes(n) { this.need(n); const b = this.data.subarray(this.pos, this.pos + n); this.pos += n; return b; }
  string(n) { return this.bytes(n).toString('latin1'); }
  // set cursor back (used on rollback)
  reset(p) { this.pos = p; }
}

export function permissiveTlsOptions() { return permissiveTls(false); }

export class IrmcClient {
  constructor(opts, events = {}) {
    this.opts = opts || {};
    this.events = events; // { onStatus, onFrame, onError, onExit }
    this.sock = null;
    this.reader = new Reader();
    this.fb = new IrmcFramebuffer();
    this.connected = false;
    this.handshakeComplete = false;
    this.privileges = { video: false, mouse: false, keyboard: false, storage: false };
    this.firmware = '';
    this.width = 0;
    this.height = 0;
    this.bpp = 0;
    this.versionSent = false;
    this._invalidateSent = false;
  }

  // ClientNOP is 0xD2 followed by 7 zero bytes (8 bytes total).
  static nop() { const b = Buffer.alloc(8); b[0] = ID.ClientNOP; return b; }

  wire(sig, user, pass, pwdFull, key) {
    const pad = (s, n) => { const b = Buffer.alloc(n); Buffer.from(String(s ?? ''), 'latin1').copy(b); return b; };
    const u32 = (v) => { const x = Buffer.alloc(4); x.writeUInt32LE(v >>> 0); return x; };
    const username = pad(user, 48);
    const password = pad(pass, 48);
    const passwordFull = pad(pwdFull, 228);
    const kk = Buffer.from(String(key ?? ''), 'latin1');
    const parts = [
      u32(sig),
      u32(username.length), u32(password.length), u32(4), u32(kk.length),
      username, password,
      u32(CONFIG_ALL),   // 0x1f config, 4 bytes
      kk,
      passwordFull,
    ];
    return Buffer.concat(parts);
  }

  start() {
    const { host, port = 80, secure = false, username, password, httpdata = '', key = '', digest = '' } = this.opts;
    this._auth = { username, password, httpdata, key, digest };
    return new Promise((resolve, reject) => {
      const onConnect = () => { this.connected = true; resolve(this); };
      const onErr = (e) => {
        const msg = String(e && e.message || e);
        // Old iRMC: retry with ever more permissive TLS, then plaintext.
        const tlsErr = /unsupported protocol|no protocol|wrong version|handshake|version|protocol/i.test(msg);
        if (secure && tlsErr && this._tlsStage === 1) {
          this._tlsStage = 2;
          this.events.onStatus?.('tls-fallback-2');
          this.openSocket(host, port, 'hard', onConnect, onErr);
          return;
        }
        this.events.onError?.(msg); reject(e);
      };
      this._tlsStage = secure ? 1 : 0;
      this.openSocket(host, port, secure ? 'std' : 'plain', onConnect, onErr);
    });
  }

  destroyTls() { try { this.sock && this.sock.destroy(); } catch {} this.sock = null; }

  rawCapture(c) {
    if (!this._raw) this._raw = [];
    for (let i = 0; i < c.length && this._raw.length < 128; i++) {
      this._raw.push(c[i].toString(16).padStart(2, '0'));
    }
  }

  // Unified socket setup. mode: 'plain' TCP | 'std'/'hard' TLS (hard = more permissive).
  openSocket(host, port, mode, onConnect, onErr) {
    const connectedCb = () => {
      this.connected = true;
      try { this.sock.setNoDelay(true); } catch {}
      // On connect only send ClientNOP; the client handshake (0xdd) must be
      // sent AFTER the server's ServerHandshake (0xc8), per the reference.
      this.send(IrmcClient.nop());
      this.events.onStatus?.('connected');
      onConnect(this);
    };
    const opts = mode === 'plain' ? {} : (mode === 'hard' ? permissiveTls(true) : permissiveTls(false));
    const s = mode === 'plain'
      ? net.connect({ host, port }, connectedCb)
      : tls.connect({ host, port, ...opts }, connectedCb);
    this.sock = s;
    s.on('error', onErr);
    s.setTimeout(20000, () => { this.events.onError?.('timeout'); this.close(); onErr && onErr(new Error('timeout')); });
    s.on('data', (c) => {
      this.rawCapture(c);
      try {
        this.reader.push(c);
        this.pump();
      } catch (e) {
        this.events.onError?.(String(e && e.message || e));
        this.close();
      }
    });
    s.on('close', () => { this.events.onExit?.(); this.connected = false; });
    s.on('end', () => { this.connected = false; });
    return s;
  }

  sendCmd(cmd) { this.send(Buffer.from([cmd & 0xFF])); }
  send(buf) { if (this.sock && this.connected) { try { this.sock.write(buf); } catch {} } }

  sendClientHandshake() {
    if (this._hsSent) return;
    this._hsSent = true;
    const a = this._auth || {};
    let sig = SIG_STANDALONE;
    if (a.httpdata) sig = SIG_EMBEDDED;
    const pwdFull = a.httpdata || '';
    this.sendCmd(ID.ClientHandshake);
    this.send(this.wire(sig, a.username, a.password, pwdFull, a.key));
  }

  command(cmd, payload) {
    return Buffer.concat([Buffer.from([cmd & 0xFF]), payload || Buffer.alloc(0)]);
  }
  le16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v >>> 0); return b; }
  le32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; }

  // Reference startup (matches cryan209/irmc-live-viewer, docs/protocol.md).
  sendStartup() {
    if (this._startupSent) return;
    this._startupSent = true;
    this.sendClientHandshake();                              // 0xdd
    this.send(this.command(ID.InformBSEMode, this.le32(0))); // 0xf7 u32, BSE none
    this.send(this.command(ID.InformHLevelCompression, Buffer.from([1]))); // 0xf3
    this.send(this.command(ID.RequestPrimaryControl, Buffer.from([0])));   // 0xd3
    this.invalidateFull();
  }

  invalidateFull() {
    // 0xf2: numRegions(u16) + (left,top,right,bottom each u16). Use a large region.
    const payload = Buffer.concat([
      this.le16(1), this.le16(0), this.le16(0), this.le16(2048), this.le16(2048),
    ]);
    this.send(this.command(ID.Invalidate, payload));
  }

  // --- pump: parse all complete messages -------------------------------------
  pump() {
    while (this.reader.avail() >= 1) {
      const start = this.reader.pos;
      try {
        const cmd = this.reader.u8();
        this.onCommand(cmd);
      } catch (e) {
        if (e === NEEDMORE) this.reader.reset(start);
        else throw e;
        break;
      }
    }
  }

  onCommand(cmd) {
    const r = this.reader;
    switch (cmd) {
      case ID.ServerHandshake: {
        const raw = r.string(32).trim();
        this.parseHandshake(raw);
        this.events.onStatus?.('server-handshake');
        this.sendStartup();   // sends ClientHandshake(0xdd) + video options + invalidate
        break;
      }
      case ID.FirmwareVersion: {
        const len = r.u32();
        this.firmware = r.string(len);
        this.events.onStatus?.(`firmware:${this.firmware}`);
        break;
      }
      case ID.MultiUserState: {
        this.handshakeComplete = true;
        const flags = r.u32();
        const s0 = r.u8(), s1 = r.u8();
        const f0 = r.u8(), f1 = r.u8();
        const n0 = r.string(s0), n1 = r.string(s1);
        this.events.onStatus?.('multiuser');
        this.afterHandshake();
        break;
      }
      case ID.InformVesaMode: {
        const mode = r.u16(), width = r.u16(), height = r.u16(), bpp = r.u16();
        if (irmcDbg()) console.log(`[irmc][vesa] mode=${mode} ${width}x${height}@${bpp}`);
        if (this.fb.mode !== mode && this.fb.mode !== -1) irmcDbg() && console.log(`[irmc][vesa] mode transition ${this.fb.mode} -> ${mode}`);
        this.width = width; this.height = height; this.bpp = bpp;
        this.fb.setVesaMode(mode, bpp, width, height);
        this.events.onStatus?.(`vesa:${width}x${height}@${bpp}`);
        break;
      }
      case ID.BitBlt: {
        const blt = r.u16(); const fontH = r.u8(); const fontW = r.u8();
        const sx = r.u16(), sy = r.u16(), sw = r.u16(), sh = r.u16();
        const dx = r.u16(), dy = r.u16(), dw = r.u16(), dh = r.u16();
        const size = r.u32();
        const data = r.bytes(size);
        this.fb.bitBlt(dx, dy, dw, dh, blt, fontW, fontH, data);
        // Text mode blits a character buffer; emit the affected PIXEL region.
        if (this.fb.isText) this.emitFrame(dx * this.fb.fontW, dy * this.fb.fontH, dw * this.fb.fontW, dh * this.fb.fontH);
        else this.emitFrame(dx, dy, dw, dh);
        break;
      }
      case ID.EnhanceBitBlt: {
        const blt = r.u16(); const tw = r.u8(); const th = r.u8();
        const triplet = r.u32(); const repeat = r.u32();
        const raw = r.u32(); const scrunch = r.u32();
        const low = [], high = [];
        // Java EnhanceBitBlt.readBuffer(): snoop maps are INTERLEAVED per row —
        // low[i] then high[i] in one loop (not low[0..63] block then high block).
        for (let i = 0; i < 64; i++) { low.push(r.u32()); high.push(r.u32()); }
        const data = r.bytes(scrunch);
        const type = blt & 0x8000 ? blt & 0x7FFF : blt;
        if (type === 496) this.fb.enhanceBitBlt(tw, th, triplet, repeat, raw, scrunch, low, high, data);
        else if (type === 498) this.fb.enhanceBitBltHLC(tw, th, triplet, repeat, raw, scrunch, low, high, data);
        else if (type === 499) this.fb.enhanceBitBlt4bpp(tw, th, triplet, repeat, raw, scrunch, low, high, data);
        else if (type === 501) this.fb.enhanceBitBltForce8bppHLC(tw, th, triplet, repeat, raw, scrunch, low, high, data);
        this.emitDirtyAll();
        break;
      }
      case ID.BSEBitBlt: {
        const blt = r.i32(); const comp = r.u32(); const uncomp = r.u32();
        const top = r.u8(), left = r.u8(), bottom = r.u8(), right = r.u8();
        const seq = r.u32();
        const data = r.bytes(comp);
        this.fb.BSEBitBlt(blt, top, left, bottom, right, comp, uncomp, data);
        this.emitDirtyAll();
        break;
      }
      case ID.SSPBitBlt:
      case ID.LowBandwidthSSPBitBlt: {
        const comp = r.u32(); const uncomp = r.u32();
        const top = r.u8(), left = r.u8(), bottom = r.u8(), right = r.u8();
        const seq = r.u32();
        r.bytes(comp);
        // SSP decoder not yet implemented; consumes frame to keep sync.
        this.emitDirtyAll();
        break;
      }
      case ID.SetPalette: {
        const attrSize = r.u16();
        for (let i = 0; i < attrSize; i++) { r.u8(); r.u8(); }
        const palSize = r.u16();
        const pal = new Array(256).fill(0);
        for (let i = 0; i < palSize && i < 256; i++) {
          const off = r.u8(), hi = r.u8(), mid = r.u8(), lo = r.u8();
          if ((off & 0xFF) < 256) pal[off & 0xFF] = ((hi << 16) | (mid << 8) | lo) >>> 0;
        }
        this.fb.setPalette(pal, palSize);
        break;
      }
      case ID.StorageStatus: r.bytes(1056); break; // 0x89 fixed status block
      case ID.SequenceNumber: { // 0xef: 3 reserved bytes + u32. The applet replies
        // with the same SequenceNumber (Client->Urs ack) or video stalls.
        const reserved = r.bytes(3);
        const seq = r.u32();
        this.sendCmd(ID.SequenceNumber);
        const b = Buffer.alloc(7);
        reserved.copy(b, 0);
        b.writeUInt32LE(seq, 3);
        this.send(b);
        break;
      }
      case ID.InformCPUUtilization: r.bytes(24); break;
      case ID.InformKeyIndicators: r.bool(); r.bool(); r.bool(); break;
      case ID.SetTextCursor: r.bytes(4); break;
      case ID.SpecialGraphicsBit: r.bytes(4); break;
      case ID.StandbyPower: this.fb.standbyPower(); this.emitDirtyAll(); break;
      case ID.ServerDisconnect: { const reason = r.u32(); const ml = r.u16(); const msg = r.string(ml); this.events.onStatus?.(`server-disconnect:${msg}`); this.events.onError?.(`server-disconnect:${msg}`); break; }
      case ID.OemMsg: { const len = r.u32(); r.bytes(len); break; }
      case ID.NativeMessage: { const len = r.u32(); r.bytes((len + 3) & 0xFFFFFFFC); break; }
      case ID.OemCurrentLocalMonitorState: r.bytes(1); break;
      case ID.OemLocalMonitorState: break;
      case ID.GraphicsRegisterValue: r.bytes((5 + 8 + 2) * 4 - 4); r.bytes(4); break;
      case ID.MatroxGraphicsCursor: r.bytes(256 + 64 * 48); break;
      // Unknown / non-fatal: consume nothing (can't guess length) - log only.
      default: this.events.onStatus?.(`unknown-cmd:${cmd}`);
    }
  }

  parseHandshake(raw) {
    const sp = raw.indexOf(' ');
    let priv = '';
    if (sp !== -1) priv = raw.slice(sp + 1).trim().toLowerCase();
    this.privileges = {
      keyboard: priv.includes('k'),
      video: priv.includes('v'),
      mouse: priv.includes('m'),
      storage: priv.includes('s'),
    };
    this.compatible = priv.includes('lbw');
    this.events.onStatus?.(`handshake:${raw}`);
  }

  afterHandshake() {
    // Keep startup minimal (video first), matching the reference: after
    // MultiUserState we do NOT force extra modes. 0xf6/0xb1/0xb2 can disturb
    // the stream. Mouse mode IS synced here, mirroring the legacy applet
    // (MouseMgr.sendMouseState() on gaining full control, CConn:2231):
    // 177 absolute=true, 178 packed byte (bit0=relative, bit4=hide) = 0.
    // Without 177 the iRMC stays in its default RELATIVE mode and treats
    // MouseMove(181) coordinates as deltas -> the remote cursor jumps.
    if (this.privileges.mouse) {
      this.sendCmd(ID.ClientAbsoluteMode);
      this.send(Buffer.from([1]));
      this.sendCmd(ID.ClientRelativeMode);
      this.send(Buffer.from([0]));
    }
    this.events.onStatus?.('after-handshake');
  }

  emitFrame(x, y, w, h) { this.events.onFrame?.(this.fb, [{ x, y, w, h }]); }
  emitDirtyAll() {
    const d = this.fb.takeDirty();
    if (d.length) this.events.onFrame?.(this.fb, d);
  }

  // ---- input ----------------------------------------------------------------
  key(scanCode, down) { this.sendCmd(ID.KeyStateChange); const b = Buffer.alloc(4); b.writeUInt16LE(scanCode, 0); b[2] = down ? 1 : 0; b[3] = 0; this.send(b); }
  mouseMove(x, y) { this.sendCmd(ID.MouseMove); const b = Buffer.alloc(8); b.writeInt32LE(x, 0); b.writeInt32LE(y, 4); this.send(b); }
  buttonState(x, y, mask, wheel = 0) {
    // mask: bit0 left, bit1 right, bit2 middle (VNC buttonMask).
    // wheel: 0 none, -1 up, +1 down -> legacy trackwheel position byte:
    // ButtonState byte[2] = (64 + rotation) << 1 | pressedBit (0x80 centred).
    this.sendCmd(ID.ButtonStateAtAbsolute);
    const b = Buffer.alloc(4 + 4 + 1 + 3);
    b.writeInt32LE(x, 0); b.writeInt32LE(y, 4); b[8] = 3;
    for (let i = 0; i < 3; i++) {
      const pressed = (mask & (1 << i)) !== 0;
      b[9 + i] = (pressed ? 1 : 0) | (0x80); // trackwheel centred
    }
    if (wheel) b[11] = (((64 + wheel) & 0x7F) << 1) | (b[11] & 1);
    this.send(b);
  }
  power(action) { this.sendCmd(ID.OemPowerControlAction); this.send(Buffer.from([action & 0xFF])); }

  // === Storage / монтирование ISO (п.10) ===
  // StorageClientConnect (153) — сообщаем iRMC, что образ лежит на
  // инфра-сервере: адрес/порт нашего 5901-слушателя + sharePath/тип.
  // Формат payload из декомпиляции StorageClientConnect.writeBuffer().
  // Типы: DT_CD_ISO_IMAGE=11, DT_DVD_ISO_IMAGE=12;
  // read-only варианты = 0x80 | base (для CD 0x8B=139).
  static DT_CD_ISO_IMAGE = 11;
  static DT_CD_ISO_IMAGE_RO = 139;
  static DT_DVD_ISO_IMAGE = 12;
  static unitStr(s, pad = 512) {
    // Unicode (UTF-16BE) строка, дополненная нулями до pad байт
    const b = Buffer.alloc(pad);
    const enc = Buffer.from(String(s ?? ''), 'utf16le');
    // iRMC ждёт UTF-16BE -> переворачиваем пары байт
    for (let i = 0; i + 1 < enc.length; i += 2) { b[i] = enc[i + 1]; b[i + 1] = enc[i]; }
    return b;
  }
  storageClientConnect({ ip = Buffer.alloc(16), port = 5901, shareType = 139, sharePath = '', index = 0 }) {
    const ipb = Buffer.alloc(16);
    Buffer.isBuffer(ip) && ip.copy(ipb, 16 - ip.length);
    const p = Buffer.concat([
      ipb,
      Buffer.from([index === 0 ? 0 : 1, index === 1 ? 1 : (index === 0 ? 0 : 0x0f)]), // shareIndex0/1
      this.le16(port),
      Buffer.from([Buffer.byteLength(sharePath), 0]), // len0/len1
      Buffer.from([shareType & 0xFF, 0x0f]),          // shareType0/1 (0x0f = none)
      Buffer.from([1]),                                // ipType = IPv4
      Buffer.from([0]),                                // uid
      Buffer.from([1]),                                // sequence
      Buffer.alloc(5),                                 // reserved[5]
      this.unitStr(sharePath),                         // sharePath0 (512)
      this.unitStr(''),                                // sharePath1 (512)
    ]);
    this.send(this.command(ID.StorageClientConnect, p));
  }
  // StorageClientDisconnect (154) — отмонтирование
  storageClientDisconnect() {
    this.send(this.command(ID.StorageClientDisconnect, Buffer.from([0])));
  }


  close() {
    this.connected = false;
    // The iRMC console is single-session: it keeps holding primary control until
    // it sees a clean ClientDisconnect (0xd8, reason u32le). Without this, a
    // stale session blocks video for the NEXT connection (state=starting forever,
    // no InformVesaMode). Send 0xd8 + u32le(1) and flush before closing.
    if (this.sock && this.sock.writable) {
      try {
        this.sendCmd(ID.ClientDisconnect);
        this.send(Buffer.from([1, 0, 0, 0])); // reason = 1 (u32le)
      } catch {}
    }
    try { this.sock && this.sock.end(); } catch {}
    try { this.sock && this.sock.destroy(); } catch {}
    this.sock = null;
    this.events.onExit?.();
  }
}

// High level "test" used by the web UI: connect, do the handshake, report back
// what the server says. Resolves without needing a full video stream.
export function testIrmc(opts, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const collected = {
      host: opts.host, port: opts.port || 80, username: opts.username,
      signature: SIG_STANDALONE,
      firmware: '', privileges: {}, compatible: false,
      status: [], mode: null, error: null,
    };
    let settled = false;
    const finish = (err, ok) => {
      if (settled) return; settled = true;
      clearTimeout(timer);
      try { cli.close(); } catch {}
      if (ok) resolve({ ok: true, info: collected });
      else reject(Object.assign(new Error(err || collected.error || 'failed'), { info: collected }));
    };
    const cli = new IrmcClient(opts, {
      onStatus: (s) => {
        collected.status.push(s);
        if (s.startsWith('handshake:')) collected.handshake = s.slice(10);
        if (s.startsWith('firmware:')) collected.firmware = s.slice(9);
        if (s.startsWith('vesa:')) { collected.mode = s.slice(5); finish(null, true); }
        if (s === 'multiuser') { if (!collected.mode) collected.stage = 'multiuser'; }
        if (s === 'server-disconnect:') {}
      },
      onError: (e) => { collected.error = e; finish(e, false); },
      onFrame: () => { if (!collected.mode) collected.mode = 'video'; finish(null, true); },
      onExit: () => { if (!settled) finish(collected.error || 'connection closed', false); },
    });
    // expose raw captured bytes for diagnostics
    const _orig = cli.rawCapture.bind(cli);
    cli.rawCapture = (c) => { _orig(c); collected.raw = (cli._raw || []).join(' '); };
    const timer = setTimeout(() => finish('timeout', false), timeoutMs);
    cli.start().catch((e) => finish(e && e.message || String(e), false));
  });
}
