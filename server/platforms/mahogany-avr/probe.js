// Методы проб платформы mahogany-avr (S2/S3). Креды не нужны.
// S2: GET / -> 401 + WWW-Authenticate Digest realm="iRMC S2@..." и
//     <title>ServerView Remote Management iRMC S2 Web Server…</title>.
// S4 веб отдаёт Server: FUJITSU ServerView iRMC S4 Webserver — не наш.
import http from 'node:http';
import https from 'node:https';

function fetchRoot(cfg, timeoutMs = 4000) {
  const { host, port = 80, secure = false } = cfg;
  const mod = secure ? https : http;
  return new Promise((resolve) => {
    const done = (o) => { try { req.destroy(); } catch {} resolve(o); };
    const req = mod.get(
      { host, port, path: '/', rejectUnauthorized: false, headers: { 'User-Agent': 'Mozilla/5.0' } },
      (res) => {
        let body = '';
        res.setEncoding('latin1');
        res.on('data', (c) => { body += c; if (body.length > 20000) res.destroy(); });
        res.on('end', () => {
          const title = (/<title[^>]*>([^<]*)/i.exec(body) || [])[1] || '';
          done({ status: res.statusCode, server: res.headers.server || '', www: res.headers['www-authenticate'] || '', title });
        });
        res.on('error', () => done({ title: '', www: '', server: '' }));
      },
    );
    req.on('error', () => done({ error: true }));
    req.setTimeout(timeoutMs, () => done({ error: 'timeout' }));
  });
}

export default {
  async 'web-signature'(cfg, sdk) {
    const r = await fetchRoot(cfg);
    const hay = `${r.server || ''}\n${r.www || ''}\n${r.title || ''}`;
    const isS4 = /iRMC\s*S4/i.test(hay);
    const isS2orS3 = /iRMC\s*S[23]/i.test(hay);
    const matched = isS2orS3 || (/iRMC/i.test(hay) && !isS4);
    return {
      matched,
      confidence: isS2orS3 ? 0.9 : (matched ? 0.6 : 0),
      info: { realm: r.www, title: r.title, server: r.server },
    };
  },
};
