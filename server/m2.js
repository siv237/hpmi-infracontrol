// Движок монтирования ISO: нативная библиотека M2 из легаси-вьювера
// (avr_irmc_s2.jar, GPL). Грузится так же, как в легаси (NativeInterface2):
// StorageServer.Port -> dlopen -> StorageServer.ActualPort, дальше общаемся
// по локальному протоколу Java<->M2 (см. wiki/knowledge/irmc-storage.md).
// M2 сама соединяется с iRMC (URS-канал) и отдаёт образ как SCSI CD.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const M2_DIR = path.join(ROOT, 'data', 'm2');
const SO_FILE = path.join(M2_DIR, 'LIBM2-64.SO');
const WANT_PORT = '5901';
const DT_CD_ISO_IMAGE = 11;

let child = null;
let m2Port = null;
let starting = null;
let activeSock = null; // сокет share-сессии (живёт, пока смонтировано)
// Учёт переданных байт: процесс M2 читает ISO (pread/read) в том же процессе, что
// dlopen'ит .so. Семплируем /proc/<pid>/io rchar — реальный объём, отданный iRMC.
let meter = { startedMs: 0, bytes: 0, bps: 0 };
let statTimer = null;
let prevRchar = new Map(); // pid -> последний rchar

function extractFromJar() {
  return new Promise((resolve, reject) => {
    const p = spawn('unzip', ['-o', '-j', path.join(ROOT, 'raw', 'avr_irmc_s2.jar'), 'LIBM2-64.SO', '-d', M2_DIR]);
    p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error('unzip exit ' + c))));
    p.on('error', reject);
  });
}

// Поднять M2 (однократно); резолвится фактическим портом локального сервера.
export function ensureM2() {
  if (m2Port) return Promise.resolve(m2Port);
  if (starting) return starting;
  starting = (async () => {
    if (!fs.existsSync(SO_FILE)) await extractFromJar();
    const env = { ...process.env, LD_LIBRARY_PATH: path.join(M2_DIR, 'lib') };
    child = spawn('python3', [path.join(__dirname, 'm2host.py'), M2_DIR, WANT_PORT], {
      cwd: M2_DIR, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const port = await new Promise((resolve, reject) => {
      let out = '';
      child.stdout.on('data', (d) => {
        out += d;
        const m = out.match(/M2_PORT=(\d+)/);
        if (m) resolve(Number(m[1]));
      });
      child.stderr.on('data', (d) => process.stderr.write('[m2] ' + d));
      child.on('exit', (c) => { m2Port = null; starting = null; reject(new Error('m2 host exited ' + c)); });
      setTimeout(() => reject(new Error('m2 port timeout')), 20000);
    });
    // ждём, пока локальный сервер начнёт принимать TCP
    await new Promise((resolve, reject) => {
      const tryConn = (n) => {
        const s = net.connect(port, '127.0.0.1');
        s.once('connect', () => { s.destroy(); resolve(); });
        s.once('error', () => {
          s.destroy();
          if (n <= 0) return reject(new Error('m2 tcp timeout'));
          setTimeout(() => tryConn(n - 1), 300);
        });
      };
      tryConn(30);
    });
    m2Port = port;
    return port;
  })().catch((e) => { starting = null; throw e; });
  return starting;
}

// URSStorage payload (1044 Б): len0/len1, shareType0/1, пути UTF-16LE по 510 Б,
// ip[16] (IPv4 в конце), порт, sequence, ipType (0 = IPv4).
function ursPayload({ ip, port, sharePath, shareType }) {
  const b = Buffer.alloc(1044);
  let o = 0;
  const p = Buffer.from(sharePath, 'utf16le');
  b.writeUInt8((p.length >> 1) & 0xff, o++); // len0: число UTF-16 символов (cchPath0), не байт
  b.writeUInt8(0, o++);
  b.writeUInt8(shareType & 0xff, o++);
  b.writeUInt8(0xff, o++); // shareType1 = UNDEFINED
  p.copy(b, o); o += 510;
  o += 510;
  const v4 = Buffer.from(ip.split('.').map(Number));
  v4.copy(b, o); // URSStorage.setIPAddress копирует IPv4 по offset 0 (в отличие от 153!)
  o += 16;
  b.writeUInt16LE(port & 0xffff, o); o += 2;
  b.writeUInt8(1, o++); // sequence = 1
  b.writeUInt8(0, o++); // ipType = IPv4
  return b;
}

function readN(sock, n, ms = 8000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let got = 0;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('m2 read timeout'));
    }, ms);
    const onErr = (e) => { cleanup(); reject(e); };
    const onEnd = () => { cleanup(); reject(new Error('m2 socket closed')); };
    const onData = (d) => {
      chunks.push(d);
      got += d.length;
      if (got >= n) {
        cleanup();
        resolve(Buffer.concat(chunks).subarray(0, n));
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      sock.removeListener('data', onData);
      sock.removeListener('error', onErr);
      sock.removeListener('end', onEnd);
    };
    sock.on('data', onData);
    sock.on('error', onErr);
    sock.on('end', onEnd);
  });
}

// Смонтировать ISO: share-запрос в M2 (заголовок 544 Б + URSStorage 1044 Б).
// host — адрес iRMC, port — HTTP-порт iRMC (как в легаси: m_storagePort = m_HttpPort).
export async function share({ host, port = 80, sharePath, shareType = DT_CD_ISO_IMAGE }) {
  await ensureM2();
  let ip = host;
  if (!net.isIPv4(ip)) {
    const r = await import('node:dns').then((d) => d.promises.lookup(host, { family: 4 }));
    ip = r.address;
  }
  if (activeSock) { try { activeSock.destroy(); } catch { } activeSock = null; }
  const sock = net.connect(m2Port, '127.0.0.1');
  await new Promise((resolve, reject) => {
    sock.setTimeout(8000, () => { sock.destroy(); reject(new Error('m2 connect timeout')); });
    sock.once('connect', resolve);
    sock.once('error', reject);
  });
  // начинаем учёт переданных байт (реальный путь M2 читает ISO -> iRMC)
  startStats();
  // В легаси share идёт по сокету, где уже был discovery (MountDialog).
  const disc = Buffer.alloc(544);
  disc.writeUInt16LE(5901, 0); // portNumber = StoragePort
  disc.writeUInt8(0xfe, 5);    // CONNECTION_TYPE = -2
  sock.write(disc);
  const h = await readN(sock, 19); // 19-байтовый заголовок, длина — hex по смещению 9
  const plen = parseInt(h.subarray(9, 17).toString('ascii').trim(), 16) || 0;
  if (plen > 0) await readN(sock, plen);
  // Заголовок StorageShareRequest (connectionType 0xFA) + URSStorage payload.
  // Нативная проверка: именно с этим заголовком M2 дозванивается до iRMC.
  const head = Buffer.alloc(544);
  head.writeUInt8(0xfa, 5);
  sock.write(head);
  sock.write(ursPayload({ ip, port, sharePath, shareType }));
  // Ответ M2 к share может не приходить сразу (успех = тишина, M2 ведёт
  // URS к iRMC сама). Ждём короткое окно на возможный error, сокет держим.
  let resp = null;
  try { resp = await readN(sock, 1, 1500); } catch { /* молчим — считаем выпущено */ }
  activeSock = sock;
  return { ok: true, issued: true, code: resp ? resp[0] : null };
}

// Отмонтировать: рвём share-сокет (M2 завершает URS-сессию).
export function unshare() {
  stopStats();
  if (activeSock) { try { activeSock.destroy(); } catch { } activeSock = null; }
}

function ioRchar(pid) {
  if (!pid) return NaN;
  try {
    const s = fs.readFileSync(`/proc/${pid}/io`, 'utf8');
    const m = s.match(/^rchar:\s+(\d+)/m);
    return m ? Number(m[1]) : NaN;
  } catch { return NaN; }
}

function startStats() {
  stopStats();
  const pid = child && child.pid;
  if (!pid) return;
  meter.startedMs = Date.now();
  meter.bytes = 0; meter.bps = 0;
  prevRchar.set(pid, ioRchar(pid));
  statTimer = setInterval(() => {
    const cur = ioRchar(pid);
    const last = prevRchar.get(pid);
    if (!Number.isNaN(cur) && !Number.isNaN(last) && cur >= last) {
      const delta = cur - last;
      meter.bytes += delta;
      meter.bps = delta;                       // байт/сек за текущий такт
    }
    prevRchar.set(pid, cur);
  }, 1000);
  statTimer.unref?.();
}

function stopStats() {
  if (statTimer) { clearInterval(statTimer); statTimer = null; }
  meter.bps = 0;
}

export function status() {
  return { running: !!m2Port, port: m2Port };
}

export function stats() {
  return {
    active: !!activeSock,
    startedMs: meter.startedMs || 0,
    bytes: meter.bytes || 0,
    bps: meter.bps || 0,
  };
}
