// Методы проб платформы ami-soc (S4). Креды не нужны: смотрим сигнатуру
// веб-сервера BMC. Fast, strictly time-bounded.
import http from 'node:http';
import https from 'node:https';

function webServerHeader(cfg, timeoutMs = 4000) {
  const { host, port = 80, secure = false } = cfg;
  const mod = secure ? https : http;
  return new Promise((resolve) => {
    const done = (o) => { try { req.destroy(); } catch {} resolve(o); };
    const req = mod.get(
      { host, port, path: '/', rejectUnauthorized: false, headers: { 'User-Agent': 'Mozilla/5.0' } },
      (res) => { const s = String(res.headers.server || ''); res.resume(); done({ server: s, status: res.statusCode }); },
    );
    req.on('error', () => done({ error: true }));
    req.setTimeout(timeoutMs, () => done({ error: 'timeout' }));
  });
}

export default {
  // Подпись веб-сервера iRMC S4: "FUJITSU ServerView iRMC S4 Webserver".
  async 'web-signature'(cfg, sdk) {
    const r = await webServerHeader(cfg);
    if (r.server) return { matched: /iRMC\s*S4/i.test(r.server), confidence: 0.9, info: { server: r.server } };
    return { matched: false, confidence: 0 };
  },
};
