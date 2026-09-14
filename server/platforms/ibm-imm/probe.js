// Проба IBM IMM: сигнатура веб-оболочки на HTTPS:443. Матч-функция чистая
// (без сети) — гоняется в тестах на фикстуре живой страницы IMM.
import http from 'node:http';
import https from 'node:https';
import { permissiveTlsOptions } from '../../sdk/net.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Локальный GET без авторизации (ядро не трогаем). Идём на HTTPS с
// расслабленным TLS (legacy BMC).
function plainGet(secure, host, port, path, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const req = (secure ? https : http).get({
      host, port, path, timeout: timeoutMs,
      rejectUnauthorized: false,
      secureOptions: secure ? permissiveTlsOptions().secureOptions : undefined,
    }, (res) => {
      const chunks = []; let n = 0;
      res.on('data', (c) => { if (n < 65536) { chunks.push(c); n += c.length; } });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('latin1') }));
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

// Чистый матч по HTML «/» IBM IMM: страница грузит Dojo-UI из /designs/imm/,
// содержит «Integrated Management Module». Redfish у IMM нет (404), VNC — нет.
export function matchImm(status, body) {
  if (status !== 200) return false;
  const b = body || '';
  return /Integrated Management Module/i.test(b)
    || /\/designs\/imm\//i.test(b)
    || /title-imm\.png|ibmdojo|imm\/layer-login/i.test(b);
}

export async function probe(cfg, sdk, { tries = 2, pauseMs = 2000 } = {}) {
  const { host, port = 443, secure = true } = cfg || {};
  if (!host) return null;
  for (let i = 0; i < tries; i++) {
    const r = await plainGet(secure, host, port, '/');
    if (r) {
      if (matchImm(r.status, r.body)) {
        return { matched: true, confidence: 0.85, info: { title: 'IBM IMM web', web: `https://${host}:${port}` } };
      }
      return null; // сеть жива, но не IMM — дальше не долбим
    }
    await sleep(pauseMs);
  }
  if (sdk?.log) sdk.log(`[platforms] ibm-imm probe: ${host} недоступен`);
  return null;
}
