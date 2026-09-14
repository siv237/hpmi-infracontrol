// Redfish-опрос BMC (HTTPS /redfish/v1) — для железок, где RMCP+ выключен
// (живой случай: HPE iLO 4 на baspx03, 192.168.3.206 — ipmitool молчит,
// но Redfish-дерево живое). Канон результата = ipmi.readAll(): temps/fans/
// events/power/faults/fru/net, чтобы db.recordPoll не менялся.
//
// Квёрки живого iLO 4 (fw 2.80), учтённые здесь:
//  - подряд идущие HTTPS-запросы он рвёт (socket hang up): каждый запрос —
//    своё соединение (Connection:close) + ретраи с растущей паузой;
//  - /redfish/v1/ отдаётся БЕЗ логина, но Systems/Managers/Chassis требуют
//    Basic-auth (401 «Base.0.10.NoValidSession»);
//  - Fans в Thermal — в ПРОЦЕНТАХ (Units:"Percent"), не RPM: units тащим
//    в поле fan.units, БД хранит единицы (degrees C | RPM | Percent);
//  - IML (журнал) — ленивые записи: в Entries/ только @odata.id, данные —
//    отдельным GET на каждую. Для опроса достаточно последних N.
import https from 'node:https';
import http from 'node:http';
import { permissiveTlsOptions } from '../../sdk/net.js';

// Дефолты живого iLO 4 (проверено 2026-09-14): пауза ≥900 мс между запросами
// держит сессию стабильно, ретрай ×3 с шагом 2 c вылечивает редкий hang up.
const REQ_TRIES = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Один GET с ретраями (каждая попытка — своё TCP-соединение). Норм-ответ:
// { st, body } | ошибка сети: { st:0, err }.
export async function rfGet(opts, path, { auth, tries = REQ_TRIES, timeoutMs = 8000 } = {}) {
  const { host, port = 443, secure = true } = opts || {};
  const mod = secure ? https : http;
  for (let i = 1; i <= tries; i++) {
    const r = await new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      const headers = { Connection: 'close' };
      if (auth) headers.Authorization = 'Basic ' + auth;
      const req = mod.get(
        {
          host, port, path,
          rejectUnauthorized: false,           // legacy BMC: самоподписанные серт
          secureOptions: secure ? permissiveTlsOptions().secureOptions : undefined,
          headers,
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => { if (chunks.reduce((n, x) => n + x.length, 0) < 512 * 1024) chunks.push(c); });
          res.on('end', () => done({ st: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
          res.on('error', () => done({ st: 0, err: 'response error' }));
        }
      );
      req.on('error', (e) => done({ st: 0, err: e.message }));
      req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch {} done({ st: 0, err: 'timeout' }); });
    });
    if (r.st > 0) return r;
    if (i < tries) await sleep(2000 * i); // рост паузы между ретраями: 2c, 4c
  }
  return { st: 0, err: 'unreachable' };
}


// JSON-GET с Basic-auth из кредов opts (username/password).
export async function rfJson(opts, path, cfg) {
  const { username, password } = opts || {};
  const auth = username ? Buffer.from(`${username}:${password || ''}`).toString('base64') : null;
  const r = await rfGet(opts, path, { ...cfg, auth });
  if (r.st !== 200) return null;
  try { return JSON.parse(r.body); } catch { return null; }
}

// --- Чистые парсеры (гониаются в тестах на фикстурах живого iLO 4) ----------

// Thermal -> { temps: [{name, value}], fans: [{name, value, units}] }.
// Абсентные сенсоры (Status.State != Enabled / чтение null) пропускаем —
// это пустые слоты (DIMM/PCI), не показываем «0 °C».
export function parseThermal(j) {
  const temps = [], fans = [];
  for (const t of (j && j.Temperatures) || []) {
    const st = t.Status && t.Status.State;
    if (st && st !== 'Enabled' && st !== 'StandbyOffline') continue;
    if (t.ReadingCelsius == null) continue;
    temps.push({ name: t.Name || 'temp', value: t.ReadingCelsius });
  }
  for (const f of (j && j.Fans) || []) {
    const st = f.Status && f.Status.State;
    if (st && st !== 'Enabled' && st !== 'StandbyOffline') continue;
    if (f.Reading == null && f.CurrentReading == null) continue;
    const reading = f.Reading != null ? f.Reading : f.CurrentReading;
    fans.push({ name: f.FanName || f.Name || 'fan', value: reading, units: f.Units || 'RPM' });
  }
  return { temps, fans };
}

// Power -> { powerWatts, capacityWatts }. iLO 4: PowerControl[0].
export function parsePower(j) {
  const pc = (j && j.PowerControl && j.PowerControl[0]) || null;
  if (!pc) return null;
  return {
    powerWatts: pc.PowerConsumedWatts != null ? pc.PowerConsumedWatts : null,
    capacityWatts: pc.PowerCapacityWatts != null ? pc.PowerCapacityWatts : null,
  };
}

// Systems/1 -> { power, model, serial, bios, sku, health }.
export function parseSystem(j) {
  if (!j || !j.Model) return null;
  return {
    power: j.PowerState === 'On' ? 'on' : (j.PowerState === 'Off' ? 'off' : null),
    model: j.Model, serial: (j.SerialNumber || '').trim(), bios: j.BIOSVersion || '',
    sku: (j.SKU || '').trim(), health: (j.Status && j.Status.Health) || '',
  };
}

// IML-запись -> событие канона recordPoll: { id, ts, sensor, detail, category, level }.
// Уровни Redfish: Critical/Warning -> critical/warning, остальные info.
export function parseImlEntry(e) {
  if (!e) return null;
  const level = /critical/i.test(e.Severity || '') ? 'critical'
    : /warning/i.test(e.Severity || '') ? 'warning' : 'info';
  let category = 'other';
  const s = `${e.Message || ''}`.toLowerCase();
  if (/fan|cooling|thermal|temperature/.test(s)) category = 'fan';
  else if (/power|supply|redundan/.test(s)) category = 'power';
  else if (/drive|array|storage|disk/.test(s)) category = 'storage';
  else if (/memory|dimm/.test(s)) category = 'memory';
  else if (/processor|cpu/.test(s)) category = 'cpu';
  return {
    id: 'iml-' + (e.RecordId != null ? e.RecordId : (e.Id || '')),
    ts: e.Created || '',
    sensor: 'IML',
    detail: e.Message || '',
    category,
    level,
  };
}

// --- readAll (канон ipmi.readAll) ------------------------------------------

// Первый член коллекции (Systems/Managers/Chassis) — raw JSON ответа.
// root — распарсенный /redfish/v1/. Не найдено -> null.
async function collectionRaw(opts, root, key, fallbackPath) {
  let link = fallbackPath;
  try { link = (root[key] && root[key]['@odata.id']) || fallbackPath; } catch {}
  const col = await rfJson(opts, link.endsWith('/') ? link : link + '/');
  if (!col || !Array.isArray(col.Members) || !col.Members.length) return null;
  return await rfJson(opts, col.Members[0]['@odata.id']);
}

// Инвентарь: Systems (модель/серийник/BIOS) + Managers (fw BMC). Ключи —
// как у веб-инвентаря S2 (detail.js SI_ROWS), чтобы фронт не менялся.
// sysRaw — уже полученный Systems-член (raw): не дёргаем повторно — iLO
// рвёт подряд идущие запросы, экономим каждый GET.
async function readFruFromRedfish(opts, root, sysRaw) {
  const fru = {};
  const put = (k, v) => { if (v && !fru[k]) fru[k] = v; };
  const sys = parseSystem(sysRaw);
  if (!sys) return {};
  put('Model', sys.model);
  put('Serial Number', sys.serial);
  put('SKU', sys.sku);
  put('BIOS Version', sys.bios);
  const mgrRaw = await collectionRaw(opts, root, 'Managers', '/redfish/v1/Managers/');
  if (mgrRaw && mgrRaw.FirmwareVersion) put('BMC', mgrRaw.FirmwareVersion);
  return fru;
}

// Последние N IML-записей (журнал Redfish = аналог SEL). Entries-коллекция
// ленивая (только @odata.id) — дотягиваем каждую запись отдельным GET.
// sysRaw — уже полученный Systems-член: у него берём LogServices.
async function readIml(opts, sysRaw, last = 30) {
  if (!sysRaw) return [];
  const ls = sysRaw.LogServices && sysRaw.LogServices['@odata.id'];
  if (!ls) return [];
  const lsj = await rfJson(opts, ls.endsWith('/') ? ls : ls + '/');
  if (!lsj || !Array.isArray(lsj.Members)) return [];
  const iml = lsj.Members.find((m) => /IML/i.test(m['@odata.id'] || ''));
  if (!iml) return [];
  const entries = await rfJson(opts, iml['@odata.id'].replace(/\/?$/, '/') + 'Entries/');
  if (!entries || !Array.isArray(entries.Members)) return [];
  const ids = entries.Members.slice(-last).map((m) => m['@odata.id']);
  const out = [];
  for (const p of ids) {
    const e = await rfJson(opts, p);
    const ev = parseImlEntry(e);
    if (ev) out.push(ev);
  }
  return out;
}

// Все данные одним вызовом, канон ipmi.readAll: temps/fans/events/power/
// faults/fru/net. «redfish: true» — маркер источника для диагностики/UI:
// RMCP+ у этой железки не отвечает, опрос идёт по HTTPS.
export async function readAll(opts) {
  const t0 = Date.now();
  const root = await rfJson(opts, '/redfish/v1/');
  if (!root) throw new Error('Redfish недоступен: /redfish/v1/ не отвечает 200');
  // Systems-член нужен везде (power/инвентарь/LogServices) — берём ОДИН раз.
  const sysRaw = await collectionRaw(opts, root, 'Systems', '/redfish/v1/Systems/').catch(() => null);
  const sys = parseSystem(sysRaw);
  const fru = await readFruFromRedfish(opts, root, sysRaw).catch(() => ({}));
  let temps = [], fans = [], powerWatts = null;
  const chRaw = await collectionRaw(opts, root, 'Chassis', '/redfish/v1/Chassis/').catch(() => null);
  if (chRaw) {
    const thLink = chRaw.Thermal && chRaw.Thermal['@odata.id'];
    if (thLink) {
      const th = await rfJson(opts, thLink);
      const p = parseThermal(th);
      temps = p.temps; fans = p.fans;
    }
    const pwLink = chRaw.Power && chRaw.Power['@odata.id'];
    if (pwLink) {
      const pw = await rfJson(opts, pwLink);
      const pc = parsePower(pw);
      if (pc && pc.powerWatts != null) powerWatts = pc.powerWatts;
    }
  }
  const events = await readIml(opts, sysRaw, 30).catch(() => []);
  return {
    host: opts.host,
    temps, fans, events,
    power: sys ? sys.power : null,
    faults: {}, fru, net: {},
    powerWatts: powerWatts != null ? powerWatts : null,
    redfish: true,
    ms: Date.now() - t0,
  };
}
