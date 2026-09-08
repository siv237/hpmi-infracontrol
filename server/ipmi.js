// Опрос iRMC по IPMI-over-LAN (RMCP+/UDP 623/664) через `ipmitool lanplus`.
// НЕ трогает AVR/TCP-консоль (KVM-сессии) — только IPMI-LAN, поэтому не
// ломает и не держит сессии вьювера. Собирает: SDR (темп./кулеры), SEL
// (журнал событий), chassis/power (питание и здоровье), FRU (инвентарь).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

// Парсинг сенсоров из `sdr type Temperature|Fan`. Строки вида:
//   CPU1 | 01 | ok | 38.0 degrees C
//   FAN1 SYS | 08 | ok | 4020 RPM
function parseSensors(out) {
  const temps = [], fans = [];
  for (const line of out.split('\n')) {
    const name = (line.split('|')[0] || '').trim();
    if (!name || /Get HPM|request failed|unable|No Sensor/i.test(line)) continue;
    const m = line.match(/([\d.]+)\s*(degrees C)\b/) || (/([\d.]+)\s*(RPM)\b/.exec(line));
    const stat = (line.match(/\|\s*(ok|ns|nr|cr|uc|lnc|lcr|unr|ucr)\s*\|/) || [null, 'n/a'])[1] || 'n/a';
    if (!m) continue;
    const value = parseFloat(m[1]);
    if (m[2] === 'degrees C') temps.push({ name, sensor: line.split('|')[1]?.trim() || '', status: stat, value });
    else if (m[2] === 'RPM') fans.push({ name, sensor: line.split('|')[1]?.trim() || '', status: stat, value });
  }
  return { temps, fans };
}

// Парсинг System Event Log из `sel elist`. Строки вида:
//   1 | 09/08/2026 | 15:05:12 | Temperature #0x01 | Upper Non-critical going high | 42 degrees C
// Последние поля (уровень/направление/значение) опциональны.
function parseSEL(out) {
  const events = [];
  for (const line of out.split('\n')) {
    if (!line.trim() || /^SEL|^Log|No more entries|request failed|unable/i.test(line)) continue;
    const parts = line.split('|').map((s) => (s || '').trim());
    if (parts.length < 4 || !parts[0]) continue;
    const id = parts[0];
    const ts = parts[1] && parts[2] ? `${parts[1]} ${parts[2]}` : parts[1] || '';
    const sensor = parts[3] || '';
    const detail = parts.slice(4).filter(Boolean).join(' · ');
    const ev = { id, ts, sensor, detail };
    // Категория по слову в сенсоре/деталях
    const s = `${sensor} ${detail}`.toLowerCase();
    if (s.includes('temperature') || s.includes('degrees c')) ev.category = 'temp';
    else if (s.includes('fan')) ev.category = 'fan';
    else if (s.includes('power')) ev.category = 'power';
    else if (s.includes('voltage')) ev.category = 'voltage';
    else if (s.includes('processor') || s.includes('cpu')) ev.category = 'cpu';
    else if (s.includes('memory') || s.includes('dimm')) ev.category = 'memory';
    else if (s.includes('watchdog')) ev.category = 'watchdog';
    else if (s.includes('critical') || s.includes('non-recoverable')) ev.category = ev.category || 'critical';
    else ev.category = ev.category || 'other';
    // Уровень критичности (порядок важен): «non-critical» — это warning, а «critical»
    // /«non-recoverable»/«fault»/«failure» — это critical.
    if (/\bnon-recoverable\b|\bnonrecoverable\b|\bfailed\b|\bfailure\b|\bgone missing\b|\bfault\b/i.test(s) || /\bcritical\b/.test(s.replace(/\bnon-?critical\b/gi, ''))) ev.level = 'critical';
    else if (/\bnon-?critical\b|\bwarning\b|going high|going low|transition|asserted/i.test(s)) ev.level = 'warning';
    else ev.level = 'info';
    events.push(ev);
  }
  return events;
}

// Парсинг `chassis status`: блок «key : value». Ключи приводом к нижнему регистру.
function parseChassis(out) {
  const o = {};
  for (const line of out.split('\n')) {
    const m = line.match(/^([A-Za-z/ \-]+?)\s*:\s*(.+)$/);
    if (!m) continue;
    const k = m[1].trim().toLowerCase().replace(/[\s/]+/g, '_');
    o[k] = m[2].trim();
  }
  return o;
}

// Общая обёртка запуска ipmitool (пароль только в env/аргументе, не логи).
async function run(base, sub, env, timeout = 20000) {
  try {
    const r = await exec('ipmitool', [...base, ...sub], { env, timeout, maxBuffer: 128 * 1024 });
    return r.stdout || '';
  } catch {
    return '';
  }
}

// opts: { host, username, password }
export async function readSensors(opts) {
  const { host, username, password } = opts;
  const base = ['-I', 'lanplus', '-H', host, '-U', username, '-P', password || ''];
  const env = { ...process.env, IPMITOOL_PASS: password || '' };
  const [t, f] = await Promise.all([
    run(base, ['sdr', 'type', 'Temperature'], env),
    run(base, ['sdr', 'type', 'Fan'], env),
  ]);
  return { host: opts.host, temps: parseSensors(t).temps, fans: parseSensors(f).fans };
}

// SEL: последние `last` записей журнала событий (default 100).
export async function readSEL(opts, last = 100) {
  const { host, username, password } = opts;
  const base = ['-I', 'lanplus', '-H', host, '-U', username, '-P', password || ''];
  const env = { ...process.env, IPMITOOL_PASS: password || '' };
  const out = await run(base, ['sel', 'elist', 'last', String(last)], env, 25000);
  return { host: opts.host, events: parseSEL(out) };
}

// Питание/здоровье корпуса (chassis status) + power status.
export async function readChassis(opts) {
  const { host, username, password } = opts;
  const base = ['-I', 'lanplus', '-H', host, '-U', username, '-P', password || ''];
  const env = { ...process.env, IPMITOOL_PASS: password || '' };
  const [cs, ps] = await Promise.all([
    run(base, ['chassis', 'status'], env),
    run(base, ['chassis', 'power', 'status'], env),
  ]);
  const status = parseChassis(cs);
  const pm = String(ps).match(/power is\s+(on|off)/i);
  return {
    host: opts.host,
    power: pm ? pm[1].toLowerCase() : (status.chassis_power?.toLowerCase() || null),
    faults: {
      drive: /true/i.test(status.drive_fault || ''),
      cooling: /true/i.test(status.cooling_fan_fault || ''),
      intrusion: /true/i.test(status.chassis_intrusion || ''),
      powerFault: /true/i.test(status.chassis_power_faults || ''),
    },
    raw: status,
  };
}

// Инвентарь FRU (производитель/модель/серийник/version). Строки «key : value».
export async function readFru(opts) {
  const { host, username, password } = opts;
  const base = ['-I', 'lanplus', '-H', host, '-U', username, '-P', password || ''];
  const env = { ...process.env, IPMITOOL_PASS: password || '' };
  const out = await run(base, ['fru', 'print'], env);
  const fru = {};
  for (const line of out.split('\n')) {
    const m = line.match(/^([A-Za-z0-9 /_.-]+?)\s*:\s*(.+)$/);
    if (!m) continue;
    const k = m[1].trim().toLowerCase();
    const v = m[2].trim();
    if (v && v !== 'Unknown') fru[k] = v;
  }
  return { host: opts.host, fru };
}

// Все данные одним вызовом (сенсоры + SEL + питание + FRU).
export async function readAll(opts) {
  const [sensors, sel, chassis, fru] = await Promise.all([
    readSensors(opts).catch(() => ({ temps: [], fans: [] })),
    readSEL(opts, 100).catch(() => ({ events: [] })),
    readChassis(opts).catch(() => ({ power: null, faults: {} })),
    readFru(opts).catch(() => ({ fru: {} })),
  ]);
  return {
    host: opts.host,
    temps: sensors.temps || [],
    fans: sensors.fans || [],
    events: sel.events || [],
    power: chassis.power === undefined ? null : chassis.power,
    faults: chassis.faults || {},
    fru: fru.fru || {},
  };
}
