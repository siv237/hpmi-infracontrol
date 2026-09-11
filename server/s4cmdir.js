// Движок виртуального CD-ROM (VirtualMedia) для iRMC S4 (AMI/SOC) — ОТДЕЛЬНЫЙ.
// НЕ использует Avocent-URS/m2. S4 монтирует ISO через тот же HTTP-Connect
// туннель, что и KVM-видео, но с сервисом "CDMEDIA" и протоколом IUSB-SCSI.
//
// Схема (из декомпиляции JViewer.jar и его com/ami/iusb/*):
//   1. CONNECT <host>:<webSecurePort> HTTP/1.1\n cookie <webcookie>\r\n\r\n
//      JVIEWER CDMEDIA cookie <webcookie>\r\n\r\n   -> HTTP/1.1 200 OK
//   2. SendAuth_SessionToken: IUSBHeader(128) + sessionToken (offset 62),
//      байт 0xF2@41, deviceNo@23.
//   3. BMC отвечает кадром opcode=0xF1(241) connectionStatus: 1=ok,
//      5=уже у другой машины (m_otherIP), 8=занят.
//   4. Дальше пошаговый SCSI: TUR(0)/READ CAPACITY(37)/READ(10)=40/
//      READ(12)=168/READ TOC(67)/EJECT(27); данные = побайтная копия ISO.
//
// Формат кадра (LE буфер):
//   IUSBHeader (32 байта) + data(dataPacketLen)
//   IUSBHeader: "IUSB    "(8) major(1)=1 minor(1)=0 packetHeaderLen(1)=32
//     headerChecksum(1)@11  dataPacketLen(int)@12  serverCaps@16
//     deviceType@17=5  protocol@18=1  direction@19=128  deviceNumber@20
//     interfaceNumber@21=0  clientData@22  Instance@23  sequenceNumber(int)@24
//     reserved[4]@28
//   IUSBSCSI data: opcode@9  Lba@13  connectionStatus@30 (только для 0xF1)
//
// SCSI-кадр-ответ (packetWriteBuffer LE, capacity 131134):
//   status: overall@53 senseKey@54 senseCode@55 senseCodeQ@56
//   result length @57 (для READ CAPACITY =8, для READ(10)/READ(12)=bytes)
//   данные @61.. (READ CAP: totalSectors-1 BE + blockSize(2048) BE;
//                 READ: блоки; TOC: 20-байт append)
//   limit = dataLen + 61; header(32) + data(61+dataLen...)
//   см. CDImage.executeSCSICmd + CDROMRedir.run (n2 = getDataLength()+61)

import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import { open } from 'node:fs/promises';

const IUSB_HDR = 32;
const CD_BLOCK = 2048;

// ---- IUSBHeader -----------------------------------------------------------
// по com.ami.kvm.imageredir.IUSBHeader (headerLen=32, createCDROMHeader)
function iusbHeader(opts = {}) {
  const b = Buffer.alloc(IUSB_HDR);
  b.write('IUSB    ', 0, 'latin1');
  b[8] = opts.major ?? 1;
  b[9] = opts.minor ?? 0;
  b[10] = opts.packetHeaderLen ?? 32;
  b.writeUInt32LE((opts.dataLen ?? 0) >>> 0, 12);   // dataPacketLen int @12
  b[16] = opts.serverCaps ?? 0;
  b[17] = opts.deviceType ?? 5;          // 5 = CDROM
  b[18] = opts.protocol ?? 1;
  b[19] = opts.direction ?? 128;
  b[20] = opts.deviceNumber ?? 0;
  b[21] = opts.interfaceNumber ?? 0;
  b[23] = opts.instance ?? 0;            // CDDevice_no (header)
  b.writeUInt32LE((opts.sequence ?? 0) >>> 0, 24);
  return b;
}

// Баланс-чекист байта [11] = -сумма всех байт кадра (по limit) mod 256
// (IUSBHeader.write: sum по byteBuffer.limit(), затем put(11, -(byte)sum)).
function checksum(buf) {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s = (s + buf[i]) & 0xff;
  buf[11] = (-(s & 0xff)) & 0xff;
  return buf;
}

const OP_TUR = 0, OP_READ_CAPACITY = 37, OP_READ_10 = 40, OP_READ_TOC = 67,
  OP_READ_12 = 168, OP_EJECT = 27, OP_KILL = 246, OP_F1 = 0xf1;

export class S4Cmdir {
  constructor(cfg, events = {}) {
    // cfg: { host, username, kvmtoken, webcookie, kvmPort, webSecurePort }
    this.cfg = cfg;
    this.events = events;
    this.sock = null;
    this.running = false;
    this.ready = false;
    this.rx = Buffer.alloc(0);
    this.isoPath = cfg.isoPath || null;
    this.file = null;
    this.isoSize = 0;
    this.totalSectors = 0;
    this.instance = cfg.cdnum ?? 0; // CDDevice_no
    this.nBytes = 0;
    this.seenCmd = 0;
  }

  async openIso() {
    if (!this.isoPath) throw new Error('isoPath не задан');
    const st = await fs.promises.stat(this.isoPath);
    this.isoSize = st.size;
    this.totalSectors = Math.floor(this.isoSize / CD_BLOCK);
    this.file = await open(this.isoPath, 'r');
  }

  async start() {
    await this.openIso();
    await this._connectTunnel();
    this.ready = true;
    if (this.events.onStatus) this.events.onStatus('cdmedia:connected');
  }

  _connectTunnel() {
    const { host, kvmPort, kvmSecure, webcookie } = this.cfg;
    const port = Number(kvmPort || 80);
    return new Promise((resolve, reject) => {
      const onError = (e) => { this.events.onError?.(String(e.message || e)); reject(e); };
      const sock = kvmSecure
        ? tls.connect({ host, port, rejectUnauthorized: false, minVersion: 'TLSv1' }, () => this._tunnel(sock, resolve, reject))
        : net.connect({ host, port }, () => this._tunnel(sock, resolve, reject));
      sock.on('error', onError);
      sock.on('close', () => { if (this.running) this.events.onExit?.(); });
      this.sock = sock;
    });
  }

  _tunnel(sock, resolve, reject) {
    const { host, webcookie } = this.cfg;
    const target = Number(this.cfg.webSecurePort || 443);
    const req = `CONNECT ${host}:${target} HTTP/1.1\n cookie ${webcookie}\r\n\r\n`;
    sock.write(req);
    sock.write(`JVIEWER CDMEDIA cookie ${webcookie}\r\n\r\n`);
    let acc = Buffer.alloc(0);
    const onData = (c) => {
      acc = Buffer.concat([acc, c]);
      const s = acc.toString('latin1');
      const firstLine = s.split(/\r?\n/)[0] || '';
      if (/^HTTP\/1\.[01]\s+200/.test(firstLine)) {
        const idx = acc.indexOf('\n');
        const rest = idx >= 0 ? acc.slice(idx + 1) : Buffer.alloc(0);
        let skip = 0;
        while (rest[skip] === 13 || rest[skip] === 10) skip++;
        const bin = rest.subarray ? rest.subarray(skip) : rest.slice(skip);
        sock.removeListener('data', onData);
        if (bin.length) this._onData(bin);
        sock.on('data', (c2) => this._onData(c2));
        // после HTTP OK — auth-сессия и ожидание F1
        this._sendAuth();
        resolve();
      } else if (acc.length > 4096) {
        sock.removeListener('data', onData);
        reject(new Error('cdmedia: нет HTTP-ответа туннеля'));
      }
    };
    sock.on('data', onData);
  }

  // SendAuth_SessionToken (CDROMRedir): IUSBHeader(128) в буфере limit=160
  // (sessionTokenType==0). Токен = kvmToken (m_session_token = encToken),
  // НЕ webcookie. Раскладка (position в буфере, header 32б,	data-слой +32):
  //   pos 41 = 0xF2 (opcode auth-запроса, data[9])
  //   pos 62 = 0x00      (начало token, data[30])
  //   pos 62 = token
  //   pos 23 = deviceNo  (header.Instance = 23)
  //   dataPacketLen в header [12] = 128; общий размер = 160 байт.
  _sendAuth() {
    const token = String(this.cfg.kvmtoken || this.cfg.webcookie || '');
    const DATA = 128;                       // dataPacketLen (sessionTokenType==0)
    const buf = Buffer.alloc(IUSB_HDR + DATA);
    // header: dataPacketLen=128, Instance(=CDDevice_no) на offset 23, direction=128
    checksum(iusbHeader({ dataLen: DATA, instance: this.instance })).copy(buf);
    buf[41] = 0xf2;                          // opcode auth-запроса (data[9])
    buf[62] = 0;                             // маркер/старт sessionToken (data[30])
    buf.write(token, 63, 'latin1');          // токен с 63 (после байта-маркера)
    // пересчёт чекиста по всему кадру (как write() по limit)
    checksum(buf);
    this.sock.write(buf);
    if (this.events.onStatus) this.events.onStatus('cdmedia:auth-sent');
  }

  _onData(c) {
    this.rx = Buffer.concat([this.rx, c]);
    // реасемблинг кадров: IUSBHeader(32) + data(dataPacketLen на offset 12).
    // Кадры обрабатываются ПОСЛЕДОВАТЕЛЬНО через promise-очередь: _read() —
    // async (чтение ISO), без очереди ответы могли бы уйти не в том порядке.
    while (true) {
      if (this.rx.length < IUSB_HDR) return;
      const dataLen = this.rx.readUInt32LE(12);
      const total = IUSB_HDR + dataLen;
      if (this.rx.length < total) return;
      const frame = this.rx.subarray(0, total);
      this.rx = this.rx.subarray(total);
      this._chain = (this._chain || Promise.resolve())
        .then(() => this._handleFrame(frame))
        .catch((e) => this.events.onError?.(String(e.message || e)));
    }
  }

  async _handleFrame(frame) {
    const data = frame.subarray(IUSB_HDR);
    if (this.events.onRaw) this.events.onRaw(frame);
    // DATA-слой IUSBSCSI (protocol): opcode@9, Lba@13
    // (против internal-разбора IUSBSCSIPacket, где CDB: opCode@0 lun@1 lba@2)
    const opcode = data[9] & 0xff;
    const lba = data[13];

    if (opcode === OP_F1) {
      // connect-response: connectionStatus 1=ok
      if (data[30] === 1) {
        if (this.events.onStatus) this.events.onStatus('cdmedia:session-ok');
        this.startLoop = true;
        this._loopStart = Date.now();
        if (this.events.onSession) this.events.onSession({ ok: true, instance: this.instance });
      } else {
        const other = data.subarray(31, 55).toString('latin1').trim();
        this.events.onError?.(`cdmedia: отклонено (status ${data[30]})${other ? ', другой хост: ' + other : ''}`);
      }
      return;
    }

    // остальное — SCSI-команда от BMC
    await this._handleScsi(opcode, data, frame);
  }

  async _handleScsi(opcode, data, frame) {
    let response;
    this.seenCmd++;
    if (this.events.onCmd) this.events.onCmd(opcode, data.toString('hex'));
    // CDB лежит сразу после opcode-байта data[9] => cdb = data.subarray(9)
    const cdb = data.subarray(9);
    switch (opcode) {
      case OP_TUR: response = this._tur(); break;
      case OP_READ_CAPACITY: response = this._readCapacity(); break;
      case OP_READ_10: {
        // CDB10: op(1) lun(1) lba(4)@2, Cmd10.reserved6@6, length(u16)@7
        const lba = cdb.readUInt32BE(2);
        const len = cdb.readUInt16BE(7) & 0xffff;
        response = await this._read(lba, len);
        break;
      }
      case OP_READ_12: {
        const lba = cdb.readUInt32BE(2);
        const len = cdb.readUInt32BE(6) & 0xffffffff;
        response = await this._read(lba, len);
        break;
      }
      case OP_READ_TOC: response = this._readToc(); break;
      case OP_EJECT: response = { status: 0, data: Buffer.alloc(0) }; break;
      case OP_KILL:
        this.events.onExit?.();
        this.close();
        return;
      default:
        response = { status: 1, senseKey: 5, senseCode: 32, data: Buffer.alloc(0) };
    }
    this._sendResponse(response, frame);
  }

  _tur() {
    return { status: 0, data: Buffer.alloc(0) };
  }

  _readCapacity() {
    const out = Buffer.alloc(8);
    out.writeUInt32BE((this.totalSectors - 1) >>> 0, 0);
    out.writeUInt32BE(CD_BLOCK >>> 0, 4);
    return { status: 0, data: out, resultLen: 8 };
  }

  async _read(lba, len) {
    const n = Math.max(0, len & 0xffff);
    const startLba = lba >>> 0;
    const out = Buffer.alloc(CD_BLOCK * n);
    if (this.file) {
      await this.file.read(out, 0, out.length, startLba * CD_BLOCK);
      this.nBytes += CD_BLOCK * n;
    }
    return { status: 0, data: out, resultLen: out.length };
  }

  _readToc() {
    // аналог readTOC из CDImage: 20-байтный дескриптор TOC
    const out = Buffer.alloc(20);
    out[2] = 1; out[3] = 1;
    out[4] = 0; out[5] = 20; out[6] = 1; out[7] = 0;
    out[8] = 0; out[9] = 0; out[10] = 0; out[11] = 0;
    out[12] = 0; out[13] = 22; out[14] = 0xaa; out[15] = 0;
    out[16] = 0;
    out[17] = Math.floor((Math.floor((this.totalSectors + 150) / 75) / 60));
    out[18] = Math.floor((this.totalSectors + 150) / 75 % 60);
    out[19] = Math.floor((this.totalSectors + 150) % 75);
    const by = 20;
    out[0] = (by - 2 >> 8) & 0xff;
    out[1] = (by - 2) & 0xff;
    return { status: 0, data: out, resultLen: by };
  }

  // Ответ: status@53..56, результат-длина@57, данные@61, limit = dataLen+61
  // Ответ формируется как в CDImage.executeSCSICmd + CDROMRedir.run:
  //   буфер начинается с копии заголовка запроса (там sequence/instance/wrapper),
  //   затем status@53..56, результат-длина@57, данные@61; limit = dataLen+61;
  //   header.dataPacketLen = (dataLen+61) - 32; direction формит IUSBSCSI->128.
  _sendResponse(res, frame) {
    const dataLen = (res.data ? res.data.length : 0) + 61;   // общий payload с src
    const buf = Buffer.alloc(dataLen);
    // 1) копия заголовка запроса (0..31), чтобы сохранить sequence/instance/etc
    if (frame && frame.length >= IUSB_HDR) frame.copy(buf, 0, 0, IUSB_HDR);
    // 2) свой заголовок на месте направления/длины данных:
    //    direction=128 (форс IUSBSCSI.writePacket), dataPacketLen = из CDImage
    buf[19] = 0x80;                          // direction = 128
    // 3) status-блок @53..56 (SCSIStatusPacket)
    buf[53] = res.status || 0;
    buf[54] = res.senseKey ?? 0;
    buf[55] = res.senseCode ?? 0;
    buf[56] = res.senseCodeQ ?? 0;
    // 4) результат-длина @57 (для READ CAPACITY 8; для READ = bytes)
    buf.writeUInt32LE(res.resultLen ?? (res.data ? res.data.length : 0), 57);
    // 5) данные @61
    if (res.data && res.data.length) res.data.copy(buf, 61);
    // 6) dataPacketLen в заголовке = (dataLen+61) - 32 (как CDImage limit(dataLen+61))
    buf.writeUInt32LE((dataLen - IUSB_HDR) >>> 0, 12);
    // 7) чекист по всему кадру
    checksum(buf);
    if (this.events.onResp) this.events.onResp(buf.length, buf.toString('hex'));
    this.sock.write(buf);
  }

  close() {
    this.running = false;
    try { this.file?.close(); } catch {}
    try { this.sock?.destroy(); } catch {}
    this.sock = null;
  }
}

export function testCmdir(cfg, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const c = new S4Cmdir(cfg, {
      onStatus: (s) => console.log('[cdmedia]', s),
      onSession: (r) => { console.log('[cdmedia] session', JSON.stringify(r)); clearTimeout(t); c.close(); resolve(r); },
      onError: (e) => { console.log('[cdmedia] ERR', e); clearTimeout(t); c.close(); reject(new Error(e)); },
    });
    const t = setTimeout(() => { c.close(); reject(new Error('timeout')); }, timeoutMs);
    c.start().catch((e) => { console.log('[cdmedia] start ERR', e.message); clearTimeout(t); reject(e); });
  });
}
