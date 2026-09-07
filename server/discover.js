// Discovery of the iRMC AVR connection parameters by logging into the web
// interface (HTTP Digest auth, MD5 qop=auth) and finding the applet/JNLP
// parameters that tell the Java viewer which KVM port and which tokens to use.

import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { URL } from 'node:url';
import { permissiveTlsOptions } from './irmc.js';

const AVR_PARAM_KEYS = [
  'NonSecure_KVMPort', 'NonSecure_KMPort', 'NonSecure_VPort',
  'SSL_VMPort', 'SSL_KPort', 'VncPort', 'StoragePort', 'HttpPort', 'HttpsPort',
  'sessiontype', 'SessionType', 'type',
];

function md5(s) { return crypto.createHash('md5').update(s).digest('hex'); }
function randomHex(n) { return crypto.randomBytes(n).toString('hex').slice(0, n); }

// One HTTP(S) GET. Returns { status, headers, body, auth }.
// Тело декодируется по charset из Content-Type (дефолт UTF-8 — iRMC S2
// отдаёт страницы в UTF-8; latin1 ломал кириллицу в инвентаре).
function get(secure, host, port, path, headers = {}) {
  const mod = secure ? https : http;
  const u = new URL(`${secure ? 'https' : 'http'}://${host}:${port}${path}`);
  return new Promise((resolve, reject) => {
    const req = mod.get(u, secure ? { ...permissiveTlsOptions(), headers } : { headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => { if (Buffer.isBuffer(c)) chunks.push(c); else chunks.push(Buffer.from(c)); });
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const m = /charset=([\w-]+)/i.exec(res.headers['content-type'] || '');
        let enc = (m && m[1] ? m[1] : 'utf8').toLowerCase();
        if (enc === 'utf-8') enc = 'utf8';
        let body;
        try { body = buf.toString(enc); } catch { body = buf.toString('utf8'); }
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    });
    req.on('error', reject);
    req.setTimeout(6000, () => { req.destroy(new Error('timeout')); });
  });
}

// Two-step HTTP Digest (MD5, qop=auth). Returns the page body on 200.
export async function digestGet(secure, host, port, path, user, pass) {
  // The old iRMC web server is fragile and sometimes responds 5xx when busy.
  let first;
  for (let i = 0; i < 2; i++) {
    first = await get(secure, host, port, path, { 'User-Agent': 'Mozilla/5.0' });
    if (first.status >= 500) { await new Promise((r) => setTimeout(r, 600 + i * 700)); continue; }
    break;
  }
  const auth = first.headers && first.headers['www-authenticate'];
  if (first.status !== 401 || !auth || !/digest/i.test(auth)) {
    if (first.status === 200) return first;
    if (first.status >= 500 && first.status < 600) {
      throw new Error(`веб-сервер iRMC временно недоступен (${first.status}); подождите или перезапустите iRMC`);
    }
    throw new Error(`auth required (${first.status}) ${auth || ''}`);
  }
  const p = {};
  const re = /(\w+)\s*=\s*(?:"([^"]*)"|([^\s,]+))/g;
  let m;
  while ((m = re.exec(auth))) p[m[1]] = m[2] !== undefined ? m[2] : m[3];
  if (!p.realm || !p.nonce) throw new Error('unsupported digest challenge: ' + auth);

  const uri = path;
  const nc = '00000001';
  const qop = p.qop && p.qop.includes('auth') ? 'auth' : null;
  const ha2 = md5(`GET:${uri}`);
  let last = first;
  // Try standard MD5 first, then MD5-sess (some iRMC build nonce-sess hashes).
  for (const sess of [false, true]) {
    const cnonce = randomHex(8);
    let ha1 = md5(`${user}:${p.realm}:${pass}`);
    if (sess) ha1 = md5(`${ha1}:${p.nonce}:${cnonce}`);
    const response = md5(`${ha1}:${p.nonce}:${nc}:${cnonce}:${qop}:${ha2}`);

    let hd = `Digest username="${user}", realm="${p.realm}", nonce="${p.nonce}", `+
             `uri="${uri}", response="${response}"`;
    if (qop) hd += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
    if (p.opaque) hd += `, opaque="${p.opaque}"`;
    if (sess) hd += ', algorithm=MD5-sess';

    try {
      last = await get(secure, host, port, path, { Authorization: hd, 'User-Agent': 'Mozilla/5.0' });
      if (last.status === 200) return last;
    } catch { break; }
  }
  return last;
}

function avrFromHtml(html) {
  const out = {};
  const paramRe = /<\s*param\s+name\s*=\s*["']([^"']+)["']\s+value\s*=\s*["']([^"']*)["']\s*\/?\s*>/gi;
  let m;
  while ((m = paramRe.exec(html))) out[m[1]] = m[2];
  const attrRe = /name=["']([^"']?Port|httpdata|digest|sessiontype|SessionType|kvmurl|kvmpath)["']\s*value=["']([^"']*)["']/gi;
  while ((m = attrRe.exec(html))) out[m[1]] = m[2];
  return out;
}

export async function discover(cfg) {
  const { host, username, password, port = 443, secure = true } = cfg;
  const root = await digestGet(secure, host, port, '/', username, password);
  const paths = ['/kvm.htm', '/KVM.htm', '/services', '/cgi/login.cgi', '/start.htm', '/index.html', '/irmc/'];
  const bodies = [root];
  const probeStatuses = [root.status];
  for (const p of paths) {
    try {
      const r = await digestGet(secure, host, port, p, username, password);
      probeStatuses.push(r.status);
      if (r.status === 200) bodies.push(r);
    } catch { probeStatuses.push(0); }
  }
  const params = {};
  for (const b of bodies) {
    const pp = avrFromHtml(b.body);
    for (const k of Object.keys(pp)) if (!(k in params)) params[k] = pp[k];
  }
  const pick = (keys) => { for (const k of keys) { const v = params[k]; if (v && /^\d+$/.test(v)) return Number(v); } return null; };
  const kvmPort = pick(['NonSecure_KVMPort', 'NonSecure_VPort', 'SSL_VMPort', 'SSL_KPort', 'VncPort']);

  return {
    host, username, rootStatus: root.status,
    kvmPort,
    probeStatuses,
    params: maskParams(params),
    portUsed: port,
  };
}

// Log in (digest) and fetch a fresh per-session JNLP to obtain the current
// httpdata + AVR port. httpdata is session material and expires, so it must be
// fetched fresh before every AVR connection.
export async function getSession(cfg) {
  const { host, username, password, port = 80, secure = false } = cfg;
  const root = await digestGet(secure, host, port, '/', username, password);
  if (root.status !== 200) throw new Error(`login failed (${root.status})`);
  const link = /href="(avr\.jnlp\?[^"]+)"/i.exec(root.body);
  if (!link) throw new Error('no avr.jnlp link in page');
  const j = await digestGet(secure, host, port, '/' + link[1].replace(/&amp;/g, '&'), username, password);
  const args = {};
  const re = /argument>([^<]*)</g;
  let m;
  while ((m = re.exec(j.body))) {
    const a = m[1].trim();
    const i = a.indexOf('=');
    if (i > 0) args[a.slice(0, i).replace(/^-/, '')] = a.slice(i + 1);
  }
  return {
    host, username,
    port: Number(args.VncPort || port),
    secure: false, // sessiontype=kvm -> plain
    httpdata: args.httpdata || '',
    digest: args.digest || '',
  };
}

// Parse the authenticated System Information page into label -> value.
export function parseInventory(html) {
  const out = {};
  const trRe = /<tr[^>]*>(.*?)<\/tr>/gis;
  const thRe = /<th[^>]*>([^:]+):\s*<\/th>/i;
  let m;
  while ((m = trRe.exec(html))) {
    const row = m[1];
    const th = thRe.exec(row);
    if (!th) continue;
    const label = th[1].trim();
    // value either <td>text</td> or <td><input ... value="...">
    let val = '';
    const td = row.replace(/<\/td>.*$/s, '');
    const inp = /value\s*=\s*"([^"]*)"/i.exec(row);
    const plain = /<td[^>]*>([\s\S]*?)<\/td>/i.exec(row);
    const afterTh = row.replace(/.*?<\/th>/is, '').replace(/\s+/g, ' ');
    if (inp) val = inp[1].trim();
    else val = afterTh.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (val) out[label] = val;
  }
  return out;
}

export async function inventory(cfg) {
  const { host, username, password, port = 80, secure = false } = cfg;
  const r = await digestGet(secure, host, port, '/', username, password);
  if (r.status !== 200) throw new Error(`login failed (${r.status})`);
  const inv = parseInventory(r.body || '');
  return { host, port, secure, ok: true, inventory: inv };
}

function maskParams(params) {
  const out = {};
  for (const k of Object.keys(params)) {
    const v = params[k];
    if (/httpdata|digest|passwd|key/i.test(k)) out[k] = v ? `<${v.length} chars hidden>` : '';
    else out[k] = v;
  }
  return out;
}
