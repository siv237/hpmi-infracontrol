// Простой независимый опросчик сенсоров по IPMI-over-LAN (RMCP+/UDP 623/664).
// НЕ трогает AVR/TCP-консоль (KVM-сессии) — только IPMI-LAN, поэтому не
// ломает и не держит сессии вьювера. Читает SDR: температуры и кулеры,
// обходясь без внешних зависимостей от KVM-стека (используем ipmitool lanplus).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

function parseSensors(out) {
  const temps = [], fans = [];
  for (const line of out.split('\n')) {
    const name = (line.split('|')[0] || '').trim();
    if (!name || /Get HPM|request failed|unable/i.test(line)) continue;
    // ищем последнее число + юнит в строке (значение сенсора)
    const m = line.match(/([\d.]+)\s*(degrees C)\b/) || (/([\d.]+)\s*(RPM)\b/.exec(line));
    const stat = (line.match(/\|\s*(ok|ns|nr|cr|uc|lnc|lcr|unr|ucr)\s*\|/) || [null, 'n/a'])[1] || 'n/a';
    if (!m) { if (/No Reading/i.test(line)) continue; continue; }
    const value = parseFloat(m[1]);
    if (m[2] === 'degrees C') temps.push({ name, sensor: line.split('|')[1]?.trim() || '', status: stat, value });
    else if (m[2] === 'RPM') fans.push({ name, sensor: line.split('|')[1]?.trim() || '', status: stat, value });
  }
  return { temps, fans };
}

// opts: { host, username, password, port?=80, secure?=false }
export async function readSensors(opts) {
  const { host, username, password } = opts;
  const base = ['-I', 'lanplus', '-H', host, '-U', username];
  const argsT = [...base, '-P', password || '', 'sdr', 'type', 'Temperature'];
  const argsF = [...base, '-P', password || '', 'sdr', 'type', 'Fan'];
  const env = { ...process.env, IPMITOOL_PASS: password || '' };
  // пароль остаётся только в аргументе/окружении процесса ipmitool, не логи
  const [t, f] = await Promise.all([
    exec('ipmitool', argsT, { env, timeout: 20000, maxBuffer: 64 * 1024 }).then((r) => r.stdout, () => ''),
    exec('ipmitool', argsF, { env, timeout: 20000, maxBuffer: 64 * 1024 }).then((r) => r.stdout, () => ''),
  ]);
  return { host: opts.host, temps: parseSensors(t).temps, fans: parseSensors(f).fans };
}
