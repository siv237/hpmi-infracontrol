// Web-based iRMC AVR viewer bridge.
// Stage 1: simple page that takes host/username/password (plus optional port,
// secure/httpdata) and performs a connection + protocol handshake test against
// a Fujitsu iRMC, reporting what the server replies.
// Saved servers (with encrypted credentials) let you test without re-typing.

import http from 'node:http';
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { IrmcClient, testIrmc } from './irmc.js';
import * as ipmi from './ipmi.js';
import * as db from './db.js';
import { checkChannels } from './channels.js';
import { listServers, saveServer, deleteServer, getServer, updateServer } from './store.js';
import { listUsers, saveUser, updateUser, deleteUser, verifyPasswordByLogin, updatePassword, migrateLegacy } from './users-store.js';
import { decrypt as decryptLegacyBox, getKey } from './crypto-box.js';
import { discover, getSession, inventory, parseInventory } from './discover.js';
import { probe } from './probe.js';
import { attachVnc } from './vnc.js';
import { encodePng, saveScreenshot } from './png.js';
import * as iso from './iso.js';
import * as m2 from './m2.js';

const PORT = Number(process.env.PORT || 1845);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// === База собранных IPMI-данных (фаза 2) — data/db/ipmi.sqlite ============
// Весь сбор (сенсоры/SEL/опросы/инвентарь/версии/события) — в SQLite.
// ИНВАРИАНТ: rm -rf data/db/ очищает весь сбор и только его — настройки
// (servers.json, интервалы) вне БД, опрос продолжается сразу.
// Разовая миграция: старые metrics.sqlite + storage.json -> новая схема;
// legacy-файлы замораживаются (*.migrated), не удаляются.
db.initDb();
{
  const dataDir = path.join(ROOT, 'data');
  const migrated = db.migrateLegacy(dataDir, (m) => console.log('[db] ' + m));
  if (migrated > 0) {
    db.freezeLegacy(dataDir);
    console.log(`[db] миграция legacy завершена: ${migrated} записей, старые файлы -> *.migrated`);
  }
}

// Монтирования ISO — операционное состояние, остаётся в JSON (storage.js).
const storage = await import('./storage.js');

// Live console sessions: token -> { cli, listeners, name, host, state }
const sessions = new Map();
const sessionsByHost = new Map(); // host -> token (one active console per host)

// Сессии входа: токен -> userId (см. /api/login, authUser)
const authSessions = new Map();

// Разовая миграция старых блобов паролей пользователей в scrypt-хэши
// (необратимое хранение; расшифровываемые AES-блобы — только креды серверов).
// Ключ должен быть загружен ДО расшифровки — иначе блоб был бы потерян.
migrateLegacy(async (b) => { await getKey(); return decryptLegacyBox(b); }).catch(() => {});

function createSession(name, host) {
  const token = randomUUID();
  const sess = {
    token, name, host,
    listeners: new Set(),
    fullCbs: new Set(),
    cli: null, state: 'starting', width: 0, height: 0, status: [], error: null, startedAt: Date.now(),
    clients: new Set(),
    lastFrameAt: Date.now(),
    manualClose: false,        // true — только после ручного «Отключиться»
    creds: null,               // последние использованные креды (в памяти, не персистится)
    reconnectTimer: null,
    _retryN: 0,
    fb(rects) { const c = sess.cli; return c ? { width: c.fb.width, height: c.fb.height, pix: rects ? c.fb.getRGBFor(rects) : c.fb.getRGB() } : { width: 0, height: 0, pix: new Uint32Array(0) }; },
    fbSize() { const c = sess.cli; return c ? { width: c.fb.width, height: c.fb.height } : { width: 0, height: 0 }; },
    key: (k, d) => sess.cli && sess.cli.key(k, d),
    mouseMove: (x, y) => sess.cli && sess.cli.mouseMove(x, y),
    buttonState: (x, y, m) => sess.cli && sess.cli.buttonState(x, y, m),
    subscribe(cb) { sess.listeners.add(cb); },
    unsubscribe(cb) { sess.listeners.delete(cb); },
    onFull(cb) { sess.fullCbs.add(cb); },
    offFull(cb) { sess.fullCbs.delete(cb); },
    // "Keyframe": push a full framebuffer to every client so any frames lost to
    // backpressure / fast bursts are repaired instead of leaving black gaps.
    forceFull() { for (const cb of sess.fullCbs) { try { cb(); } catch {} } },
  };
  sessions.set(token, sess);
  sessionsByHost.set(host, token);
  return sess;
}

function closeSession(tokenOrSess) {
  const sess = typeof tokenOrSess === 'string' ? sessions.get(tokenOrSess) : tokenOrSess;
  if (!sess) return;
  if (sess._refresh) clearInterval(sess._refresh);
  if (sess._keyframe) clearInterval(sess._keyframe);
  if (sess.cli) { try { sess.cli.close(); } catch {} }
  if (sessionsByHost.get(sess.host) === sess.token) sessionsByHost.delete(sess.host);
  sessions.delete(sess.token);
}

// digest login with retries; httpdata is NOT cached (session material, and a
// stale token makes the AVR drop the video stream after the handshake).
async function cachedSession(cfg) {
  let last;
  for (let i = 0; i < 3; i++) {
    try { return await getSession(cfg); }
    catch (e) { last = e; if (i === 2) throw e; await new Promise((r) => setTimeout(r, 900)); }
  }
  throw last;
}

async function startSession(sess, host, user, pass, port, secure) {
  // креды держим в памяти сессии — авто-реконнект поднимает то же подключение
  sess.creds = { host, user, pass, port, secure };
  const cfg = await cachedSession({ host, username: user, password: pass, port, secure });
  const cli = new IrmcClient(cfg, {
    onStatus: (s) => {
      sess.status.push(s);
      if (s.startsWith('vesa:')) {
        sess.state = 'live';
        sess._retryN = 0; // связь поднята — сбрасываем счётчик реконнектов
        const m = /^vesa:(\d+)x(\d+)@(\d+)/.exec(s);
        if (m) { sess.width = +m[1]; sess.height = +m[2]; }
      }
    },
    onError: (e) => { sess.error = e; sess.state = 'error'; scheduleReconnect(sess); },
    onExit: () => { sess.state = 'closed'; scheduleReconnect(sess); },
    onFrame: (fb, rects) => {
      if (process.env.IRMC_DEBUG === '1' && (fb.width !== sess.width || fb.height !== sess.height)) {
        console.log(`[dbg] framebuffer size ${sess.width}x${sess.height} -> ${fb.width}x${fb.height} (rects=${rects ? rects.length : 0})`);
      }
      sess.width = fb.width; sess.height = fb.height;
      sess.lastFrameAt = Date.now();
      for (const cb of sess.listeners) cb(fb, rects);
    },
  });
  sess.cli = cli;
  await cli.start();
  // Static/black screens produce no change-frames, so the framebuffer stays
  // blank even though the device shows content. Also, fast bursts can drop
  // frame pieces leaving black gaps. Act as a periodic "keyframe": every 10s
  // force the device to resend the full current screen (invalidateFull) and
  // push a full framebuffer to every client. Resolution re-verification rides
  // on this too: the resend is at the CURRENT mode, and on a size change the
  // VNC layer emits DesktopSize so noVNC resizes (keeps aspect ratio).
  sess._keyframe = setInterval(() => {
    try {
      if (!sess.cli) return;
      sess.cli.invalidateFull();
      sess.forceFull();
    } catch {}
  }, 10000);
  return sess;
}

// Перезапуск сессии НА МЕСТЕ: тот же токен и объект сессии, новый клиент iRMC.
async function restartSession(sess) {
  if (sess._keyframe) { clearInterval(sess._keyframe); sess._keyframe = null; }
  if (sess.cli) { try { sess.cli.close(); } catch {} sess.cli = null; }
  sess.state = 'starting'; sess.error = null; sess.startedAt = Date.now();
  const c = sess.creds;
  await startSession(sess, c.host, c.user, c.pass, c.port, c.secure);
}

// Авто-восстановление сессии iRMC в ТОМ ЖЕ токене: браузерные клиенты
// (уже сидящие на /vnc?token=...) продолжают получать кадры после
// восстановления, переподключаться им не нужно. Ручное «Отключиться»
// (manualClose) авто-реконнект отменяет.
function scheduleReconnect(sess) {
  if (!sess || sess.manualClose || sess.reconnectTimer || !sess.creds) return;
  sess._retryN += 1;
  const delay = Math.min(30000, 2000 * Math.pow(2, sess._retryN - 1));
  sess.reconnectTimer = setTimeout(async () => {
    sess.reconnectTimer = null;
    if (sess.manualClose || sess.cli) return;
    try {
      await restartSession(sess);
      await waitLive(sess, 10000);
      if (sess.state !== 'live') scheduleReconnect(sess);
    } catch { scheduleReconnect(sess); }
  }, delay);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // --- API ---------------------------------------------------------------

  // Авторизация: все /api/* требуют входа (сессия из Authorization/X-Session),
  // кроме страницы входа и выхода. Роль текущего пользователя — req.user.
  const AUTH_OPEN = ['/api/login', '/api/logout', '/api/me', '/api/me/password'];
  if (url.pathname.startsWith('/api/') && !AUTH_OPEN.includes(url.pathname)) {
    const au = await authUser(req);
    if (!au) return json(res, 401, { ok: false, error: 'требуется вход' });
    req.user = au;
  }

  // Локальные настройки отображения (data/ui.json, вне git): например,
  // rootName — имя корня дерева серверов. Фактические названия инфраструктуры
  // в git не попадают.
  if (url.pathname === '/api/ui' && req.method === 'GET') {
    try {
      const cfg = JSON.parse(await readFile(path.join(ROOT, 'data', 'ui.json'), 'utf8'));
      return json(res, 200, { ok: true, rootName: String(cfg.rootName || '').trim() || 'Все серверы' });
    } catch { return json(res, 200, { ok: true, rootName: 'Все серверы' }); }
  }

  if (url.pathname === '/api/test' && req.method === 'POST') {
    const body = await readJson(req, res);
    if (!body) return;
    let cfg;
    try {
      if (body.serverId) {
        const stored = await getServer(body.serverId);
        if (!stored) return json(res, 404, { ok: false, error: 'server not found' });
        // Get a fresh per-session httpdata + AVR port via digest login.
        cfg = await getSession(stored);
      } else {
        cfg = body;
      }
    } catch (e) { return json(res, 400, { ok: false, error: 'session/login failed: ' + (e.message || e) }); }
    const { host, username, password, port = 80, secure = false, httpdata = '' } = cfg;
    if (!host || !username) return json(res, 400, { ok: false, error: 'host and username are required' });
    try {
      const result = await testIrmc({ host, port: Number(port), secure: !!secure, username, password: password || '', httpdata });
      json(res, 200, result);
    } catch (e) {
      json(res, 200, { ok: false, error: String(e.message || e), info: e.info });
    }
    return;
  }

  if (url.pathname === '/api/connect' && req.method === 'POST') {
    const body = await readJson(req, res);
    if (!body) return;
    let stored;
    try { stored = await getServer(body.serverId); } catch { return json(res, 400, { ok: false, error: 'local read failed' }); }
    if (!stored) return json(res, 404, { ok: false, error: 'server not found' });
    // The iRMC console is single-session and fragile: REUSE the existing live
    // session (do NOT open a second console, which is what knocks the device
    // into 503). Any number of browser clients attach to that one session and
    // can watch/control simultaneously. A 'starting' session that has been
    // stuck (no video mode) for a while is stale — the iRMC still holds the
    // console, so release it (sends 0xd8) and re-open.
    const existing = sessionsByHost.get(stored.host);
    if (existing && sessions.get(existing)) {
      const es = sessions.get(existing);
      if (es.state === 'live') return json(res, 200, { ok: true, token: es.token, name: es.name, host: es.host, width: es.width, height: es.height, state: es.state });
      if (es.state === 'starting') {
        const stuck = Date.now() - (es.startedAt || Date.now()) > 8000 && es.width === 0;
        if (!stuck) {
          await waitLive(es, 6000);
          if (es.state === 'live') return json(res, 200, { ok: true, token: es.token, name: es.name, host: es.host, width: es.width, height: es.height, state: es.state });
        }
        // fall through: release the stale session and open a fresh console
        es.manualClose = true; // осознанный релиз зависшей — без авто-реконнекта
        closeSession(existing);
      } else if (!es.manualClose && es.creds) {
        // сессия оборвалась (iRMC/сеть) и не была закрыта вручную —
        // восстанавливаем ТОТ ЖЕ токен на месте; клиенты просто продолжат
        if (es.reconnectTimer) { clearTimeout(es.reconnectTimer); es.reconnectTimer = null; }
        restartSession(es).catch(() => scheduleReconnect(es));
        await waitLive(es, 8000);
        return json(res, 200, { ok: true, token: es.token, name: es.name, host: es.host, width: es.width, height: es.height, state: es.state });
      } else {
        es.manualClose = true;
        closeSession(existing); // closed/error после ручного отключения -> свежая
      }
    }
    const sess = createSession(stored.name || stored.host, stored.host);
    try {
      await startSession(sess, stored.host, stored.username, stored.password || '', stored.port, stored.secure);
      await waitLive(sess, 10000);
      // если у сервера есть активный маунт — дослать 153 по свежей сессии
      try { const m = await storage.getMount(body.serverId); if (m) realMount(stored, m.isoId).catch(() => {}); } catch {}
      return json(res, 200, { ok: true, token: sess.token, name: sess.name, host: sess.host, width: sess.width, height: sess.height, state: sess.state });
    } catch (e) {
      sess.manualClose = true; // первичный коннект не удался — не крутим реконнекты
      closeSession(sess);
      return json(res, 200, { ok: false, error: String(e.message || e), state: sess.state, status: sess.status });
    }
  }

  if (url.pathname.startsWith('/api/snapshot/') && req.method === 'GET') {
    const token = decodeURIComponent(url.pathname.slice('/api/snapshot/'.length));
    const s = sessions.get(token);
    if (!s || !s.cli) return json(res, 404, { ok: false, error: 'no session' });
    const fb = s.cli.fb;
    const rgb = (fb && fb.getRGB ? fb.getRGB() : new Uint32Array(0));
    const file = saveScreenshot('console', fb.width, fb.height, rgb);
    const png = encodePng(fb.width, fb.height, rgb);
    return json(res, 200, {
      ok: true, width: fb.width, height: fb.height,
      png: png ? 'data:image/png;base64,' + png.toString('base64') : null,
      saved: file || null,
    });
  }

  if (url.pathname.startsWith('/api/session/') && req.method === 'GET') {
    const token = decodeURIComponent(url.pathname.slice('/api/session/'.length));
    const s = sessions.get(token);
    if (!s) return json(res, 404, { ok: false, error: 'no session' });
    let fbNonZero = -1;
    try {
      const c = s.cli;
      if (c && c.fb && c.fb.pix) {
        let nz = 0; const end = Math.min(c.fb.pix.length, 400000);
        for (let i = 0; i < end; i++) if (c.fb.pix[i] !== 0) nz++;
        fbNonZero = nz;
      }
    } catch {}
    return json(res, 200, { ok: true, state: s.state, width: s.width, height: s.height, fbNonZero, status: s.status.slice(-30), error: s.error });
  }

  // Ввод с KVM-тулбара (Ctrl/Alt/Del/Esc): список шагов {c: hidCode, d: down},
  // исполняется по порядку с паузой ~25 мс между шагами, чтобы iRMC успел
  // зарегистрировать нажатие/отпускание (например, Ctrl+Alt+Del).
  if (url.pathname === '/api/keys' && req.method === 'POST') {
    const body = await readJson(req, res);
    if (!body) return;
    const s = sessions.get(body.token);
    if (!s || !s.cli) return json(res, 404, { ok: false, error: 'no session' });
    const steps = Array.isArray(body.steps) ? body.steps.slice(0, 64) : [];
    (async () => {
      for (const st of steps) {
        if (!st || typeof st.c !== 'number') continue;
        try { s.key(st.c, !!st.d); } catch {}
        await new Promise((r) => setTimeout(r, 25));
      }
    })();
    return json(res, 200, { ok: true, steps: steps.length });
  }

  // Закрыть консольную сессию: освобождает iRMC (ClientDisconnect 0xd8),
  // чтобы следующий /api/connect поднимал свежую консоль, а не натыкался
  // на «одну активную консоль».
  if (url.pathname === '/api/disconnect' && req.method === 'POST') {
    const body = await readJson(req, res);
    if (!body) return;
    const s = sessions.get(body.token);
    if (!s) return json(res, 200, { ok: true, gone: true });
    s.manualClose = true; // ручное отключение — авто-реконнект не нужен
    closeSession(s);
    return json(res, 200, { ok: true });
  }

  if (url.pathname === '/api/info' && req.method === 'POST') {
    const body = await readJson(req, res);
    if (!body) return;
    let cfg;
    try { cfg = body.serverId ? await getServer(body.serverId) : body; } catch { return json(res, 400, { ok: false, error: 'local read failed' }); }
    if (!cfg) return json(res, 400, { ok: false, error: 'server not found' });
    // Prefer authenticated inventory (model/serial/BIOS/OS), fall back to probe.
    try {
      const inv = await inventory(cfg);
      const invMap = inv.inventory || {};
      let configChanges = [];
      if (body.serverId) {
        // фактическое подключение: снимок + история версий + событие
        configChanges = db.saveSnapshot(body.serverId, invMap).changes;
        db.recordVersionSnapshot(body.serverId, invMap, req.user?.login || null);
        db.addEvent(body.serverId, 'info', `Данные iRMC получены (${cfg.name || cfg.host})`);
        for (const c of configChanges) db.addEvent(body.serverId, 'warn', `Изменение конфигурации · ${c.field}: ${c.from} → ${c.to}`);
      }
      return json(res, 200, { ok: true, inventory: invMap, configChanges, ...inv });
    } catch {
      try {
        const p = await probe(cfg);
        return json(res, 200, p);
      } catch (e) { return json(res, 200, { ok: false, error: String(e.message || e) }); }
    }
  }

  // Офлайн-данные: последний снимок инвентаря сервера (из БД)
  if (url.pathname.startsWith('/api/last-known/') && req.method === 'GET') {
    const id = decodeURIComponent(url.pathname.slice('/api/last-known/'.length));
    const lk = db.getLastKnown(id);
    if (!lk) return json(res, 404, { ok: false, error: 'нет сохранённых данных' });
    return json(res, 200, { ok: true, ts: lk.ts, inventory: lk.inventory });
  }

  // Журнал изменений конфигурации (из БД)
  if (url.pathname === '/api/changes' && req.method === 'GET') {
    const serverId = url.searchParams.get('serverId') || null;
    const limit = Number(url.searchParams.get('limit')) || 100;
    return json(res, 200, { ok: true, changes: db.getChanges(serverId, limit) });
  }

  // События подключений/обновлений данных (из БД)
  if (url.pathname === '/api/events' && req.method === 'GET') {
    const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 500);
    const serverId = url.searchParams.get('serverId') || null;
    return json(res, 200, { ok: true, events: db.getEvents(limit, serverId) });
  }

  // История версий оборудования по серверу (из БД)
  if (url.pathname === '/api/versions' && req.method === 'GET') {
    const serverId = url.searchParams.get('serverId');
    if (!serverId) return json(res, 400, { ok: false, error: 'serverId required' });
    const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 500);
    return json(res, 200, { ok: true, serverId, versions: db.getVersions(serverId, limit) });
  }

  // Обзор (п.1) по макету 09.09: три канала (ipmi/ping/web) независимы,
  // статус считается «IPMI главный»: online=ipmi ok; warn=web ✗ при живом
  // ipmi; problem=ipmi ✗ при живом ping; off=ping ✗ (хост не отвечает).
  if (url.pathname === '/api/overview' && req.method === 'GET') {
    const list = await listServers(false);
    const servers = [];
    for (const s of list) {
      const st = db.serverStatus(s.id);
      const lk = db.getLastKnown(s.id);
      let status = 'none';
      const ch = st ? st.channels : null;
      if (ch) {
        const ipmiOk = ch.ipmi && ch.ipmi.ok;
        const pingOk = ch.ping ? ch.ping.ok : null;
        const webOk = ch.web ? ch.web.ok : null;
        if (pingOk === false) status = 'off';
        else if (!ipmiOk) status = 'problem';
        else if (webOk === false) status = 'warn';
        else status = 'on';
      }
      servers.push({
        id: s.id, name: s.name, host: s.host, group: s.group || '',
        lastCheck: lk ? lk.ts : null,
        status,
        channels: ch || { ping: null, web: null, ipmi: null },
        sensorCount: (() => { try { return Object.keys(db.lastValues()[s.id] || {}).length; } catch { return 0; } })(),
        inventoryCount: lk && lk.inventory ? Object.keys(lk.inventory).length : 0,
      });
    }
    const summary = {
      total: servers.length,
      on: servers.filter((s2) => s2.status === 'on').length,
      warn: servers.filter((s2) => s2.status === 'warn').length,
      problem: servers.filter((s2) => s2.status === 'problem').length,
      off: servers.filter((s2) => s2.status === 'off').length,
      none: servers.filter((s2) => s2.status === 'none').length,
      // проблемы подключения по каналам (макет: «Проблемы подключения»)
      pingDown: servers.filter((s2) => s2.channels && s2.channels.ping && s2.channels.ping.ok === false).length,
      webDown: servers.filter((s2) => s2.channels && s2.channels.web && s2.channels.web.ok === false).length,
      ipmiDown: servers.filter((s2) => s2.channels && s2.channels.ipmi && s2.channels.ipmi.ok === false).length,
    };
    // Доступность за окно (п.5): из SQLite — питает график/сводку дашборда
    const windowSec = Math.min(Number(url.searchParams.get('window')) || 86400, 30 * 86400);
    const avSum = db.availabilitySummary(windowSec);
    const pcts = servers.map((s2) => (avSum[s2.id] && avSum[s2.id].pct !== null ? avSum[s2.id].pct : null)).filter((p) => p !== null);
    const avgPct = pcts.length ? Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length * 10) / 10 : null;
    return json(res, 200, {
      ok: true, summary, servers,
      availability: {
        avgPct,
        buckets: db.availabilityBuckets(windowSec),
        perServer: avSum,
      },
    });
  }

  // === Хранилище ISO (п.10.2): загрузка/список/удаление/переименование/раздача
  // Список образов
  if (url.pathname === '/api/iso' && req.method === 'GET') {
    try { return json(res, 200, { ok: true, images: await iso.listImages() }); }
    catch (e) { return json(res, 500, { ok: false, error: String(e.message || e) }); }
  }
  // Загрузка образа (admin): тело = бинарник, имя в query ?name=
  if (url.pathname === '/api/iso' && req.method === 'POST') {
    if (req.user.role !== 'admin') return json(res, 403, { ok: false, error: 'права администратора' });
    let name = url.searchParams.get('name') || '';
    if (!name) {
      const cd = req.headers['content-disposition'] || '';
      const m = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(cd);
      name = m ? decodeURIComponent(m[1]) : '';
    }
    if (!name.trim()) return json(res, 400, { ok: false, error: 'укажите имя (name)' });
    try {
      const done = await iso.uploadStream(req, { name, signal: res.req?.req });
      db.addEvent(null, 'info', `Загружен ISO · ${done.name} (${done.size} байт)`);
      return json(res, 200, { ok: true, image: done });
    } catch (e) { return json(res, 400, { ok: false, error: String(e.message || e) }); }
  }
  // Переименование
  if (url.pathname.startsWith('/api/iso/') && req.method === 'PATCH') {
    if (req.user.role !== 'admin') return json(res, 403, { ok: false, error: 'права администратора' });
    const id = decodeURIComponent(url.pathname.slice('/api/iso/'.length));
    const body = await readJson(req, res);
    if (!body || !body.name) return json(res, 400, { ok: false, error: 'name required' });
    const m = await iso.renameImage(id, body.name);
    if (!m) return json(res, 404, { ok: false, error: 'не найдено' });
    return json(res, 200, { ok: true, name: m.name });
  }
  // Удаление
  if (url.pathname.startsWith('/api/iso/') && req.method === 'DELETE') {
    if (req.user.role !== 'admin') return json(res, 403, { ok: false, error: 'права администратора' });
    const id = decodeURIComponent(url.pathname.slice('/api/iso/'.length));
    const ok = await iso.deleteImage(id);
    return json(res, ok ? 200 : 404, { ok });
  }
  // Раздача байт образа (read-only) — для будущего монтирования на iRMC
  if (url.pathname.startsWith('/api/iso/') && req.method === 'GET') {
    const t = url.pathname.slice('/api/iso/'.length);
    if (!t.endsWith('/bytes')) return json(res, 404, { ok: false, error: 'not found' });
    const id = decodeURIComponent(t.slice(0, -'/bytes'.length));
    const img = await iso.openImage(id);
    if (!img) return json(res, 404, { ok: false, error: 'не найдено' });
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': img.size, 'cache-control': 'no-store' });
    img.stream.pipe(res);
    return;
  }

  // === Монтирование ISO: состояние «что примонтировано» (п.10/10.5) ===
  // Реальный проброс: движок M2 из легаси-jar (server/m2.js) — он сам
  // соединяется с iRMC и отдаёт образ как SCSI CD. KVM-сессия для этого
  // не нужна (в легаси Java команды 153/154 по KVM не шлёт вовсе).
  function realMount(srv, isoId) {
    return m2.share({
      host: srv.host,
      port: srv.port || 80, // в легаси m_storagePort = HTTP-порт iRMC
      sharePath: iso.isoPath(isoId),
    });
  }
  function realUnmount() {
    m2.unshare();
  }
  // Список монтирований (все серверы) — с именами серверов/образов
  if (url.pathname === '/api/mounts' && req.method === 'GET') {
    const list = await listServers(false);
    const byId = {}; for (const s of list) byId[s.id] = s.name || s.host;
    const mounts = await storage.getMounts();
    const out = Object.entries(mounts).map(([serverId, m]) => ({
      serverId, isoId: m.isoId, isoName: m.isoName, ts: m.ts, by: m.by || null,
      serverName: byId[serverId] || serverId,
    }));
    return json(res, 200, { ok: true, mounts: out });
  }
  // Живые метрики активного монтирования (активность/скорость передачи)
  if (url.pathname === '/api/mounts/stats' && req.method === 'GET') {
    return json(res, 200, { ok: true, stats: m2.stats() });
  }
  // Восстановить сессию монтирования (admin): повторный share по прошлому конфигу
  if (url.pathname === '/api/mounts/recover' && req.method === 'POST') {
    if (req.user.role !== 'admin') return json(res, 403, { ok: false, error: 'права администратора' });
    const r = await m2.recover();
    return json(res, r.ok ? 200 : 409, r);
  }
  // Метрики по IPMI (p.5): сенсоры (темп/кулеры) — из БД (последний опрос).
  // После рестарта данные сразу из базы, без «прогрева» кеша.
  if (url.pathname === '/api/ipmi/sensors' && req.method === 'GET') {
    const serverId = new URL(req.url, 'http://x').searchParams.get('serverId');
    const list = await listServers(false);
    if (serverId) {
      const c = db.pollCache(serverId);
      if (c) return json(res, 200, { ok: true, ...c });
      return json(res, 404, { ok: false, error: 'нет данных опроса' });
    }
    const out = {};
    for (const s of list) { const c = db.pollCache(s.id); if (c) out[s.id] = c; }
    return json(res, 200, { ok: true, sensors: out });
  }
  // SEL-события (журнал IPMI) по серверу — из БД (последний снимок SEL)
  if (url.pathname === '/api/ipmi/sel' && req.method === 'GET') {
    const serverId = new URL(req.url, 'http://x').searchParams.get('serverId');
    const list = await listServers(false);
    if (serverId) {
      const c = db.pollCache(serverId);
      if (c) return json(res, 200, { ok: true, events: c.events || [], ts: c.ts });
      return json(res, 404, { ok: false, error: 'нет данных опроса' });
    }
    const out = {};
    for (const s of list) { const c = db.pollCache(s.id); if (c) out[s.id] = c.events || []; }
    return json(res, 200, { ok: true, sel: out });
  }
  // Питание/здоровье (chassis) — из БД
  if (url.pathname === '/api/ipmi/chassis' && req.method === 'GET') {
    const serverId = new URL(req.url, 'http://x').searchParams.get('serverId');
    const list = await listServers(false);
    if (serverId) {
      const c = db.pollCache(serverId);
      if (c) return json(res, 200, { ok: true, power: c.power, faults: c.faults, ts: c.ts });
      return json(res, 404, { ok: false, error: 'нет данных опроса' });
    }
    const out = {};
    for (const s of list) { const c = db.pollCache(s.id); if (c) out[s.id] = { power: c.power, faults: c.faults }; }
    return json(res, 200, { ok: true, chassis: out });
  }
  // Сетевые настройки BMC (lan print + mc info) — из БД, последний опрос.
  // MAC — часть данных (4a): в БД, в карточке, поиск по нему.
  if (url.pathname === '/api/ipmi/network' && req.method === 'GET') {
    const serverId = new URL(req.url, 'http://x').searchParams.get('serverId');
    const list = await listServers(false);
    if (serverId) {
      const c = db.pollCache(serverId);
      if (c) return json(res, 200, { ok: true, net: c.net || {}, ts: c.ts, up: c.up });
      return json(res, 404, { ok: false, error: 'нет данных опроса' });
    }
    const out = {};
    for (const s of list) { const c = db.pollCache(s.id); if (c) out[s.id] = c.net || {}; }
    return json(res, 200, { ok: true, network: out });
  }
  if (url.pathname === '/api/ipmi/metrics' && req.method === 'GET') {
    const serverId = new URL(req.url, 'http://x').searchParams.get('serverId');
    const windowSec = Math.min(Number(new URL(req.url, 'http://x').searchParams.get('window')) || 86400, 30 * 86400);
    const build = (sid) => {
      const ping = db.series(sid, 'ping', windowSec);
      const up = ping.filter((r) => r[1] >= 1).length;
      return {
        temps: db.avgSeries(sid, 'temp:', windowSec),
        fans: db.avgSeries(sid, 'fan:', windowSec),
        response_ms: db.series(sid, 'response_ms', windowSec),
        ping,
        availPct: ping.length ? Math.round((100 * up) / ping.length * 10) / 10 : null,
        lastValues: db.lastValues()[sid] || {},
      };
    };
    if (serverId) return json(res, 200, { ok: true, ...build(serverId) });
    const out = {};
    const sids = Object.keys(db.lastValues());
    for (const sid of sids) out[sid] = build(sid);
    return json(res, 200, { ok: true, series: out });
  }
  // Примонтировать (admin): {serverId, isoId}
  if (url.pathname === '/api/mounts' && req.method === 'PUT') {
    if (req.user.role !== 'admin') return json(res, 403, { ok: false, error: 'права администратора' });
    const body = await readJson(req, res);
    if (!body || !body.serverId || !body.isoId) return json(res, 400, { ok: false, error: 'serverId и isoId обязательны' });
    const list = await listServers(false);
    const srv = list.find((s) => s.id === body.serverId);
    if (!srv) return json(res, 404, { ok: false, error: 'server не найден' });
    const img = await iso.openImage(body.isoId);
    if (!img) return json(res, 404, { ok: false, error: 'ISO не найден' });
    const stale = img.stream; try { stale.destroy(); } catch { }
    const m = await storage.setMount(body.serverId, img.meta, req.user?.login || null);
    const real = await realMount(srv, body.isoId).catch((e) => { console.error('[mount] m2 share failed:', e.message); return false; });
    db.addEvent(body.serverId, 'info', `Примонтирован ISO «${img.meta.name}» к ${srv.name || srv.host}` + (real ? '' : ' (ожидает открытой сессии)'));
    return json(res, 200, { ok: true, mount: m, real });
  }
  // Отмонтировать (admin)
  if (url.pathname.startsWith('/api/mounts/') && req.method === 'DELETE') {
    if (req.user.role !== 'admin') return json(res, 403, { ok: false, error: 'права администратора' });
    const serverId = decodeURIComponent(url.pathname.slice('/api/mounts/'.length));
    const m = await storage.getMount(serverId);
    if (m) {
      const list = await listServers(false);
      const srv = list.find((s) => s.id === serverId);
      if (srv) realUnmount();
    }
    const ok = await storage.clearMount(serverId);
    if (ok) db.addEvent(serverId, 'info', 'Отмонтирован ISO');
    return json(res, ok ? 200 : 404, { ok });
  }

  if (url.pathname === '/api/discover' && req.method === 'POST') {
    const body = await readJson(req, res);
    if (!body) return;
    let cfg;
    try { cfg = body.serverId ? await getServer(body.serverId) : body; } catch { return json(res, 400, { ok: false, error: 'local read failed' }); }
    if (!cfg) return json(res, 400, { ok: false, error: 'server not found' });
    try {
      const d = await discover(cfg);
      return json(res, 200, { ok: true, discover: d });
    } catch (e) { return json(res, 200, { ok: false, error: String(e.message || e) }); }
  }

  // --- авторизация --------------------------------------------------------
  // Сессии в памяти: токен -> userId. Токен приходит в заголовке
  // Authorization: Bearer / X-Session (добавляет фронт). Дальше все /api/*
  // требуют входа; мутации — роли admin.
  async function authUser(req) {
    const h = req.headers['authorization'] || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : (req.headers['x-session'] || null);
    if (!token) return null;
    const uid = authSessions.get(token);
    if (!uid) return null;
    try {
      const u = (await listUsers()).find((x) => x.id === uid);
      return u && u.enabled ? u : null;
    } catch { return null; }
  }

  if (url.pathname === '/api/login' && req.method === 'POST') {
    const body = await readJson(req, res);
    if (!body) return;
    const u = await verifyPasswordByLogin(body.login, body.password || '');
    if (!u || !u.enabled) return json(res, 200, { ok: false, error: 'Неверный логин или пароль' });
    const token = randomUUID();
    authSessions.set(token, u.id);
    return json(res, 200, { ok: true, token, user: u });
  }

  if (url.pathname === '/api/me' && req.method === 'GET') {
    const u = await authUser(req);
    if (!u) return json(res, 401, { ok: false, error: 'требуется вход' });
    return json(res, 200, { ok: true, user: u });
  }

  if (url.pathname === '/api/logout' && req.method === 'POST') {
    const h = req.headers['authorization'] || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : req.headers['x-session'];
    if (token) authSessions.delete(token);
    return json(res, 200, { ok: true });
  }

  if (url.pathname === '/api/me/password' && req.method === 'POST') {
    const u = await authUser(req);
    if (!u) return json(res, 401, { ok: false, error: 'требуется вход' });
    const body = await readJson(req, res);
    if (!body) return;
    const r = await updatePassword(u.id, body.current, body.next);
    return json(res, r.ok ? 200 : 400, r);
  }

  // --- пользователи и права ----------------------------------------------
  if (url.pathname === '/api/users' && req.method === 'GET') {
    try { return json(res, 200, { ok: true, users: await listUsers() }); }
    catch (e) { return json(res, 500, { ok: false, error: String(e.message || e) }); }
  }

  if (url.pathname === '/api/users' && req.method === 'POST') {
    if (req.user.role !== 'admin') return json(res, 403, { ok: false, error: 'требуются права администратора' });
    const body = await readJson(req, res);
    if (!body) return;
    try { return json(res, 200, { ok: true, user: await saveUser(body) }); }
    catch (e) { return json(res, 400, { ok: false, error: String(e.message || e) }); }
  }

  if (url.pathname.startsWith('/api/users/') && req.method === 'PUT') {
    if (req.user.role !== 'admin') return json(res, 403, { ok: false, error: 'требуются права администратора' });
    const id = decodeURIComponent(url.pathname.slice('/api/users/'.length));
    const body = await readJson(req, res);
    if (!body) return;
    try {
      const u = await updateUser(id, body);
      if (!u) return json(res, 404, { ok: false, error: 'user not found' });
      return json(res, 200, { ok: true, user: u });
    } catch (e) { return json(res, 400, { ok: false, error: String(e.message || e) }); }
  }

  if (url.pathname.startsWith('/api/users/') && req.method === 'DELETE') {
    if (req.user.role !== 'admin') return json(res, 403, { ok: false, error: 'требуются права администратора' });
    const id = decodeURIComponent(url.pathname.slice('/api/users/'.length));
    try {
      const r = await deleteUser(id, req.user.id);
      return json(res, r.ok ? 200 : 400, r);
    } catch (e) { return json(res, 500, { ok: false, error: String(e.message || e) }); }
  }

  if (url.pathname === '/api/servers' && req.method === 'GET') {
    try { return json(res, 200, { servers: await listServers(false) }); }
    catch (e) { return json(res, 500, { ok: false, error: String(e.message || e) }); }
  }

  if (url.pathname === '/api/servers' && req.method === 'POST') {
    if (req.user.role !== "admin") return json(res, 403, { ok: false, error: "требуются права администратора" });
    const body = await readJson(req, res);
    if (!body) return;
    try {
      const saved = await saveServer(body);
      return json(res, 200, { ok: true, id: saved.id, name: saved.name });
    } catch (e) { return json(res, 400, { ok: false, error: String(e.message || e) }); }
  }

  if (url.pathname.startsWith('/api/servers/') && req.method === 'PUT') {
    if (req.user.role !== "admin") return json(res, 403, { ok: false, error: "требуются права администратора" });
    const id = decodeURIComponent(url.pathname.slice('/api/servers/'.length));
    const body = await readJson(req, res);
    if (!body) return;
    try {
      const updated = await updateServer(id, body);
      if (!updated) return json(res, 404, { ok: false, error: 'server not found' });
      return json(res, 200, { ok: true, server: updated });
    } catch (e) { return json(res, 500, { ok: false, error: String(e.message || e) }); }
  }

  if (url.pathname.startsWith('/api/servers/') && req.method === 'DELETE') {
    if (req.user.role !== "admin") return json(res, 403, { ok: false, error: "требуются права администратора" });
    const id = decodeURIComponent(url.pathname.slice('/api/servers/'.length));
    try {
      const ok = await deleteServer(id);
      return json(res, ok ? 200 : 404, { ok });
    } catch (e) { return json(res, 500, { ok: false, error: String(e.message || e) }); }
  }

  if (url.pathname === '/favicon.ico') return plain(res, '', 204);

  if (url.pathname.startsWith('/novnc/')) {
    const rel = url.pathname.slice('/novnc/'.length) || 'vnc.html';
    const fpath = path.normalize(path.join(ROOT, 'web', 'novnc', rel));
    if (!fpath.startsWith(path.join(ROOT, 'web', 'novnc'))) return plain(res, 'bad path', 403);
    // shell приложения не кэшируем — обновления должны применять сразу
    const noStore = rel === 'vnc.html' || !/\.[a-z0-9]+$/i.test(rel);
    try {
      const data = await readFile(fpath);
      res.writeHead(200, { 'content-type': mimeFor(fpath), ...(noStore ? { 'cache-control': 'no-store' } : {}) });
      return res.end(data);
    } catch {
      // Directory/extension-less routes -> vnc.html; otherwise 404 (never return
      // HTML for a .js/.css request, that breaks ES modules).
      if (!/\.[a-z0-9]+$/i.test(rel)) {
        try {
          const html = await readFile(path.join(ROOT, 'web', 'novnc', 'vnc.html'));
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          return res.end(html);
        } catch { /* fallthrough */ }
      }
      return plain(res, 'no novnc asset', 404);
    }
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    try {
      const html = await readFile(path.join(ROOT, 'web', 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(html);
    } catch {
      return plain(res, 'no web/index.html');
    }
  }

  // Статические модули фронтенда (разрез монолита index.html) — /css/* и /js/*.
  // Не кэшируем: обновления должны применять сразу.
  if (/^\/(css|js|img)\//.test(url.pathname)) {
    const rel = url.pathname.slice(1);
    const fpath = path.normalize(path.join(ROOT, 'web', rel));
    if (!fpath.startsWith(path.join(ROOT, 'web'))) return plain(res, 'bad path', 403);
    try {
      const data = await readFile(fpath);
      res.writeHead(200, { 'content-type': mimeFor(fpath), 'cache-control': 'no-store' });
      return res.end(data);
    } catch {
      return plain(res, 'no asset', 404);
    }
  }

  plain(res, 'not found', 404);
});

function readJson(req, res) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { resolve(null); json(res, 400, { ok: false, error: 'bad json' }); }
    });
    req.on('error', () => resolve(null));
  });
}
function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function plain(res, text, code = 200) {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};
function mimeFor(fpath) {
  const ext = path.extname(fpath).toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

function waitLive(sess, ms) {
  return new Promise((resolve) => {
    if (sess.state !== 'starting') return resolve(sess.state);
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (sess.state !== 'starting' || Date.now() - t0 > ms) { clearInterval(iv); resolve(sess.state); }
    }, 100);
  });
}

// WebSocket upgrade for the RFB/VNC console stream.
// noVNC requires the 'binary' subprotocol to allow Security None.
const wss = new WebSocketServer({
  noServer: true,
  handleProtocols: (set) => (set && set.has('binary') ? 'binary' : (set && set.size ? [...set][0] : undefined)),
});
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/vnc') {
    const token = url.searchParams.get('token');
    const sess = token && sessions.get(token);
    if (!sess) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }
    if (!sess.cli) { socket.write('HTTP/1.1 409 Conflict\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (ws.protocol) { /* keep negotiated subprotocol */ }
      sess.clients.add(ws);
      // Клиенты могут приходить и уходить в любом количестве — сессия iRMC
      // живёт независимо от браузерных подключений (рвётся только вручную).
      ws.on('close', () => { sess.clients.delete(ws); });
      attachVnc(ws, sess);
    });
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`iRMC Viewer bridge running at http://localhost:${PORT}`);
  console.log('Left panel: servers. Right: details + Launch console (noVNC).');
  console.log('GET /api/servers lists stored servers (credentials encrypted at rest).');
});

// === Сбор IPMI (p.5): интервальный опрос по LAN -> SQLite (data/db/) ==
// RMCP+/UDP (623/664), отдельный канал — НЕ трогает AVR/TCP-консоль, поэтому
// не блокирует и не ломает KVM-сессии вьювера.
// Три канала доступности (независимы, могут отваливаться по одному):
//   ping — ICMP-эхо; web — TCP-коннект к web-порту iRMC (БЕЗ HTTP-запроса
//   и входа — не занимаем веб-сессию BMC); ipmi — факт опроса RMCP+.
// Один опрос = одна транзакция (server/db.js recordPoll): справочники,
// состояние, история изменений, SEL-дедуп (UNIQUE в БД — переживает
// рестарты), журнал опросов. Упавший опрос не затирает прошлое состояние
// сервера — в БД видно, что успело собраться до отказа.
let sensorBusy = false;
async function pollSensors() {
  if (sensorBusy) return;
  sensorBusy = true;
  try {
    const list = await listServers(false);
    await Promise.all(list.filter((s) => s.host).map(async (s) => {
      const t0 = Date.now();
      // ping/web параллельно с IPMI: каждый канал фиксируется сам по себе
      const channelsPromise = checkChannels({ host: s.host, port: s.port, secure: s.secure })
        .catch(() => null);
      try {
        const cfg = await getServer(s.id);
        if (!cfg || !cfg.username) return;
        const r = await ipmi.readAll(cfg);
        const ch = await channelsPromise;
        db.recordPoll(s.id, r, Date.now() - t0, Date.now(), ch);
      } catch (e) {
        const ch = await channelsPromise;
        db.recordPollFailure(s.id, Date.now() - t0, String((e && e.message) || e), Date.now(), ch);
      }
    }));
  } finally { sensorBusy = false; }
}
setInterval(pollSensors, 60000);
pollSensors();
// Ретеншн истории (п.5.5): чистка > 30 дней каждые 6 часов
setInterval(() => { try { db.prune(30); } catch {} }, 6 * 3600 * 1000);


// Graceful shutdown (слой A): при остановке закрываем все консольные
// сессии к iRMC (ClientDisconnect 0xd8), чтобы не оставлять висящие сессии.
let shuttingDown = false;
function shutdownAllSessions() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const sess of [...sessions.values()]) {
    try { closeSession(sess); } catch { }
  }
  try { wss.close(); } catch { }
}
process.on('SIGINT', () => { shutdownAllSessions(); process.exit(0); });
process.on('SIGTERM', () => { shutdownAllSessions(); process.exit(0); });
process.on('beforeExit', shutdownAllSessions);
