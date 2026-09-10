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

// Простой POST формы (application/x-www-form-urlencoded). Для S4-триггера
// логина: форма APPLY=99 → в ответ 401 Digest (realm в заголовке).
function postForm(secure, host, port, path, formBody, extraHeaders = {}) {
  const mod = secure ? https : http;
  const u = new URL(`${secure ? 'https' : 'http'}://${host}:${port}${path}`);
  return new Promise((resolve, reject) => {
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(formBody),
      'User-Agent': 'Mozilla/5.0',
      ...extraHeaders,
    };
    const opts = secure ? { ...permissiveTlsOptions(), method: 'POST', headers } : { method: 'POST', headers };
    const req = mod.request(u, opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(6000, () => req.destroy(new Error('timeout')));
    req.end(formBody);
  });
}

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
// S4: GET «/» не даёт 401 — Digest-челлендж спрятан за формой-триггером
// (POST /login APPLY=99). Если GET не челленджит и страница похожа на
// S4-login — дёргаем триггер и повторяем с полученным nonce.
export async function digestGet(secure, host, port, path, user, pass) {
  // The old iRMC web server is fragile and sometimes responds 5xx when busy.
  let first;
  for (let i = 0; i < 2; i++) {
    first = await get(secure, host, port, path, { 'User-Agent': 'Mozilla/5.0' });
    if (first.status >= 500) { await new Promise((r) => setTimeout(r, 600 + i * 700)); continue; }
    break;
  }
  // S4: «/» 302-редиректит на /login — следуем (до 2 прыжков).
  let hops = 0;
  while (first.status >= 300 && first.status < 400 && hops < 2) {
    const loc = String(first.headers?.location || '');
    if (!loc) break;
    let p2 = loc, host2 = host, port2 = port, sec2 = secure;
    if (/^https?:\/\//i.test(loc)) {
      const u = new URL(loc);
      p2 = u.pathname + (u.search || ''); host2 = u.hostname; sec2 = u.protocol === 'https:';
      port2 = Number(u.port || (sec2 ? 443 : 80));
    } else if (!loc.startsWith('/')) p2 = '/' + loc;
    if (p2 !== '/' && !/\/login/i.test(p2)) break; // уводит не на логин — не наш случай
    first = await get(sec2, host2, port2, p2, { 'User-Agent': 'Mozilla/5.0' });
    secure = sec2; host = host2; port = port2; path = p2;
    hops++;
  }
  const authHeader = () => first.headers && first.headers['www-authenticate'];
  let auth = authHeader();
  let haveChallenge = first.status === 401 && !!auth && /digest/i.test(auth);
  if (!haveChallenge) {
    // S4: страница-триггер вместо 401 — «Login required» + APPLY-форма.
    // Дёргаем POST-форму, получаем 401 Digest — и в общий Digest-флоу.
    if (first.status === 200 && /action=["']#login["']/i.test(first.body || '') && /APPLY/i.test(first.body || '')) {
      try {
        const r401 = await postForm(secure, host, port, '/login', 'APPLY=99&P99=Login');
        if (r401.status === 401 && /digest/i.test(String(r401.headers['www-authenticate'] || ''))) {
          first = r401;
          auth = authHeader();
          haveChallenge = true;
        }
      } catch { /* триггер не сработал — вернём страницу как есть */ }
    }
    if (!haveChallenge) {
      if (first.status === 200) return first;
      if (first.status >= 500 && first.status < 600) {
        throw new Error(`веб-сервер iRMC временно недоступен (${first.status}); подождите или перезапустите iRMC`);
      }
      throw new Error(`auth required (${first.status}) ${auth || ''}`);
    }
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
// S4: обычный Digest-вход НЕ создаёт сессию — страницы за «Login required».
// S4-флоу (эмпирически, Fw 7.69F):
//   1) POST /login (форма-триггер APPLY=99) -> 401 + Digest-челлендж
//      (nonce одноразовый: повторный POST с тем же nonce отвергается —
//      именно поэтому curl --digest и повторные попытки не работают)
//   2) НОВЫЙ Digest-POST с первого предъявления -> 302 на страницу
//      «...?sid=<sess-id>» — sid и есть веб-сессия S4
//   3) Дальше все страницы ходят с sid в query; на них есть avr.jnlp.
export async function getSession(cfg) {
  const { host, username, password, port = 80, secure = false } = cfg;
  let root = await digestGet(secure, host, port, '/', username, password);
  let link = /href="(avr\.jnlp\?[^"]+)"/i.exec(root.body);
  // S2-путь не сработал (страница-триггер вместо контента) — пробуем S4.
  if (!link && /Login required/i.test(root.body || '')) {
    const s4 = await s4Login(secure, host, port, username, password);
    if (s4) {
      const page = await get(secure, host, port, s4.pagePath, { 'User-Agent': 'Mozilla/5.0' });
      console.log('[s4] вход ок, страница:', page.status, 'len:', (page.body || '').length, 'sid:', s4.sid.slice(0, 6) + '…');
      link = /href="(avr\.jnlp\?[^"]+)"/i.exec(page.body || '');
      console.log('[s4] avr.jnlp на странице:', link ? 'есть' : 'НЕТ');
      if (link) {
        const j = await get(secure, host, port, '/' + link[1].replace(/&amp;/g, '&'), { 'User-Agent': 'Mozilla/5.0' });
        console.log('[s4] jnlp:', j.status, 'len:', (j.body || '').length, 'loc:', j.headers && j.headers.location || '-');
        console.log('[s4] jnlp head:', JSON.stringify((j.body || '').slice(0, 500)));
        console.log('[s4] jnlp tail:', JSON.stringify((j.body || '').slice(-1200)));
        const argsS4 = {};
        // S4-аргументы идут ПАРАМИ: <argument>-kvmtoken</argument><argument>VAL</argument>
        const argv = [];
        const reA = /<argument>([^<]*)<\/argument>/g;
        let mA;
        while ((mA = reA.exec(j.body || ''))) argv.push(mA[1].trim());
        for (let i = 0; i + 1 < argv.length; i += 2) {
          const k = argv[i].replace(/^-/, '');
          argsS4[k] = argv[i + 1];
        }
        console.log('[s4] jnlp args:', JSON.stringify(Object.keys(argsS4)));
        return {
          host, username,
          // S4-консоль: CONNECT-туннель на web-порт (kvmport), не VncPort
          port: Number(argsS4.kvmport || port) || port,
          secure: !!Number(argsS4.kvmsecure || 0),
          kvmPort: Number(argsS4.kvmport || port) || port,
          kvmSecure: !!Number(argsS4.kvmsecure || 0),
          webSecurePort: Number(argsS4.websecureport || 443) || 443,
          kvmtoken: argsS4.kvmtoken || '',
          webcookie: argsS4.webcookie || '',
          httpdata: '', digest: '',
          s4Sid: s4.sid, // метка S4-сессии
        };
      }
      throw new Error('S4: вход прошёл, но avr.jnlp на странице не найден');
    }
  }
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

// S4-вход: триггер -> ОДИН Digest-POST (свежий nonce, nc=00000001) ->
// 302 c sid. Возвращает {sid, pagePath} или null (не S4/не вышло).
async function s4Login(secure, host, port, username, password) {
  return _s4LoginInner(secure, host, port, username, password, false);
}
// Отладочный вход S4 (логирует шаги в консоль сервера).
export async function s4LoginDebug(secure, host, port, username, password) {
  return _s4LoginInner(secure, host, port, username, password, true);
}
async function _s4LoginInner(secure, host, port, username, password, dbg) {
  try {
    const r401 = await postForm(secure, host, port, '/login', 'APPLY=99&P99=Login');
    if (dbg) console.log('[s4] триггер:', r401.status);
    if (r401.status !== 401) return null;
    const wa = String(r401.headers['www-authenticate'] || '');
    if (!/digest/i.test(wa)) return null;
    const p = {};
    const re = /(\w+)="([^"]*)"/g;
    let m;
    while ((m = re.exec(wa))) p[m[1]] = m[2];
    if (!p.realm || !p.nonce) return null;
    const cnonce = randomHex(8);
    const ha1 = md5(`${username}:${p.realm}:${password}`);
    const ha2 = md5('POST:/login');
    const response = md5(`${ha1}:${p.nonce}:00000001:${cnonce}:auth:${ha2}`);
    const hd = `Digest username="${username}", realm="${p.realm}", nonce="${p.nonce}", uri="/login", response="${response}", qop=auth, nc=00000001, cnonce="${cnonce}"` + (p.opaque ? `, opaque="${p.opaque}"` : '');
    const r2 = await postForm(secure, host, port, '/login', 'APPLY=99&P99=Login', { Authorization: hd });
    if (dbg) console.log('[s4] digest-post:', r2.status, 'loc:', r2.headers.location);
    if (r2.status < 300 || r2.status >= 400) return null;
    const loc = String(r2.headers.location || '');
    const sid = (/[?&]sid=([^&]+)/.exec(loc) || [])[1] || null;
    if (!sid) return null;
    const u = new URL(loc, `http://${host}:${port}`);
    return { sid, pagePath: u.pathname + (u.search || '') };
  } catch {
    return null;
  }
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

// Диагностика веб-авторизации iRMC (кнопка «Проверить» при добавлении
// сервера): какая схема (Digest/Basic/форма/нет), принимает ли наши
// логин/пароль, и если нет — ПОЧЕМУ. Родно из реального случая: IPMI
// принимает креды, а веб — нет (ранние iRMC: Basic вместо Digest,
// form-login, либо вебка просто виснет — известный дефект S2).
// Жёсткий общий таймаут: на мёртвом/виснущем хосте http.get может висеть
// до kernel TCP-таймаута (минуты) — диагностика обязана ответить быстро.
export async function webAuthDiag(secure, host, port, username, password, hardMs = 12000) {
  const out = { ok: false, scheme: null, realm: null, title: null, status: null, verdict: '', redirected: null };
  const hard = new Promise((_, rej) => setTimeout(() => rej(new Error('диагностика веба: таймаут ' + hardMs + ' мс')), hardMs));
  try {
    return await Promise.race([
      webAuthDiagInner(secure, host, port, username, password, out),
      hard,
    ]);
  } catch (e) {
    out.verdict = out.verdict || ('веб не ответил за ' + Math.round(hardMs / 1000) + ' с: ' + String(e.message || e)
      + ' (вебка зависла или фильтрует — TCP при этом может открываться)');
    return out;
  }
}

async function webAuthDiagInner(secure, host, port, username, password, out) {
  let first;
  // S4/newer iRMC: «/» отвечает 302 (редирект на https://host/ или login) —
  // не запрашивая авторизацию. Следуем за редиректами (до 3), на финальной
  // странице определяем схему. S2 так не делает — сразу 401 Digest.
  let cur = { url: null };
  try {
    first = await get(secure, host, port, '/', { 'User-Agent': 'Mozilla/5.0' });
    let hops = 0;
    while (first.status >= 300 && first.status < 400 && hops < 3) {
      const loc = String((first.headers || {}).location || '');
      if (!loc || /^data:|^javascript:/i.test(loc)) break;
      const nextSecure = /^https:/i.test(loc) || (loc.startsWith('/') && secure);
      let nextPath = loc;
      if (/^https?:\/\//i.test(loc)) {
        const u = new URL(loc);
        nextPath = u.pathname + (u.search || '');
        // редирект на другой хост/порт (напр. http->https) — идём туда
        host = u.hostname; port = Number(u.port || (nextSecure ? 443 : 80));
      }
      out.redirected = (out.redirected ? out.redirected + ' → ' : '') + (first.status + ' ' + (loc.length > 40 ? loc.slice(0, 40) + '…' : loc));
      first = await get(nextSecure, host, port, nextPath.startsWith('/') ? nextPath : '/' + nextPath, { 'User-Agent': 'Mozilla/5.0' });
      secure = nextSecure;
      hops++;
    }
  } catch (e) {
    out.status = 0;
    out.verdict = 'веб-порт отвечает TCP, но HTTP не отвечает: ' + String(e.message || e)
      + (out.redirected ? ' (после ' + out.redirected + ')' : '')
      + ' (вебка зависла или не HTTP на этом порту — попробуйте SSL/другой порт)';
    return out;
  }
  out.status = first.status;
  out.title = (/<title[^>]*>([^<]*)<\/title>/i.exec(first.body || '') || [])[1]?.trim() || null;
  const wa = String((first.headers || {})['www-authenticate'] || '');
  out.realm = (/realm="([^"]+)"/i.exec(wa) || [])[1] || null;
  if (/^digest/i.test(wa)) out.scheme = 'Digest';
  else if (/^basic/i.test(wa)) out.scheme = 'Basic';
  if (first.status === 200) {
    const b = first.body || '';
    // S4 «Login required»: форма-триггер (POST APPLY=99) за Digest-челленджем.
    // Digest на S4 не отдаётся на GET «/» — только после формы. realm виден
    // в title (iRMC S4@host).
    if (/action=["']#login["']/i.test(b) && /APPLY/i.test(b)) {
      out.scheme = 'Digest (форма-триггер)';
      try {
        // POST формы → ожидаем 401 Digest; проверяем креды digestGet-ом
        const r401 = await postForm(secure, host, port, '/login', 'APPLY=99&P99=Login');
        const wa2 = String((r401.headers || {})['www-authenticate'] || '');
        const realm2 = (/realm="([^"]+)"/i.exec(wa2) || [])[1] || null;
        if (realm2) out.realm = realm2;
        const r = await digestGet(secure, host, port, '/login', username, password);
        if (r.status === 200) { out.ok = true; out.verdict = 'S4 form-триггер + Digest: логин/пароль приняты'; }
        else { out.status = r.status; out.verdict = `S4: Digest отверг логин/пароль (HTTP ${r.status}) — веб-креды отличаются от IPMI`; }
      } catch (e) {
        out.verdict = 'S4 login-попытка: ' + String(e.message || e);
      }
      return out;
    }
    if (/login\.cgi|<form/i.test(b) && /password/i.test(b)) {
      out.scheme = out.scheme || 'Form';
      out.verdict = 'логин формой на странице (form-based) — Digest/Basic не поддерживаются';
      return out;
    }
    if (/href="avr\.jnlp/i.test(b)) { out.ok = true; out.verdict = 'веб открыт без авторизации'; return out; }
    out.ok = true;
    out.verdict = 'веб отвечает 200 без запроса авторизации';
    return out;
  }
  if (first.status !== 401) {
    if (first.status >= 300 && first.status < 400) {
      out.verdict = `редирект-петля (HTTP ${first.status} после переходов` + (out.redirected ? ' ' + out.redirected : '') + ') — веб нестандартен, вручную откройте в браузере';
    } else if (first.status === 404) {
      out.verdict = 'страница «/» не найдена (404) — веб жив, но структура другая (проверьте вручную)';
      out.ok = true; // веб-сервер работает
    } else {
      out.verdict = `неожиданный ответ веба: HTTP ${first.status}` + (out.redirected ? ' (после ' + out.redirected + ')' : '');
    }
    return out;
  }
  if (!out.scheme) {
    out.verdict = '401 без схемы авторизации (WWW-Authenticate пуст) — нестандартный веб-сервер';
    return out;
  }
  if (out.scheme === 'Digest') {
    try {
      const r = await digestGet(secure, host, port, '/', username, password);
      if (r.status === 200) { out.ok = true; out.verdict = 'Digest: логин/пароль приняты'; }
      else { out.status = r.status; out.verdict = `Digest отверг логин/пароль (HTTP ${r.status}) — на вебе другие креды, чем на IPMI`; }
    } catch (e) {
      out.verdict = 'Digest-попытка: ' + String(e.message || e);
    }
    return out;
  }
  // Basic
  try {
    const r = await get(secure, host, port, '/', {
      'User-Agent': 'Mozilla/5.0',
      Authorization: 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64'),
    });
    if (r.status === 200) { out.ok = true; out.verdict = 'Basic: логин/пароль приняты'; }
    else out.verdict = `Basic отверг логин/пароль (HTTP ${r.status}) — на вебе другие креды, чем на IPMI`;
  } catch (e) {
    out.verdict = 'Basic-попытка: ' + String(e.message || e);
  }
  return out;
}
