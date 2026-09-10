// iRMC S4 консоль (AMI JViewer / IVTP-протокол) — по декомпиляту
// raw/JViewer_S4.jar + JViewer-SOC_S4.jar (см. wiki/bmc-jar-download.md).
// Протокол НЕ Mahogany (S2): это AMI-стек.
//
// Транспорт: HTTP CONNECT-туннель на WEB-порт (singleportenabled=1):
//   CONNECT <host>:<webPort> HTTP/1.1\n cookie <webcookie>\r\n\r\n
//   JVIEWER VIDEO cookie <webcookie>\r\n\r\n
//   -> «HTTP/1.0 200» + байты туннеля дальше по сокету.
//
// Рукопожатие (JViewerApp.OnKVMClientStart, строки ~1752-1817):
//   [21 GET_WEB_TOKEN]   hdr(21,len,0) + webcookie-байты
//   [18 VALIDATE_VIDEO_SESSION] (size 381):
//        byte tokenType(0=WEB) + kvmtoken padded to 130
//        + clientIP padded to 65 + clientUser padded to 129 + MAC...
//   [6  RESUME_REDIRECTION] hdr(6,0,0)
//   <- [19 VALIDATE_VIDEO_SESSION_RESPONSE] (статус 1 = ok)
//   <- [25 VIDEO_FRAGMENT]* кадры: hdr + fragNum(2 LE) + payload;
//      финал фрагмента: fragNum&0x8000; первый: fragNum&0x7FFF==0.
//      Кадр: 34-б заголовок SOCFrameHdr (LE) + пиксели.
//
// Кодеки (SOCJVVideo.decompressframe): 0/10 raw, 6/8 RLE, 4/7 QLZW.
// Пока поддержаны raw и RLE (16/24bpp — как у реальных iRMC S4;
// QLZW добавим по необходимости).
//
// Ввод: IUSB-HID пакеты [1]:
//   клавиатура: hdr(1,41,0) + «IUSB    » + 1,0,32,0, len=9, 0, dev 48(0x30),
//     proto 16(0x10), 0x80, 2,0,0,0, seq(4), 0,0,0,0, 8, [6 байт USB-отчёт],
//     checksum на offset 19 = -(сумма байт 8..39).
//   мышь ABS: hdr(1,39,0) + те же поля (dev 49(0x31), proto 32(0x20),
//     ifnum 1, len 6) + btn(1) x(2) y(2) wheel(1).
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';

const IVTP = {
  HID: 1, PAUSE: 4, RESUME: 6, STOP_IMMEDIATE: 8, GET_FULL_SCREEN: 11,
  VALIDATE_VIDEO_SESSION: 18, VALIDATE_VIDEO_SESSION_RESPONSE: 19,
  GET_KEYBD_LED: 20, GET_WEB_TOKEN: 21, VIDEO_FRAGMENT: 25,
  POWER_STATUS: 34, KVM_DISCONNECT: 54,
};

function ivtpHdr(type, size, status = 0) {
  const b = Buffer.alloc(8);
  b.writeInt16LE(type, 0);
  b.writeInt32LE(size, 2);
  b.writeInt16LE(status, 6);
  return b;
}

function ivtpParse(buf) {
  return { type: buf.readInt16LE(0), size: buf.readInt32LE(2), status: buf.readInt16LE(6) };
}

// DrleBuffer (CompressionRLE.drle_PIII, путь 24bpp): байтовый RLE.
// RCODE=0x55: [55 cnt val] -> повтор val (cnt+1) раз; cnt 0 -> литерал 55;
// cnt 1 -> литерал AA; TCODE=0xAA: [AA val] -> 3x val; прочее -> литерал.
function drleBytes(src, start, end, dst, dstStart = 0) {
  let s = start, d = dstStart;
  while (s < end) {
    const b = src[s++];
    if (b === 0x55) {
      const cnt = src[s++];
      if (cnt === 0) { dst[d++] = 0x55; continue; }
      if (cnt === 1) { dst[d++] = 0xaa; continue; }
      const v = src[s++];
      for (let i = 0; i < cnt + 1; i++) dst[d++] = v;
    } else if (b === 0xaa) {
      const v = src[s++];
      dst[d++] = v; dst[d++] = v; dst[d++] = v;
    } else dst[d++] = b;
  }
  return d;
}
// Пары u16/u32 (fwd_drle_16/24bpp) — для 16bpp-кадров
function drle16(src, start, end, dst) {
  // пары: u16 счётчик (0x8000 = повтор следующего u16), иначе литералы
  let s = start, d = 0;
  while (s + 2 <= end) {
    let cnt = src.readUInt16LE(s); s += 2;
    if (cnt & 0x8000) {
      const v = s + 2 <= end ? src.readUInt16LE(s) : 0; s += 2;
      cnt &= 0x7fff;
      for (let i = 0; i < cnt; i++) { dst.writeUInt16LE(v, d); d += 2; }
    } else {
      for (let i = 0; i < cnt && s + 2 <= end; i++) {
        dst.writeUInt16LE(src.readUInt16LE(s), d); s += 2; d += 2;
      }
    }
  }
  return d;
}
function drle24(src, start, end, dst) {
  // пары: u32 счётчик (0x8000_0000 = повтор следующего u32), иначе литералы
  let s = start, d = 0;
  while (s + 4 <= end) {
    let cnt = src.readUInt32LE(s); s += 4;
    if (cnt & 0x80000000) {
      const v = s + 4 <= end ? src.readUInt32LE(s) : 0; s += 4;
      cnt &= 0x7fffffff; // count (переполнение u32 маловероятно на кадре)
      for (let i = 0; i < cnt; i++) { dst.writeUInt32LE(v, d); d += 4; }
    } else {
      for (let i = 0; i < cnt && s + 4 <= end; i++) {
        dst.writeUInt32LE(src.readUInt32LE(s), d); s += 4; d += 4;
      }
    }
  }
  return d;
}

// ---- Фреймбуфер RGBA (совместим с vnc.js/noVNC-слоем) ---------------------
class IvtpFramebuffer {
  constructor() {
    this.width = 0; this.height = 0; this.pix = new Uint32Array(0);
  }
  resize(w, h) {
    if (w !== this.width || h !== this.height) {
      this.width = w; this.height = h; this.pix = new Uint32Array(w * h);
      return true;
    }
    return false;
  }
}

// ---- Клиент ---------------------------------------------------------------
export class IvtpClient {
  // cfg: { host, username, password, port, secure, kvmtoken, webcookie,
  //        kvmPort, kvmSecure } — токены одноразовые, выдаёт getSession()
  constructor(cfg, events) {
    this.cfg = cfg;
    this.events = events; // { onStatus, onFrame, onError, onExit }
    this.fb = new IvtpFramebuffer();
    this.sock = null;
    this.rx = Buffer.alloc(0);       // накопитель туннеля (после 200 OK)
    this.state = 'tunnel';           // tunnel -> hello -> live
    this._frameBuf = Buffer.alloc(0);
    this._fragRemain = 0;
    this._seq = 0;
    this._closed = false;
    this._iaTimer = null;
    this._mods = 0;
    this._keys = new Set();
    this._mx = 0; this._my = 0; this._mbtn = 0; this._mwheel = 0;
  }

  async start() {
    await this._connectTunnel();
    this._hello();
  }

  _connectTunnel() {
    const { host, kvmPort, kvmSecure } = this.cfg;
    const port = Number(kvmPort || 80);
    return new Promise((resolve, reject) => {
      const onError = (e) => { this.events.onError?.(String(e.message || e)); this.events.onExit?.(); reject(e); };
      const sock = kvmSecure
        ? tls.connect({ host, port, rejectUnauthorized: false, minVersion: 'TLSv1' }, () => this._tunnel(sock, resolve, reject))
        : net.connect({ host, port }, () => this._tunnel(sock, resolve, reject));
      sock.on('error', onError);
      sock.on('close', () => { if (!this._closed) { this.events.onExit?.(); } });
      this.sock = sock;
      sock._handlers = onError;
    });
  }

  _tunnel(sock, resolve, reject) {
    const { host, webcookie } = this.cfg;
    // Цель CONNECT — websecureport (у JViewer secWebPort из JNLP, у 042 = 443),
    // САМ сокет — на web-порт (80). Проверено на живом S4: цель :80 туннель
    // даёт, но поток молчит; цель :443 — полноценная сессия.
    const target = Number(this.cfg.webSecurePort || 443);
    const req = `CONNECT ${host}:${target} HTTP/1.1\n cookie ${webcookie}\r\n\r\n`;
    sock.write(req);
    sock.write(`JVIEWER VIDEO cookie ${webcookie}\r\n\r\n`);
    // ждём HTTP-ответ туннеля: BMC отвечает «HTTP/1.1 200 OK\r\n» и сразу
    // начинает бинарный поток (пакет 23 и т.д.) — двойного CRLF может не быть.
    let acc = Buffer.alloc(0);
    const onData = (c) => {
      acc = Buffer.concat([acc, c]);
      const s = acc.toString('latin1');
      const firstLine = s.split(/\r?\n/)[0] || '';
      if (/^HTTP\/1\.[01]\s+200/.test(firstLine)) {
        const idx = acc.indexOf('\n');
        const rest = idx >= 0 ? acc.slice(idx + 1) : Buffer.alloc(0);
        // отрезать возможный хвост CRLF перед бинарным потоком
        let skip = 0;
        while (rest[skip] === 13 || rest[skip] === 10) skip++;
        const bin = rest.subarray ? rest.subarray(skip) : rest.slice(skip);
        sock.removeListener('data', onData);
        if (bin.length) this._onData(bin);
        sock.on('data', (c2) => this._onData(c2));
        resolve();
      } else if (acc.length > 4096) {
        sock.removeListener('data', onData);
        reject(new Error('туннель: нет HTTP-ответа'));
      }
    };
    sock.on('data', onData);
  }

  // ---- рукопожатие ---------------------------------------------------------
  _hello() {
    const { webcookie, kvmtoken, username } = this.cfg;
    // [21] webcookie
    const wc = Buffer.from(String(webcookie || ''), 'latin1');
    this.sock.write(Buffer.concat([ivtpHdr(IVTP.GET_WEB_TOKEN, wc.length), wc]));
    // [18] validate: tokenType(1) + kvmtoken<=130 + ip<=65 + user<=129 + mac<=45; total 381
    const body = Buffer.alloc(381 - 8, 0);
    let p = 0;
    body[p++] = 0; // WEB_SESSION_TOKEN
    p += body.write(String(kvmtoken || ''), p, 129, 'latin1');
    p = 130;
    // own IP: с туннеля видно localhost — JViewer шлёт локальный адрес сокета
    p += body.write('127.0.0.1', p, 64, 'latin1');
    p = 130 + 65;
    p += body.write(String(username || ''), p, 128, 'latin1');
    // MAC — локальный; JViewer берёт первый интерфейс. Не критично: pad нулями.
    this.sock.write(Buffer.concat([ivtpHdr(IVTP.VALIDATE_VIDEO_SESSION, 381 - 8), body]));
    // [6] resume
    this.sock.write(ivtpHdr(IVTP.RESUME, 0));
    this.state = 'hello';
  }

  // ---- приём ----------------------------------------------------------------
  _onData(c) {
    this.rx = Buffer.concat([this.rx, c]);
    try { this._pump(); }
    catch (e) { this.events.onError?.(String(e.message || e)); }
  }

  _pump() {
    while (true) {
      if (this.rx.length < 8) return;
      const h = ivtpParse(this.rx.subarray(0, 8));
      if (h.size < 0 || h.size > 16 * 1024 * 1024) throw new Error('плохой IVTP-пакет type=' + h.type + ' size=' + h.size);
      if (this.rx.length < 8 + h.size) return;
      const body = this.rx.subarray(8, 8 + h.size);
      this.rx = this.rx.subarray(8 + h.size);
      this._onPkt(h, body);
    }
  }

  _onPkt(h, body) {
    switch (h.type) {
      case IVTP.VIDEO_FRAGMENT: this._onFragment(body); break;
      case IVTP.VALIDATE_VIDEO_SESSION_RESPONSE:
        if (h.status === 0 || h.status === 1) {
          this.state = 'live';
          this.events.onStatus?.('session:valid');
          // JViewer сразу просит полный экран — без запроса BMC держит тишину
          // (кадры пойдут только при изменениях; blank-экран вообще молчит).
          this.sock?.write(ivtpHdr(IVTP.GET_FULL_SCREEN, 0));
        } else {
          this.events.onError?.('S4: валидация сессии отклонена (status=' + h.status + ')');
          this.close();
        }
        break;
      case IVTP.BLANK_SCREEN:
        this._blank = true;
        break;
      case IVTP.STOP_IMMEDIATE:
      case IVTP.KVM_DISCONNECT:
        this.events.onStatus?.('отключено сервером (type=' + h.type + ')');
        this.close();
        break;
      default: break; // палитра/атрибуты/курсор/питание — пока игнорируем
    }
  }

  // [25]: body = fragNum(2 LE) + payload. Первый фрагмент: fragNum&0x7fff==0;
  // финальный: fragNum&0x8000. Пропущенное начало (без 0-фрагмента) —
  // дропаем до следующего полного кадра.
  _onFragment(body) {
    if (body.length < 2) return;
    const fragNum = body.readInt16LE(0);
    const payload = body.subarray(2);
    const isFirst = (fragNum & 0x7fff) === 0;
    const isLast = (fragNum & 0x8000) !== 0;
    if (isFirst) this._frameBuf = Buffer.alloc(0);
    else if (this._frameBuf.length === 0) return; // середина без начала — мусор
    this._frameBuf = Buffer.concat([this._frameBuf, payload]);
    if (isLast) this._onFrame(this._frameBuf);
  }

  _onFrame(raw) {
    if (raw.length < 34) return;
    const f = this._frameHdr(raw);
    // Мусорные/неполные кадры отбрасываем (как JViewer.onResolutionChange)
    if (f.resX < 300 || f.resX > 1920 || f.resY < 200 || f.resY > 1200) return;
    if (this.fb.resize(f.resX, f.resY)) {
      this.events.onStatus?.(`vesa:${f.resX}x${f.resY}@${f.bytesPP * 8}`);
    }
    let pixels;
    switch (f.compressionType) {
      case 0: case 10: pixels = raw.subarray(34); break;
      case 8: {
        // drle_PIII 24bpp: байтовый DrleBuffer (RCODE 0x55 / TCODE 0xAA)
        const need = f.resX * f.resY * (f.bytesPP === 4 ? 4 : f.bytesPP);
        const dst = Buffer.alloc(Math.max(need, raw.length));
        const n = drleBytes(raw, 34, 34 + f.frameSize, dst);
        pixels = dst.subarray(0, n);
        break;
      }
      case 6: {
        const bpp = f.bytesPP;
        const dst = Buffer.alloc(Math.max(f.resX * f.resY * (bpp === 4 ? 4 : 2) + 34, raw.length * 4));
        const n = bpp === 4
          ? drle24(raw, 34, 34 + f.frameSize, dst)
          : drle16(raw, 34, 34 + f.frameSize, dst);
        pixels = dst.subarray(0, Math.min(n, dst.length));
        break;
      }
      default: pixels = raw.subarray(34); break; // QLZW и пр. — сырьё, пока без
    }
    this._blit(f, pixels);
    this.events.onFrame?.(this.fb, null);
  }

  _frameHdr(raw) {
    // SOCFrameHdr (34 б LE): flags(4) compression(1) frameSize(4) resX(2)
    // resY(2) width(2) height(2) syncLoss(1) modeChange(1) tileCol(1)
    // tileRow(1) textOffset(1) bytesPP(1)[22] videoFlags(1) charH(1)
    // left(1) right(1) top(1) bottom(1) textFlags(1) act_bpp(1) ...
    return {
      flags: raw.readInt32LE(0),
      compressionType: raw[4],
      frameSize: raw.readInt32LE(5),
      resX: raw.readInt16LE(9),
      resY: raw.readInt16LE(11),
      width: raw.readInt16LE(13),
      height: raw.readInt16LE(15),
      bytesPP: raw[22],
    };
  }

  _blit(f, pixels) {
    const { resX, resY, bytesPP } = f;
    const w = Math.min(resX, this.fb.width), h = Math.min(resY, this.fb.height);
    if (w <= 0 || h <= 0) return;
    const px = this.fb.pix;
    if (bytesPP === 4 || bytesPP === 3) {
      const off = bytesPP === 3 ? 1 : 0; // 4bpp: BGRA -> LE-порядок; 3bpp: RGB
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * resX + x);
          const j = i * (bytesPP === 3 ? 3 : 4) + off;
          const b = pixels[j] | 0, g = pixels[j + 1] | 0, r = pixels[j + 2] | 0;
          px[y * w + x] = 0xff000000 | (b << 16) | (g << 8) | r;
        }
      }
    } else if (bytesPP === 2) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const v = pixels.readUInt16LE((y * resX + x) * 2);
          const r = (v & 0xf800) >>> 8, g = (v & 0x07e0) >>> 3, b = (v & 0x1f) << 3;
          px[y * w + x] = 0xff000000 | (b << 16) | (g << 8) | r;
        }
      }
    } else if (bytesPP === 1) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const v = pixels[y * resX + x] | 0;
          px[y * w + x] = 0xff000000 | (v << 16) | (v << 8) | v;
        }
      }
    }
  }

  // ---- ввод (IUSB-HID) ------------------------------------------------------
  // Клавиатура: держим набор нажатых HID-кодов; каждый keyEvent пересобирает
  // стандартный USB-отчёт [mods,0,k1..k6] и шлёт [1,41].
  // Модификаторы по HID: LCtrl 0xE0 LShift 0xE1 LAlt 0xE2 LGui 0xE3,
  // RCtrl 0xE4 RShift 0xE5 RAlt 0xE6 RGui 0xE7.
  keyEvent(hid, down) {
    if (hid >= 0xe0 && hid <= 0xe7) {
      if (down) this._mods |= (1 << (hid - 0xe0));
      else this._mods &= ~(1 << (hid - 0xe0));
    } else {
      if (down) this._keys.add(hid);
      else this._keys.delete(hid);
    }
    const rep = Buffer.alloc(8);
    rep[0] = this._mods & 0xff;
    let i = 2;
    for (const k of this._keys) { if (i > 7) break; rep[i++] = k; }
    this.sendKeyReport(rep);
  }
  // Мышь: абсолютная позиция (0..screenW/H), кнопки bit0 L / bit1 R / bit2 M,
  // wheel: -1/+1. Кэш — отсылаем только при изменении (как JViewer).
  mouseAbs(x, y) { this._mx = x; this._my = y; this._mouseFlush(); }
  mouseButtons(x, y, mask, wheel = 0) {
    this._mx = x; this._my = y;
    const w = wheel < 0 ? 0xff : wheel > 0 ? 1 : 0;
    if (mask === this._mbtn && w === 0) { this._mouseFlush(); return; }
    this._mbtn = mask; this._mwheel = w;
    this._mouseFlush();
  }
  _mouseFlush() {
    const f = this.fb;
    const w = f.width || 1024, h = f.height || 768;
    this.sendMouseAbs(this._mbtn & 7, this._mx || 0, this._my || 0, this._mwheel, w, h);
    if (this._mwheel) { this._mwheel = 0; } // колесо — импульс
  }
  // HID-пакет по декомпиляту USBKeyboardRep/USBMouseRep: 49 байт (клава) или
  // 47 (мышь ABS). pktSize в IVTP-заголовке = длина пакета - 8 (41/39).
  // dataLen: клава 9, мышь 7 (см. Java putInt(n)); checksum: [19] = -(сумма
  // байт [8..39] полного буфера).
  _sendHid(devType, proto, ifNum, javaDataLen, tailLen, report) {
    const pkt = Buffer.alloc(8 + 34 + 7, 0); // 49 как в Java (с запасом)
    ivtpHdr(IVTP.HID, pkt.length - 8, 0).copy(pkt, 0);
    pkt.write('IUSB    ', 8, 8, 'latin1');
    pkt[16] = 1; pkt[17] = 0; pkt[18] = 32; // major/minor/hdrSize
    // [19] — checksum (ниже)
    pkt.writeInt32LE(javaDataLen, 20);
    pkt[24] = 0;
    pkt[25] = devType; pkt[26] = proto; pkt[27] = 0x80; pkt[28] = 2; pkt[29] = ifNum;
    pkt.writeInt32LE(this._seq++, 30);
    // [34..37] = 0; [38] = tailLen (клава 8, мышь 6)
    pkt[38] = tailLen;
    report.copy(pkt, 39);
    let sum = 0;
    for (let i = 8; i <= 39; i++) sum = (sum + pkt[i]) & 0xff;
    pkt[19] = (-sum) & 0xff;
    const out = pkt.subarray(0, 39 + report.length);
    this.sock.write(out);
    return out;
  }
  sendKeyReport(usbReport8) {
    // usbReport8: [0]=mods, [1]=0, [2..7]=ключи (стандартный USB HID-отчёт)
    if (!usbReport8 || usbReport8.length !== 8) return;
    this._sendHid(0x30, 0x10, 0, 9, 8, usbReport8);
  }
  sendMouseAbs(btn, x, y, wheel, screenW, screenH) {
    const sx = Math.max(-32768, Math.min(32767, Math.round(x * 32767 / (screenW || 1024))));
    const sy = Math.max(-32768, Math.min(32767, Math.round(y * 32767 / (screenH || 768))));
    const rep = Buffer.alloc(6);
    rep[0] = btn & 7;
    rep.writeInt16LE(sx, 1);
    rep.writeInt16LE(sy, 3);
    rep[5] = wheel & 0xff;
    this._sendHid(0x31, 0x20, 1, 7, 6, rep);
  }

  // ---- управление -----------------------------------------------------------
  invalidateFull() {
    if (this.state === 'live') this.sock?.write(ivtpHdr(IVTP.GET_FULL_SCREEN, 0));
  }
  close() {
    this._closed = true;
    try { this.sock?.write(ivtpHdr(IVTP.STOP_IMMEDIATE, 0)); } catch {}
    try { this.sock?.destroy(); } catch {}
    this.events.onExit?.();
  }
}

// Экспресс-проверка S4-консоли (как testIrmc): подключение + первая валидация.
export function testIvtp(cfg, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (err, ok) => { if (!done) { done = true; clearTimeout(t); try { cli.close(); } catch {} resolve({ err, ok }); } };
    const t = setTimeout(() => fin('timeout', false), timeoutMs);
    const cli = new IvtpClient(cfg, {
      onStatus: (s) => { if (s === 'session:valid') fin(null, true); },
      onError: (e) => fin(String(e), false),
      onExit: () => fin('exit', false),
      onFrame: () => { if (!done) fin(null, true); },
    });
    cli.start().catch((e) => fin(String(e.message || e), false));
  });
}
