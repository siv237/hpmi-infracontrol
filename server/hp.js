// Модуль HP Lights-Out 100 / LO100i (ProLiant G5/G6) — KVM-консоль.
//
// LO100i — это «интегрированный» вариант AVR-протокола (Mahogany): тот же
// стек, что у Fujitsu iRMC S2 (см. server/irmc.js), но:
//   - рукопожатие клиента: сигнатура 0x5A5A5A5A (embedded/httpdata), паддинги
//     полей 16/20/128 (вместо 48/48/228 у iRMC);
//   - httpdata — это НЕ пароль, а одноразовый токен из свежего kvms.html
//     (поле httpdata апплета MahoganyViewer), который идёт в passwordFull;
//   - KVM-порт — plain TCP, обычно тот же веб-порт 80 (NonSecure_KVMPort);
//   - сам апплет грузится из /M2.JAR (на BMC, без авторизации), в jar есть
//     LIBM2-*.SO — движок проброса ISO (как у iRMC).
//
// Свежий токен ОБЯЗАТЕЛЕН: устаревший httpdata заставляет BMC сбросить
// видео-поток после рукопожатия (тот же quirk, что и у iRMC S2).
//
// Реестр возможностей: server/bmc-registry.js (id 'hp-lo100'),
// знания — wiki/knowledge/hp-lo100-kvm.md.

import { IrmcClient } from './irmc.js';
import { digestGet } from './discover.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Получение свежих параметров апплета KVM с kvms.html (с ретраями — BMC рвёт
// подряд идущие HTTP-соединения ECONNRESET, нужна пауза ≥2 c).
// Возвращает { httpdata, ipaddress, port, kvmPort } или бросает Error.
export async function fetchKvmApplet(cfg, { tries = 6, pauseMs = 2500 } = {}) {
  const { host, port = 80, secure = false, username, password } = cfg;
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const pg = await digestGet(secure, host, port, '/kvms.html', username, password);
      if (pg.status !== 200) { lastErr = new Error('kvms.html status ' + pg.status); continue; }
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
      lastErr = e;
    }
    await sleep(pauseMs);
  }
  throw lastErr || new Error('не удалось получить апплет KVM (kvms.html)');
}

// Высокоуровневый запуск KVM-сессии HP через AVR-клиент (irmc.js) с нашими
// особенностями: паддинги 16/20/128, сигнатура embedded, httpdata-токен.
// Возвращает НЕ запущенный IrmcClient — запуск делает вызывающий
// (index.js: await cli.start()), чтобы AVR-старт был единым для всех движков.
export async function openHpConsole(cfg, events = {}) {
  const app = await fetchKvmApplet(cfg);
  return new IrmcClient({
    host: cfg.host,
    port: app.kvmPort,
    secure: app.secure,
    username: cfg.username,
    password: cfg.password || '',
    httpdata: app.httpdata, // токен из свежего kvms.html
    pad: { user: 16, pass: 20, full: 128 }, // HP LO100i
  }, events);
}

null