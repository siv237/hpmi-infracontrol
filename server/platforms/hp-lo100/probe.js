// Пробы HP Lights-Out 100 / LO100i. ТОЛЬКО GET, минимум запросов к BMC —
// LO100 рвёт подряд идущие HTTP-соединения (ECONNRESET). Матч-функции —
// чистые (без сети), чтобы гонять в тестах на фикстурах реальных страниц.
import http from 'node:http';
import https from 'node:https';
import { permissiveTlsOptions } from '../../sdk/net.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Мини-GET без авторизации (для проб): следует одному редиректу http→https,
// TLS расслаблен (legacy BMC). Локально в модуле — ядро не трогаем.
function plainGet(secure, host, port, path, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const done = (r) => resolve(r);
    const req = (secure ? https : http).get(
      {
        host, port, path, timeout: timeoutMs,
        rejectUnauthorized: false,
        secureOptions: secure ? permissiveTlsOptions().secureOptions : undefined,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && !secure) {
          res.resume();
          try {
            resolve(plainGet(true, host, port, new URL(res.headers.location, `http://${host}:${port}`).pathname, timeoutMs));
          } catch { done(null); }
          return;
        }
        const chunks = [];
        let n = 0;
        res.on('data', (c) => { if (n < 65536) { chunks.push(c); n += c.length; } });
        res.on('end', () => done({ status: res.statusCode, body: Buffer.concat(chunks).toString('latin1') }));
        res.on('error', () => done(null));
      }
    );
    req.on('timeout', () => { req.destroy(); done(null); });
    req.on('error', () => done(null));
  });
}

// Чистый матч по HTML «/» LO100 (title = BMC HTTP Server, меню апплета).
export function matchLo100Root(status, body) {
  if (status !== 200) return false;
  const title = /<title>([^<]*)<\/title>/i.exec(body || '');
  if (title && /^BMC HTTP Server$/i.test(title[1].trim())) return true;
  return /Lights-Out\s*100|MahoganyViewer|Avocent/i.test(body || '');
}

// Матч по kvms.html (APPLET MahoganyViewer + httpdata) — высшая уверенность.
export function matchLo100Kvms(status, body) {
  if (status !== 200) return false;
  return /MahoganyViewer/i.test(body || '') && /NAME="httpdata"/i.test(body || '');
}

// Проба платформы: 1 GET на «/» (+ запасной 1 GET на kvms.html без Digest —
// 401 тоже признак LO100: путь существует, просто закрыт Digest-ом).
export async function probe(cfg, sdk, { tries = 2, pauseMs = 2200 } = {}) {
  const { host, port = 80, secure = false } = cfg || {};
  if (!host) return null;
  let lastNet = false;
  for (let i = 0; i < tries; i++) {
    const pg = await plainGet(secure, host, port, '/');
    if (pg) {
      if (matchLo100Root(pg.status, pg.body)) {
        return { matched: true, confidence: 0.9, info: { title: 'BMC HTTP Server', web: `${secure ? 'https' : 'http'}://${host}:${port}` } };
      }
      // «/» не сматчился — kvms.html без Digest: 401/200 с апплетом = LO100.
      const kv = await plainGet(secure, host, port, '/kvms.html');
      if (kv && (matchLo100Kvms(kv.status, kv.body) || kv.status === 401)) {
        return { matched: true, confidence: 0.7, info: { title: 'kvms.html applet', web: `${secure ? 'https' : 'http'}://${host}:${port}` } };
      }
      return null; // сеть жива, но это не LO100 — дальше не долбим
    }
    lastNet = true;
    await sleep(pauseMs);
  }
  if (lastNet && sdk?.log) sdk.log(`[platforms] hp-lo100 probe: ${host} недоступен`);
  return null;
}
