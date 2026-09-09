// Трёхканальная проверка доступности (фаза 2.1). Владелец: «у него вебка
// висит — проверять надо по трём фазам: ping, вебка и IPMI, и все три
// могут независимо отвалиться». Проверка ПОРТАМИ/эхо — БЕЗ входа и без
// HTTP-запросов, чтобы не вешать веб-сессии iRMC (Digest-логин извне
// и так виснет — см. wiki; поэтому сюда вообще не лезем).
//
//   ping  — ICMP-эхо (команда ping, 1 пакет, таймаут 3с)
//   web   — TCP-коннект к web-порту iRMC (80/443 из конфига сервера),
//           коннект открыт — сразу закрываем, никакого GET/запроса
//   ipmi  — RMCP+ UDP 623: о факте говорит сам IPMI-опрос (readAll),
//           отдельного «постучать» не делаем — сессия RMCP+ может
//           конфликтовать; канал = результат опроса
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

// ICMP-эхо. Возвращает {ok, ms} — независимо от ОС (ping -c1/-n1).
export async function ping(host, timeoutMs = 3000) {
  const isWin = process.platform === 'win32';
  const cmd = isWin ? 'ping' : 'ping';
  const args = isWin ? ['-n', '1', '-w', String(timeoutMs), host] : ['-c', '1', '-W', Math.ceil(timeoutMs / 1000), host];
  const t0 = Date.now();
  try {
    await exec(cmd, args, { timeout: timeoutMs + 1000 });
    return { ok: true, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: String((e && e.stderr) || (e && e.message) || e).slice(0, 80) };
  }
}

// TCP-коннект к порту (вебка iRMC). Открылся — сразу destroy: НИКАКОГО
// HTTP-запроса, никаких Digest/логинов — не занимаем веб-сессию BMC.
export function tcpPort(host, port, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const done = (o) => { try { s.destroy(); } catch {} resolve(o); };
    const s = net.connect({ host, port }, () => done({ ok: true, ms: Date.now() - t0 }));
    s.on('error', (e) => done({ ok: false, ms: Date.now() - t0, error: String((e && e.message) || e) }));
    s.setTimeout(timeoutMs, () => done({ ok: false, ms: Date.now() - t0, error: 'timeout' }));
  });
}

// Три канала разом. web port — из конфига сервера (secure ? 443 : 80,
// поле port), ipmi — фактический результат IPMI-опроса (передаётся
// вызывающим: true/false), сам здесь не стучимся.
export async function checkChannels({ host, port, secure, ipmiUp = null, pingTimeout = 3000, webTimeout = 4000 }) {
  const webPort = Number(port || (secure ? 443 : 80));
  const [p, w] = await Promise.all([
    ping(host, pingTimeout),
    tcpPort(host, webPort, webTimeout),
  ]);
  return {
    ping: p,
    web: w,
    ipmi: ipmiUp === null ? null : { ok: ipmiUp },
  };
}
