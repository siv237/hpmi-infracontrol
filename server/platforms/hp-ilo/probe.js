// Пробы HPE iLO 4/5. ТОЛЬКО GET, минимум запросов. Матч-функции чистые —
// гоняются в тестах на фикстурах реальных страниц (живой iLO 4 fw 2.80).
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

// Чистый матч по HTML веб-оболочки iLO (страница «/» отдаётся без логина).
// Маркеры живого iLO 4 (fw 2.80): EOV-GUI, RpPageHeader, HPE; у iLO 5 — те же
// + EOIO-GUI. FQDN/BMC-имя не матчу (не стабильно).
export function matchIloWeb(status, body) {
  if (status !== 200) return false;
  const b = body || '';
  return /EOV-GUI|EOIO-GUI|RpPageHeader/i.test(b)
    || (/<title>[^<]*iLO[^<]*<\/title>/i.test(b) && /Hewlett Packard Enterprise|hp\.com/i.test(b));
}

// Чистый матч по Redfish корню (iLO отвечает 200 БЕЗ логина): Oem.Hp —
// надёжный признак именно HPE iLO.
export function matchIloRedfish(status, body) {
  if (status !== 200) return false;
  return /"Oem"\s*:\s*\{\s*"Hp"/i.test(body || '') || /"HpRestfulRootService"|"HP RESTful Root Service"|"Hpe"|"HpeRestfulRootService"/i.test(body || '');
}

// Проба: 1 GET на «/» (с прыжком 303→https). Если не сматчился — запасной
// GET /redfish/v1/ (без Digest). Сеть жива, но не iLO — вернём null сразу.
export async function probe(cfg, sdk, { tries = 2, pauseMs = 2200 } = {}) {
  const { host, port = 443, secure = true } = cfg || {};
  if (!host) return null;
  for (let i = 0; i < tries; i++) {
    const root = await plainGet(secure, host, port, '/');
    if (root) {
      if (matchIloWeb(root.status, root.body)) {
        return { matched: true, confidence: 0.9, info: { title: 'iLO web shell', web: `https://${host}:${port}` } };
      }
      const rf = await plainGet(true, host, port, '/redfish/v1/');
      if (rf && matchIloRedfish(rf.status, rf.body)) {
        return { matched: true, confidence: 0.8, info: { title: 'iLO Redfish', web: `https://${host}:${port}` } };
      }
      return null; // сеть жива, но не iLO — дальше не долбим
    }
    await sleep(pauseMs);
  }
  if (sdk?.log) sdk.log(`[platforms] hp-ilo probe: ${host} недоступен`);
  return null;
}
