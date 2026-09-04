// Web-based iRMC AVR viewer bridge.
// Stage 1: simple page that takes host/username/password (plus optional port,
// secure/httpdata) and performs a connection + protocol handshake test against
// a Fujitsu iRMC, reporting what the server replies.
// Saved servers (with encrypted credentials) let you test without re-typing.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { IrmcClient, testIrmc } from './irmc.js';
import { listServers, saveServer, deleteServer, getServer, updateServer } from './store.js';
import { discover, getSession, inventory, parseInventory } from './discover.js';
import { probe } from './probe.js';
import { attachVnc } from './vnc.js';
import { encodePng, saveScreenshot } from './png.js';

const PORT = Number(process.env.PORT || 1845);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// Live console sessions: token -> { cli, listeners, name, host, state }
const sessions = new Map();
const sessionsByHost = new Map(); // host -> token (one active console per host)

function createSession(name, host) {
  const token = randomUUID();
  const sess = {
    token, name, host,
    listeners: new Set(),
    cli: null, state: 'starting', width: 0, height: 0, status: [], error: null, startedAt: Date.now(),
    clients: new Set(),
    lastFrameAt: Date.now(),
    fb(rects) { const c = sess.cli; return c ? { width: c.fb.width, height: c.fb.height, pix: rects ? c.fb.getRGBFor(rects) : c.fb.getRGB() } : { width: 0, height: 0, pix: new Uint32Array(0) }; },
    key: (k, d) => sess.cli && sess.cli.key(k, d),
    mouseMove: (x, y) => sess.cli && sess.cli.mouseMove(x, y),
    buttonState: (x, y, m) => sess.cli && sess.cli.buttonState(x, y, m),
    subscribe(cb) { sess.listeners.add(cb); },
    unsubscribe(cb) { sess.listeners.delete(cb); },
  };
  sessions.set(token, sess);
  sessionsByHost.set(host, token);
  return sess;
}

function closeSession(tokenOrSess) {
  const sess = typeof tokenOrSess === 'string' ? sessions.get(tokenOrSess) : tokenOrSess;
  if (!sess) return;
  if (sess._refresh) clearInterval(sess._refresh);
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
  const cfg = await cachedSession({ host, username: user, password: pass, port, secure });
  const cli = new IrmcClient(cfg, {
    onStatus: (s) => {
      sess.status.push(s);
      if (s.startsWith('vesa:')) {
        sess.state = 'live';
        const m = /^vesa:(\d+)x(\d+)@(\d+)/.exec(s);
        if (m) { sess.width = +m[1]; sess.height = +m[2]; }
      }
    },
    onError: (e) => { sess.error = e; sess.state = 'error'; sess.notifyFrame && null; },
    onExit: () => { sess.state = 'closed'; },
    onFrame: (fb, rects) => {
      sess.width = fb.width; sess.height = fb.height;
      sess.lastFrameAt = Date.now();
      for (const cb of sess.listeners) cb(fb, rects);
    },
  });
  sess.cli = cli;
  await cli.start();
  // Static/black screens produce no change-frames, so the framebuffer stays
  // blank even though the device shows content. Periodically Invalidate to make
  // the device resend the full current screen — but only while idle. When
  // frames are flowing (e.g. while typing) a forced invalidate would flood the
  // pipe with a redundant full-screen resend and could stall input latency.
  sess._refresh = setInterval(() => {
    try {
      if (!sess.cli) return;
      if (Date.now() - sess.lastFrameAt < 2000) return; // still active, skip
      sess.lastFrameAt = Date.now();
      sess.cli.invalidateFull();
    } catch {}
  }, 3000);
  return sess;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // --- API ---------------------------------------------------------------
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
    // into 503). Only start a fresh one when nothing is active. A 'starting'
    // session that has been stuck (no video mode) for a while is stale — the
    // iRMC still holds the console, so release it (sends 0xd8) and re-open.
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
        closeSession(existing);
      } else {
        closeSession(existing); // closed/error -> release
      }
    }
    const sess = createSession(stored.name || stored.host, stored.host);
    try {
      await startSession(sess, stored.host, stored.username, stored.password || '', stored.port, stored.secure);
      await waitLive(sess, 10000);
      return json(res, 200, { ok: true, token: sess.token, name: sess.name, host: sess.host, width: sess.width, height: sess.height, state: sess.state });
    } catch (e) {
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

  if (url.pathname === '/api/info' && req.method === 'POST') {
    const body = await readJson(req, res);
    if (!body) return;
    let cfg;
    try { cfg = body.serverId ? await getServer(body.serverId) : body; } catch { return json(res, 400, { ok: false, error: 'local read failed' }); }
    if (!cfg) return json(res, 400, { ok: false, error: 'server not found' });
    // Prefer authenticated inventory (model/serial/BIOS/OS), fall back to probe.
    try {
      const inv = await inventory(cfg);
      return json(res, 200, { ok: true, inventory: inv.inventory, ...inv });
    } catch {
      try {
        const p = await probe(cfg);
        return json(res, 200, p);
      } catch (e) { return json(res, 200, { ok: false, error: String(e.message || e) }); }
    }
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

  if (url.pathname === '/api/servers' && req.method === 'GET') {
    try { return json(res, 200, { servers: await listServers(false) }); }
    catch (e) { return json(res, 500, { ok: false, error: String(e.message || e) }); }
  }

  if (url.pathname === '/api/servers' && req.method === 'POST') {
    const body = await readJson(req, res);
    if (!body) return;
    try {
      const saved = await saveServer(body);
      return json(res, 200, { ok: true, id: saved.id, name: saved.name });
    } catch (e) { return json(res, 400, { ok: false, error: String(e.message || e) }); }
  }

  if (url.pathname.startsWith('/api/servers/') && req.method === 'PUT') {
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
    const id = decodeURIComponent(url.pathname.slice('/api/servers/'.length));
    try {
      const ok = await deleteServer(id);
      return json(res, ok ? 200 : 404, { ok });
    } catch (e) { return json(res, 500, { ok: false, error: String(e.message || e) }); }
  }

  if (url.pathname.startsWith('/novnc/')) {
    const rel = url.pathname.slice('/novnc/'.length) || 'vnc.html';
    const fpath = path.normalize(path.join(ROOT, 'web', 'novnc', rel));
    if (!fpath.startsWith(path.join(ROOT, 'web', 'novnc'))) return plain(res, 'bad path', 403);
    try {
      const data = await readFile(fpath);
      res.writeHead(200, { 'content-type': mimeFor(fpath) });
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
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    } catch {
      return plain(res, 'no web/index.html');
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
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
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
      ws.on('close', () => {
        sess.clients.delete(ws);
        if (sess.clients.size === 0) {
          // No one is watching -> release the console (single-session device).
          clearTimeout(sess._ttl);
          sess._ttl = setTimeout(() => closeSession(sess), 30000);
        } else clearTimeout(sess._ttl);
      });
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
