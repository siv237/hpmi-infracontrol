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
  // Обход всех FRU-областей (0..5): у PRIMERGY/iRMC S4 данные разложены
  // по областям — chassis/product во 2-й, board в 3-й, дефолтная 0-я
  // часто пуста. Собираем всё в один словарь.
  const { host, username, password } = opts;
  const env = { ...process.env, IPMITOOL_PASS: password || '' };
  const base = ['-I', 'lanplus', '-H', host, '-U', username, '-P', password || ''];
  const fru = {};
  for (let i = 0; i <= 5; i++) {
    let out;
    try {
      const r = await exec('ipmitool', [...base, 'fru', 'print', String(i)], { env, timeout: 8000, maxBuffer: 64 * 1024 });
      out = r.stdout || '';
    } catch { continue; }
    for (const line of out.split('\n')) {
      const m = /^\s*([\w \-/]+?)\s*:\s*(.*?)\s*$/.exec(line);
      if (!m) continue;
      const k = m[1].toLowerCase();
      if (k.startsWith('fru') || k === '') continue;
      if (!fru[k] && m[2] && m[2] !== 'Unknown') fru[k] = m[2];
    }
  }
  return { host, fru };
}

// Инвентарь из IPMI (fallback, когда веб-инвентарь недоступен — iRMC S4):
// FRU-области + mc info + chassis power. Ключи совместимы с веб-инвентарём
// S2 (detail.js SI_ROWS), чтобы фронт не менялся.
export async function ipmiInventory(opts) {
  const [fruR, qc, chassis] = await Promise.all([
    readFru(opts).catch(() => ({ fru: {} })),
    quickCheck(opts).catch(() => null),
    readChassis(opts).catch(() => ({ power: null })),
  ]);
  const fru = fruR.fru || {};
  const inv = {};
  const put = (k, v) => { if (v && v !== 'Unknown' && !inv[k]) inv[k] = v; };
  // Ключи — как у веб-инвентаря S2 (detail.js SI_ROWS ищет их по src).
  put('Manufacturer', fru['product manufacturer'] || fru['board mfg'] || (qc && qc.ipmi.manufacturer) || '');
  put('Model', fru['product name'] || fru['board product'] || '');
  put('Serial Number', fru['product serial'] || fru['chassis serial'] || fru['board serial'] || '');
  put('Asset Tag', fru['product asset tag'] || '');
  put('BIOS Version', fru['bios version'] || '');
  if (qc && qc.ipmi) {
    put('BMC', qc.ipmi.bmcFirmware || '');
    put('IPMI Firmware', 'IPMI ' + (qc.ipmi.ipmiVersion || '') + ' · ' + (qc.ipmi.manufacturer || '') + ' · BMC ' + (qc.ipmi.bmcFirmware || ''));
  }
  if (qc && qc.lan) {
    if (qc.lan.mac) put('MAC', qc.lan.mac);
    if (qc.lan.ip) put('System IP', qc.lan.ip);
  }
  const board = [];
  if (fru['board product']) board.push('Board: ' + fru['board product'] + (fru['board part number'] ? ' (' + fru['board part number'] + ')' : ''));
  if (fru['board mfg date']) board.push('Board date: ' + fru['board mfg date']);
  if (fru['chassis type']) board.push('Chassis: ' + fru['chassis type'] + (fru['chassis part number'] ? ' (' + fru['chassis part number'] + ')' : ''));
  if (fru['product version']) board.push('Version: ' + fru['product version']);
  if (board.length) put('Description', board.join(' · '));
  return inv;
}

// Парсинг `lan print` (сетевые настройки BMC). Многострочные значения
// (Auth Type Enable, Cipher Suite Priv Max) схлопываем: ключ без значения
// накапливает последующие строки-продолжения.
function parseLan(out) {
  const o = {};
  let lastKey = null;
  for (const line of out.split('\n')) {
    if (!line.trim()) { lastKey = null; continue; }
    const m = line.match(/^([A-Za-z0-9 ./()-]+?)\s*:\s*(.*)$/);
    if (m) {
      const k = m[1].trim().toLowerCase().replace(/[\s/]+/g, '_').replace(/\.1q_/g, '_');
      o[k] = m[2].trim();
      lastKey = o[k] === '' ? k : null;
    } else if (lastKey && /^\s+:\s+/.test(line)) {
      // продолжение многострочного блока «        : User : MD5 PASSWORD»
      o[lastKey] += '\n' + line.trim();
    } else if (lastKey) {
      o[lastKey] += '\n' + line.trim();
    } else {
      const m2 = line.match(/^\s+:\s+(.+)$/);
      if (m2) { o._tail = (o._tail || '') + '\n' + m2[1]; }
    }
  }
  return o;
}

// Парсинг `mc info` (identity BMC): Device ID/FW/IPMI ver/Manufacturer.
function parseMcInfo(out) {
  const o = {};
  for (const line of out.split('\n')) {
    const m = line.match(/^([A-Za-z0-9 /_.]+?)\s*:\s*(.+)$/);
    if (!m) continue;
    const k = m[1].trim().toLowerCase().replace(/[\s/]+/g, '_');
    o[k] = m[2].trim();
  }
  return o;
}

// Сеть BMC «по максималке»: lan print (IP/маска/GW/MAC/DHCP|Static/VLAN/
// SNMP/RMCP+) + mc info (прошивка BMC, IPMI version, производитель).
// Читающие команды, интерактивных сессий не создают.
export async function readNetwork(opts) {
  const { host, username, password } = opts;
  const base = ['-I', 'lanplus', '-H', host, '-U', username, '-P', password || ''];
  const env = { ...process.env, IPMITOOL_PASS: password || '' };
  const [lan, mc] = await Promise.all([
    run(base, ['lan', 'print'], env, 15000),
    run(base, ['mc', 'info'], env, 15000),
  ]);
  const lanO = parseLan(lan);
  const mcO = parseMcInfo(mc);
  // нормализованный вид для UI/БД (сырые поля тоже отдаём)
  const net = {
    ip: lanO.ip_address || '',
    subnet: lanO.subnet_mask || '',
    gateway: lanO.default_gateway_ip || '',
    mac: (lanO.mac_address || '').toUpperCase(),
    ipSource: /dhcp/i.test(lanO.ip_address_source || '') ? 'dhcp' : (lanO.ip_address ? 'static' : ''),
    vlan: /disabled/i.test(lanO['8021q_vlan_id'] || '') ? null : (lanO['8021q_vlan_id'] || null),
    vlanPriority: lanO['8021q_vlan_priority'] || null,
    snmp: lanO.snmp_community_string || '',
    bmcArp: lanO.bmc_arp_control || '',
    cipherSuites: lanO.rmcp_cipher_suites || '',
    // BMC identity
    bmcFirmware: mcO.firmware_revision || '',
    ipmiVersion: mcO.ipmi_version || '',
    manufacturer: mcO.manufacturer_name || '',
    manufacturerId: mcO.manufacturer_id || '',
    productId: mcO.product_id || '',
  };
  return { host: opts.host, net, lan: lanO, mc: mcO };
}

// Все данные одним вызовом (сенсоры + SEL + питание + FRU + сеть BMC).
export async function readAll(opts) {
  const [sensors, sel, chassis, fru, net] = await Promise.all([
    readSensors(opts).catch(() => ({ temps: [], fans: [] })),
    readSEL(opts, 100).catch(() => ({ events: [] })),
    readChassis(opts).catch(() => ({ power: null, faults: {} })),
    readFru(opts).catch(() => ({ fru: {} })),
    readNetwork(opts).catch(() => ({ net: {} })),
  ]);
  return {
    host: opts.host,
    temps: sensors.temps || [],
    fans: sensors.fans || [],
    events: sel.events || [],
    power: chassis.power === undefined ? null : chassis.power,
    faults: chassis.faults || {},
    fru: fru.fru || {},
    net: net.net || {},
  };
}

// БЫСТРАЯ проверка при добавлении сервера (модал «Добавить сервер»):
// mc info + lan print — две лёгкие команды без сессий и без SDR/SEL/FRU.
// Проверяет креды (wrong password → ipmitool ругается в stderr) и заодно
// даёт «что за сервер»: прошивка BMC, IPMI-версия, производитель, IP/MAC.
// ВАЖНО: в error никогда не попадает командная строка (exec включает
// пароль в e.message!) — только наш безопасный текст.
export async function quickCheck(opts) {
  const { host, username, password } = opts;
  const t0 = Date.now();
  const base = ['-I', 'lanplus', '-H', host, '-U', username, '-P', password || ''];
  const env = { ...process.env, IPMITOOL_PASS: password || '' };
  const runOne = (sub) =>
    exec('ipmitool', [...base, ...sub], { env, timeout: 8000, maxBuffer: 16 * 1024 })
      .then((r) => ({ ok: true, out: r.stdout || '' }))
      .catch((e) => {
        // не включаем e.message: там полная командная строка с паролем
        const stderr = String((e && e.stderr) || '').slice(0, 200);
        const killed = (e && (e.killed || e.signal)) || /timed? ?out/i.test(stderr);
        return { ok: false, err: killed ? 'timeout' : (stderr || 'ipmitool failed') };
      });
  const [mc, lan] = await Promise.all([runOne(['mc', 'info']), runOne(['lan', 'print'])]);
  const ms = Date.now() - t0;
  const mcO = mc.ok ? parseMcInfo(mc.out) : {};
  const lanReal = lan.ok ? parseLan(lan.out) : {};
  // Диагноз: обе команды не прошли. Если хост вообще не отвечает RMCP+
  // (timeout/unreachable) — креды неизвестны; если отвечает ошибкой кредов —
  // адрес верный, логин/пароль нет.
  let auth = null;
  if (mc.ok || lan.ok) auth = true;
  else {
    const both = ((mc.err || '') + ' ' + (lan.err || '')).toLowerCase();
    const credErr = /wrong password|invalid password|unauthorized|name or password|password incorrect|sess processing|cipher/i.test(both);
    const netErr = /timeout|timed out|unreachable|no route|host not found|connection|get .* response|ipmitool failed/.test(both);
    auth = credErr ? false : (netErr ? null : false);
  }
  return {
    ms,
    ipmi: {
      ok: !!(mc.ok || lan.ok),
      auth,
      error: (!mc.ok && !lan.ok) ? (mc.err || lan.err) : null,
      bmcFirmware: mcO.firmware_revision || '',
      ipmiVersion: mcO.ipmi_version || '',
      manufacturer: mcO.manufacturer_name || '',
    },
    lan: lan.ok ? {
      ip: lanReal.ip_address || '',
      mac: (lanReal.mac_address || '').toUpperCase(),
      ipSource: lanReal.ip_address_source || '',
    } : null,
  };
}
