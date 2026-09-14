// Логин HP LO100i: Digest-вход + свежий httpdata-токен из kvms.html.
// LO100 рвёт подряд идущие HTTP-соединения (ECONNRESET) — ретраи с паузой.
// Возвращает sessionCfg для createConsole (host/kvmPort/httpdata/kvmSecure/креды).
import { digestGet } from '../../discover.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Свежие параметры апплета KVM из kvms.html (Digest). Свежий токен ОБЯЗАТЕЛЕН:
// устаревший httpdata заставляет BMC сбросить видео-поток после рукопожатия
// (тот же quirk, что у iRMC S2). Возвращает { httpdata, ipaddress, kvmPort, secure }.
// Бросает Error с понятным текстом, если это свежий HPE iLO (там нет LO100 KVM).
export async function fetchKvmApplet(cfg, { tries = 6, pauseMs = 2500 } = {}) {
  const { host, port = 80, secure = false, username, password } = cfg;
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const pg = await digestGet(secure, host, port, '/kvms.html', username, password);
      if (pg.status !== 200) {
        const m404 = pg.status === 404;
        lastErr = new Error(m404
          ? 'HP: /kvms.html не найден (404) — на этом BMC нет KVM Lights-Out 100. Похоже, это свежий HPE iLO: там другой протокол консоли (IRC), наш мост его не поддерживает'
          : 'kvms.html status ' + pg.status);
        if (m404) throw lastErr; // ретраи бессмысленны — 404 не «исчезает»
        continue;
      }
      const body = pg.body || '';
      const get = (name) => {
        const re = new RegExp(`NAME="${name}"\\s+VALUE="([^"]*)"`, 'i');
        const m = re.exec(body);
        return m ? m[1] : null;
      };
      const httpdata = get('httpdata');
      if (!httpdata) { lastErr = new Error('в kvms.html нет httpdata (нет прав на KVM?)'); continue; }
      const kvmPort = Number(get('NonSecure_KVMPort') || 0) || port;
      return {
        httpdata,
        ipaddress: get('ipaddress') || host,
        kvmPort,
        secure: /kvmssl/i.test(get('sessiontype') || ''),
      };
    } catch (e) {
      const msg = String((e && e.message) || e);
      // digestGet кидает «auth required (404)» на несуществующих путях —
      // для iLO это норма (kvms.html есть только у LO100). Фейлим сразу.
      if (/auth required \(404\)|kvms\.html status 404/.test(msg)) {
        throw new Error('HP: /kvms.html не найден (404) — на этом BMC нет KVM Lights-Out 100. Похоже, это свежий HPE iLO: там другой протокол консоли (IRC), наш мост его не поддерживает');
      }
      lastErr = e;
    }
    await sleep(pauseMs);
  }
  throw lastErr || new Error('не удалось получить апплет KVM (kvms.html)');
}

// sessionCfg: host — TCP-адрес BMC для KVM-сокета (обязателен движку).
export default async function login(cfg, sdk) {
  const app = await fetchKvmApplet(cfg);
  sdk?.log?.(`[hp-lo100] сессия: kvmPort=${app.kvmPort} httpdata=${String(app.httpdata || '').slice(0, 6)}…`);
  return {
    host: cfg.host,
    kvmPort: app.kvmPort,
    httpdata: app.httpdata,
    kvmSecure: app.secure,
    username: cfg.username,
    password: cfg.password,
  };
}
