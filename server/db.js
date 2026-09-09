// Единая SQLite-база собранных IPMI-данных (фаза 2): data/db/ipmi.sqlite.
//
// ИНВАРИАНТ: удаление папки data/db/ стирает ВЕСЬ сбор и ТОЛЬКО его.
// Настройки (servers.json, интервалы, состав опроса) живут вне БД —
// после rm -rf data/db/ система сразу продолжает опрос тех же серверов.
//
// В БД (всё, что собрано с IPMI):
//   - справочники: сенсоры; FRU-снимок в состоянии сервера
//   - текущее состояние (upsert, без роста): значения сенсоров, chassis/
//     питание/фолты, доступность, last-known инвентарь
//   - история ТОЛЬКО изменений значений (экономия объёма)
//   - SEL-события с дедупом на уровне БД (UNIQUE-ключ, INSERT OR IGNORE):
//     повторы от 60-секундных опросов и рестартов не пишутся
//   - журнал опросов: каждый опрос (время, длительность, успех/ошибка)
//   - переходы доступности up/down — только смена состояния
//   - last-known инвентарь + изменения конфигурации + история версий
//   - единый журнал событий (SEL-критика + переходы + операционные)
//
// Один опрос = одна транзакция: в БД нет полусобранных опросов. Что
// успело записаться до отказа сервера/сборщика — то и доступно.
import Database from 'better-sqlite3';
import { mkdirSync, existsSync, renameSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_DIR = path.join(__dirname, '..', 'data', 'db');
const DB_FILE = path.join(DB_DIR, 'ipmi.sqlite');

const KEY_FIELDS = ['System Type', 'Chassis Type', 'Serial', 'System GUID', 'BIOS Version', 'System Name', 'System O/S', 'System IP'];
const VERSION_FIELDS = ['BIOS Version', 'Firmware Revision', 'iRMC Version', 'iRMC Firmware', 'OEM', 'System O/S', 'OS Version', 'System Name', 'Serial', 'System GUID'];

let db = null;

export function initDb(dbFile = DB_FILE) {
  if (db) return db;
  mkdirSync(path.dirname(dbFile), { recursive: true });
  db = new Database(dbFile);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sensors (
      server_id TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,            -- temp | fan
      units TEXT NOT NULL,           -- degrees C | RPM
      first_ts INTEGER NOT NULL,
      last_ts INTEGER NOT NULL,
      PRIMARY KEY (server_id, name)
    );

    -- Текущее значение сенсора: одна строка, перезапись (без роста)
    CREATE TABLE IF NOT EXISTS sensor_state (
      server_id TEXT NOT NULL,
      name TEXT NOT NULL,
      value REAL NOT NULL,
      ts INTEGER NOT NULL,
      PRIMARY KEY (server_id, name)
    );

    -- История значений: ТОЛЬКО изменения (запись при отличии от предыдущей)
    CREATE TABLE IF NOT EXISTS sensor_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id TEXT NOT NULL,
      name TEXT NOT NULL,
      ts INTEGER NOT NULL,
      value REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sh ON sensor_history (server_id, name, ts);

    -- Состояние сервера: одна строка на сервер (upsert). Три канала
    -- доступности могут отваливаться НЕЗАВИСИМО (владелец: «вебка виснет,
    -- а ping/IPMI живы»): ping (ICMP), web (TCP-порт), ipmi (опрос).
    CREATE TABLE IF NOT EXISTS server_state (
      server_id TEXT NOT NULL PRIMARY KEY,
      up INTEGER NOT NULL,           -- 0/1: последний IPMI-опрос успешен/нет
      last_ok_ts INTEGER,            -- последний успешный опрос
      last_poll_ts INTEGER,          -- любой опрос
      response_ms REAL,              -- длительность последнего успешного опроса
      power TEXT,                    -- on | off | null
      faults TEXT NOT NULL DEFAULT '{}', -- JSON {drive,cooling,intrusion,powerFault}
      fru TEXT NOT NULL DEFAULT '{}',    -- JSON FRU-снимок (оборудование)
      poll_error TEXT,
      ping_ok INTEGER,               -- 0/1/null: ICMP-эхо последней проверки
      ping_ms REAL,
      web_ok INTEGER,                -- 0/1/null: TCP web-порт (без HTTP!)
      web_ms REAL
    );

    -- Журнал опросов: каждый опрос каждого сервера (успех или ошибка).
    -- Питает ряды ping/response_ms и сводки доступности. Каналы ping/web
    -- фиксируются в server_state (сводно) — их история в опросе не нужна.
    CREATE TABLE IF NOT EXISTS polls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      server_id TEXT NOT NULL,
      ok INTEGER NOT NULL,
      duration_ms REAL NOT NULL,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_polls_ts ON polls (ts);
    CREATE INDEX IF NOT EXISTS idx_polls_srv ON polls (server_id, ts);

    -- Переходы доступности: только смена up<->down
    CREATE TABLE IF NOT EXISTS avail_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      up INTEGER NOT NULL,
      response_ms REAL
    );
    CREATE INDEX IF NOT EXISTS idx_ac ON avail_changes (server_id, ts);

    -- SEL-события с дедупом на уровне БД: UNIQUE (server_id, sel_id, sel_ts,
    -- sensor, detail) + INSERT OR IGNORE. Ключ живёт в БД — дедуп
    -- переживает рестарты (прежний дедуп в памяти плодил тысячи дублей).
    CREATE TABLE IF NOT EXISTS sel_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id TEXT NOT NULL,
      sel_id TEXT NOT NULL,
      sel_ts TEXT NOT NULL,          -- как отдаёт ipmitool: "09/08/2026 15:05:12"
      sensor TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      category TEXT,
      level TEXT NOT NULL,           -- info | warning | critical
      first_seen INTEGER NOT NULL    -- когда впервые попал к нам
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sel_uniq ON sel_events
      (server_id, sel_id, sel_ts, sensor, detail);
    CREATE INDEX IF NOT EXISTS idx_sel_srv ON sel_events (server_id, first_seen);

    -- Последний снимок SEL-журнала сервера («Журналы» после рестарта)
    CREATE TABLE IF NOT EXISTS sel_last (
      server_id TEXT NOT NULL PRIMARY KEY,
      ts INTEGER NOT NULL,
      events TEXT NOT NULL           -- JSON-массив событий последнего опроса
    );

    -- Last-known инвентарь (снимок по факту /api/info): офлайн-доступ
    CREATE TABLE IF NOT EXISTS last_known (
      server_id TEXT NOT NULL PRIMARY KEY,
      ts INTEGER NOT NULL,
      inventory TEXT NOT NULL        -- JSON
    );

    -- Изменения ключевых полей конфигурации
    CREATE TABLE IF NOT EXISTS config_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      server_id TEXT NOT NULL,
      field TEXT NOT NULL,
      prev TEXT,
      next TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cc ON config_changes (server_id, ts);

    -- История версий оборудования (снимки при подключении)
    CREATE TABLE IF NOT EXISTS versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      server_id TEXT NOT NULL,
      by TEXT,
      versions TEXT NOT NULL         -- JSON
    );
    CREATE INDEX IF NOT EXISTS idx_ver ON versions (server_id, ts);

    -- Единый журнал событий (SEL-критика + переходы + операционные)
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      server_id TEXT,
      kind TEXT NOT NULL,            -- info | warn | error
      text TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts);
  `);
  // Живая база могла быть создана до трёхканальной схемы — доставляем
  // недостающие колонки (ping_ok/ping_ms/web_ok/web_ms) безопасно.
  const cols = new Set(db.prepare('PRAGMA table_info(server_state)').all().map((c) => c.name));
  for (const [col, ddl] of [['ping_ok', 'INTEGER'], ['ping_ms', 'REAL'], ['web_ok', 'INTEGER'], ['web_ms', 'REAL']]) {
    if (!cols.has(col)) db.exec(`ALTER TABLE server_state ADD COLUMN ${col} ${ddl}`);
  }
  return db;
}

function tx(fn) {
  return db.transaction(fn)();
}

// === Запись опроса =========================================================

// Один успешный опрос = одна транзакция. r = результат ipmi.readAll():
// {temps[], fans[], events[], power, faults, fru}. channels = результат
// checkChannels (ping/web) — опционально. Возвращает счётчики
// (для логов). Обрыв во время записи -> откат целиком, полусобранных
// опросов в БД не бывает.
export function recordPoll(serverId, r, durationMs, ts = Date.now(), channels = null) {
  if (!db) initDb();
  const result = { changedValues: 0, newSel: 0, transitions: [] };
  const newSelEvents = [];
  const ch = channels || {};
  tx(() => {
    // 1. Справочник сенсоров + состояние + история (только изменения)
    const insSensor = db.prepare('INSERT INTO sensors (server_id, name, kind, units, first_ts, last_ts) VALUES (?,?,?,?,?,?) ON CONFLICT(server_id,name) DO UPDATE SET last_ts=excluded.last_ts');
    const setState = db.prepare('INSERT INTO sensor_state (server_id, name, value, ts) VALUES (?,?,?,?) ON CONFLICT(server_id,name) DO UPDATE SET value=excluded.value, ts=excluded.ts');
    const getState = db.prepare('SELECT value FROM sensor_state WHERE server_id=? AND name=?');
    const insHist = db.prepare('INSERT INTO sensor_history (server_id, name, ts, value) VALUES (?,?,?,?)');
    const put = (name, kind, units, value) => {
      insSensor.run(serverId, name, kind, units, ts, ts);
      const prev = getState.get(serverId, name);
      if (!prev || prev.value !== value) { insHist.run(serverId, name, ts, value); result.changedValues++; }
      setState.run(serverId, name, value, ts);
    };
    for (const t of r.temps || []) put(t.name, 'temp', 'degrees C', t.value);
    for (const f of r.fans || []) put(f.name, 'fan', 'RPM', f.value);

    // 2. Состояние сервера + переходы доступности/питания. Три канала
    //    (ping/web/ipmi) независимы: web может висеть при живых ping/ipmi.
    const st = db.prepare('SELECT up, power, ping_ok, web_ok FROM server_state WHERE server_id=?').get(serverId);
    const wasUp = st ? st.up : null;
    const wasPower = st ? st.power : null;
    db.prepare(`INSERT INTO server_state (server_id, up, last_ok_ts, last_poll_ts, response_ms, power, faults, fru, poll_error, ping_ok, ping_ms, web_ok, web_ms)
      VALUES (?,?,?,?,?,?,?,?,NULL,?,?,?,?)
      ON CONFLICT(server_id) DO UPDATE SET
        up=excluded.up, last_ok_ts=excluded.last_ok_ts, last_poll_ts=excluded.last_poll_ts,
        response_ms=excluded.response_ms, power=excluded.power, faults=excluded.faults,
        fru=CASE WHEN excluded.fru='{}' THEN server_state.fru ELSE excluded.fru END,
        poll_error=NULL,
        ping_ok=COALESCE(excluded.ping_ok, server_state.ping_ok),
        ping_ms=COALESCE(excluded.ping_ms, server_state.ping_ms),
        web_ok=COALESCE(excluded.web_ok, server_state.web_ok),
        web_ms=COALESCE(excluded.web_ms, server_state.web_ms)`)
      .run(serverId, 1, ts, ts, durationMs, r.power ?? null, JSON.stringify(r.faults || {}), JSON.stringify(r.fru || {}),
        ch.ping ? (ch.ping.ok ? 1 : 0) : null, ch.ping ? ch.ping.ms : null,
        ch.web ? (ch.web.ok ? 1 : 0) : null, ch.web ? ch.web.ms : null);
    // первое наблюдение up или восстановление после down — переход в историю
    if (wasUp === null || wasUp === 0) {
      db.prepare('INSERT INTO avail_changes (server_id, ts, up, response_ms) VALUES (?,?,1,?)').run(serverId, ts, durationMs);
      if (wasUp === 0) result.transitions.push('up');
    }
    if (wasPower != null && r.power != null && wasPower !== r.power) {
      result.transitions.push('power:' + r.power);
    }

    // 3. SEL-события: дедуп на уровне БД
    const insSel = db.prepare('INSERT OR IGNORE INTO sel_events (server_id, sel_id, sel_ts, sensor, detail, category, level, first_seen) VALUES (?,?,?,?,?,?,?,?)');
    for (const ev of r.events || []) {
      const info = insSel.run(serverId, ev.id || '', ev.ts || '', ev.sensor || '', ev.detail || '', ev.category || 'other', ev.level || 'info', ts);
      if (info.changes > 0) { result.newSel++; newSelEvents.push(ev); }
    }
    db.prepare('INSERT INTO sel_last (server_id, ts, events) VALUES (?,?,?) ON CONFLICT(server_id) DO UPDATE SET ts=excluded.ts, events=excluded.events')
      .run(serverId, ts, JSON.stringify(r.events || []));

    // 4. Журнал опросов
    db.prepare('INSERT INTO polls (ts, server_id, ok, duration_ms, error) VALUES (?,?,1,?,NULL)').run(ts, serverId, durationMs);
  });
  // Единый журнал: SEL-критика и переходы (после транзакции — операционный
  // журнал, его сбой не должен ронять данные опроса)
  for (const ev of newSelEvents) {
    if (ev.level === 'critical') addEvent(serverId, 'warn', `IPMI [${ev.sensor}] ${ev.detail || ev.category}`, ts);
  }
  for (const t of result.transitions) {
    if (t === 'up') addEvent(serverId, 'info', 'IPMI-опрос восстановлен', ts);
    else if (t.startsWith('power:')) addEvent(serverId, 'info', `Питание: ${t.slice(6) === 'on' ? 'включено' : 'выключено'}`, ts);
  }
  return result;
}

// Неудавшийся опрос: тоже транзакция. Данные сервера не затираются —
// остаётся последнее успешное состояние + фиксируется момент отказа.
// Каналы ping/web при отказе IPMI НЕ трогаем (они могли быть живы).
export function recordPollFailure(serverId, durationMs, error, ts = Date.now(), channels = null) {
  if (!db) initDb();
  const ch = channels || {};
  let wentDown = false;
  tx(() => {
    const st = db.prepare('SELECT up FROM server_state WHERE server_id=?').get(serverId);
    wentDown = !!(st && st.up === 1);
    db.prepare(`INSERT INTO server_state (server_id, up, last_ok_ts, last_poll_ts, response_ms, power, faults, fru, poll_error, ping_ok, ping_ms, web_ok, web_ms)
      VALUES (?,0,NULL,?,NULL,NULL,'{}','{}',?,?,NULL,?,NULL)
      ON CONFLICT(server_id) DO UPDATE SET
        up=0, last_poll_ts=excluded.last_poll_ts, poll_error=excluded.poll_error,
        ping_ok=COALESCE(excluded.ping_ok, server_state.ping_ok),
        ping_ms=COALESCE(excluded.ping_ms, server_state.ping_ms)`)
      .run(serverId, ts, String(error || ''),
        ch.ping ? (ch.ping.ok ? 1 : 0) : null, ch.ping ? ch.ping.ms : null);
    db.prepare('INSERT INTO polls (ts, server_id, ok, duration_ms, error) VALUES (?,?,0,?,?)').run(ts, serverId, durationMs, String(error || ''));
    if (wentDown) db.prepare('INSERT INTO avail_changes (server_id, ts, up, response_ms) VALUES (?,?,0,NULL)').run(serverId, ts);
  });
  if (wentDown) addEvent(serverId, 'warn', `IPMI-опрос недоступен: ${String(error || '').slice(0, 120)}`, ts);
}

// === Инвентарь (по факту /api/info) ========================================

// Снимок инвентаря + детект ключевых изменений конфигурации.
export function saveSnapshot(serverId, inventory, ts = Date.now()) {
  if (!db) initDb();
  if (!inventory || !Object.keys(inventory).length) return { changes: [] };
  const changes = [];
  tx(() => {
    const prev = db.prepare('SELECT inventory FROM last_known WHERE server_id=?').get(serverId);
    if (prev) {
      try {
        const pInv = JSON.parse(prev.inventory);
        if (pInv && Object.keys(pInv).length) {
          for (const f of KEY_FIELDS) {
            const a = String(pInv[f] ?? ''), b = String(inventory[f] ?? '');
            if (a !== b) {
              changes.push({ field: f, from: a || '—', to: b || '—', ts: new Date(ts).toISOString() });
              db.prepare('INSERT INTO config_changes (ts, server_id, field, prev, next) VALUES (?,?,?,?,?)').run(ts, serverId, f, a || '—', b || '—');
            }
          }
        }
      } catch { /* повреждённый JSON — перезапишем */ }
    }
    db.prepare('INSERT INTO last_known (server_id, ts, inventory) VALUES (?,?,?) ON CONFLICT(server_id) DO UPDATE SET ts=excluded.ts, inventory=excluded.inventory')
      .run(serverId, ts, JSON.stringify(inventory));
  });
  return { changes };
}

export function recordVersionSnapshot(serverId, inventory, by = null, ts = Date.now()) {
  if (!db) initDb();
  if (!inventory || !Object.keys(inventory).length) return;
  const pick = {};
  for (const f of VERSION_FIELDS) {
    const v = String(inventory[f] ?? '').trim();
    if (v) pick[f] = v;
  }
  if (!Object.keys(pick).length) return;
  db.prepare('INSERT INTO versions (ts, server_id, by, versions) VALUES (?,?,?,?)').run(ts, serverId, by || null, JSON.stringify(pick));
}

// === Единый журнал событий =================================================

export function addEvent(serverId, kind, text, ts = Date.now()) {
  if (!db) initDb();
  db.prepare('INSERT INTO events (ts, server_id, kind, text) VALUES (?,?,?,?)').run(ts, serverId, kind, text);
}

export function getEvents(limit = 100, serverId = null) {
  if (!db) initDb();
  const rows = serverId
    ? db.prepare('SELECT ts, server_id, kind, text FROM events WHERE server_id=? ORDER BY ts DESC, id DESC LIMIT ?').all(serverId, limit)
    : db.prepare('SELECT ts, server_id, kind, text FROM events ORDER BY ts DESC, id DESC LIMIT ?').all(limit);
  return rows.map((r) => ({ ts: new Date(r.ts).toISOString(), serverId: r.server_id, kind: r.kind, text: r.text }));
}

// === Чтение (форматы совместимы со старыми API) ============================

// Ряд метрики: 'temp:NAME'/'fan:NAME' — история изменений сенсора;
// 'response_ms'/'ping' — из журнала опросов.
export function series(serverId, metric, windowSec = 86400, ts = Date.now()) {
  if (!db) initDb();
  const from = ts - windowSec * 1000;
  if (metric === 'response_ms') {
    return db.prepare('SELECT ts, duration_ms AS value FROM polls WHERE server_id=? AND ok=1 AND ts>=? ORDER BY ts ASC')
      .all(serverId, from).map((r) => [r.ts, r.value]);
  }
  if (metric === 'ping') {
    return db.prepare('SELECT ts, ok AS value FROM polls WHERE server_id=? AND ts>=? ORDER BY ts ASC')
      .all(serverId, from).map((r) => [r.ts, r.value]);
  }
  const name = String(metric).includes(':') ? String(metric).split(':')[1] : metric;
  return db.prepare('SELECT ts, value FROM sensor_history WHERE server_id=? AND name=? AND ts>=? ORDER BY ts ASC')
    .all(serverId, name, from).map((r) => [r.ts, r.value]);
}

// Усреднённый ряд по сенсорам одного вида: 'temp:'/'fan:' (или temp/fan).
// Возвращает [[ts, avg, n], ...] — среднее по всем сенсорам вида на каждый
// момент (данные опроса пишутся одним ts).
export function avgSeries(serverId, prefix, windowSec = 86400, ts = Date.now()) {
  if (!db) initDb();
  const kind = String(prefix).replace(/:$/, '');
  const from = ts - windowSec * 1000;
  const rows = db.prepare(`
    SELECT h.ts, AVG(h.value) AS value, COUNT(*) AS n
    FROM sensor_history h JOIN sensors s ON s.server_id=h.server_id AND s.name=h.name
    WHERE h.server_id=? AND s.kind=? AND h.ts>=?
    GROUP BY h.ts ORDER BY h.ts ASC`).all(serverId, kind, from);
  return rows.map((r) => [r.ts, r.value, r.n]);
}

// Текущие значения сенсоров сервера: [{name, kind, units, value, ts}]
export function sensorValues(serverId) {
  if (!db) initDb();
  return db.prepare(`
    SELECT s.name, s.kind, s.units, st.value, st.ts
    FROM sensors s JOIN sensor_state st ON st.server_id=s.server_id AND st.name=s.name
    WHERE s.server_id=? ORDER BY s.kind, s.name`).all(serverId);
}

// Состояние сервера: up/lastOkTs/power/faults/pollError/responseMs +
// три канала: ping {ok,ms}, web {ok,ms}, ipmi {ok} — независимы.
export function serverStatus(serverId) {
  if (!db) initDb();
  const r = db.prepare('SELECT * FROM server_state WHERE server_id=?').get(serverId);
  if (!r) return null;
  let faults = {}, fru = {};
  try { faults = JSON.parse(r.faults || '{}'); } catch {}
  try { fru = JSON.parse(r.fru || '{}'); } catch {}
  return {
    up: !!r.up, lastOkTs: r.last_ok_ts, lastPollTs: r.last_poll_ts, responseMs: r.response_ms,
    power: r.power, faults, fru, pollError: r.poll_error || null,
    channels: {
      ping: r.ping_ok === null ? null : { ok: !!r.ping_ok, ms: r.ping_ms },
      web: r.web_ok === null ? null : { ok: !!r.web_ok, ms: r.web_ms },
      ipmi: { ok: !!r.up },
    },
  };
}

// Текущие значения по каждому серверу. Ключи — с префиксами, как в старой
// схеме ('temp:CPU1'), плюс response_ms — фронт читает их из lastValues.
export function lastValues() {
  if (!db) initDb();
  const out = {};
  for (const r of db.prepare('SELECT ss.server_id, ss.name, ss.value, ss.ts, s.kind FROM sensor_state ss JOIN sensors s ON s.server_id=ss.server_id AND s.name=ss.name').all()) {
    if (!out[r.server_id]) out[r.server_id] = {};
    out[r.server_id][r.kind + ':' + r.name] = { ts: r.ts, value: r.value };
  }
  for (const r of db.prepare('SELECT server_id, response_ms, last_ok_ts FROM server_state WHERE response_ms IS NOT NULL').all()) {
    if (!out[r.server_id]) out[r.server_id] = {};
    out[r.server_id]['response_ms'] = { ts: r.last_ok_ts, value: r.response_ms };
  }
  return out;
}

// Step-функция доступности: состояние на начало окна + переходы внутри.
// Возвращает {state, steps, firstTs}: state — up на момент from (или null,
// если до окна наблюдений нет), steps — переходы с ts > from, firstTs —
// самый ранний наблюдаемый момент (первый переход вообще или первый в окне).
function availSteps(serverId, from, ts) {
  const rows = db.prepare('SELECT ts, up FROM avail_changes WHERE server_id=? AND ts<=? ORDER BY ts ASC').all(serverId, ts);
  const cur = db.prepare('SELECT up, last_poll_ts, last_ok_ts FROM server_state WHERE server_id=?').get(serverId);
  let state = null;
  let firstTs = null;
  const steps = [];
  for (const r of rows) {
    if (firstTs === null) firstTs = r.ts;
    if (r.ts <= from) { state = r.up; continue; }
    steps.push(r);
  }
  if (cur && cur.up !== null && cur.up !== undefined) {
    const lastUp = steps.length ? steps[steps.length - 1].up : state;
    if (cur.up !== lastUp) steps.push({ ts: Math.min(Math.max(cur.last_poll_ts || ts, from), ts), up: cur.up });
  }
  // данных о переходах нет вовсе, но сервер опрашивался: считаем от первого
  // успешного опроса (единственное наблюдение = текущее состояние)
  if (firstTs === null && cur) firstTs = cur.last_ok_ts || cur.last_poll_ts || null;
  return { state, steps, firstTs };
}

// % времени в up за окно по серверу — по длительностям состояний.
// До первого наблюдения в окне состояние неизвестно и не считается.
export function availabilityFor(serverId, windowSec = 86400, ts = Date.now()) {
  if (!db) initDb();
  const from = ts - windowSec * 1000;
  const { state, steps, firstTs } = availSteps(serverId, from, ts);
  let s = state;
  // наблюдение начинается не раньше первого факта о сервере
  let tPrev = Math.max(from, firstTs || from);
  let upMs = 0, totalMs = 0;
  const add = (tNext, st) => {
    if (st === null || tNext <= tPrev) return;
    totalMs += tNext - tPrev;
    if (st === 1) upMs += tNext - tPrev;
    tPrev = tNext;
  };
  // до первого перехода состояние неизвестно; если переходов нет вовсе,
  // единственное наблюдение — текущее состояние с момента firstTs
  if (s === null && !steps.length) s = db.prepare('SELECT up FROM server_state WHERE server_id=?').get(serverId)?.up ?? null;
  for (const st of steps) { add(st.ts, s); s = st.up; }
  add(ts, s);
  const samples = db.prepare('SELECT COUNT(*) AS c FROM polls WHERE server_id=? AND ts>=?').get(serverId, from).c;
  return { samples, upMs, totalMs, pct: totalMs > 0 ? Math.round((1000 * upMs) / totalMs) / 10 : null };
}

// Сводка по всем серверам (дашборд «Обзор»)
export function availabilitySummary(windowSec = 86400, ts = Date.now()) {
  if (!db) initDb();
  const out = {};
  for (const r of db.prepare('SELECT DISTINCT server_id FROM server_state').all()) {
    out[r.server_id] = availabilityFor(r.server_id, windowSec, ts);
  }
  return out;
}

// Почасовая гистограмма доступности за окно (график дашборда)
export function availabilityBuckets(windowSec = 86400, bucketSec = 3600, ts = Date.now()) {
  if (!db) initDb();
  const from = ts - windowSec * 1000;
  const servers = db.prepare('SELECT DISTINCT server_id FROM server_state').all().map((r) => r.server_id);
  const nb = Math.max(1, Math.ceil(windowSec / bucketSec));
  const buckets = Array.from({ length: nb }, (_, i) => ({ ts: from + i * bucketSec * 1000, upMs: 0, totalMs: 0 }));
  for (const sid of servers) {
    const { state, steps, firstTs } = availSteps(sid, from, ts);
    let s = state;
    // наблюдение начинается не раньше первого факта о сервере
    let tPrev = Math.max(from, firstTs || from);
    // до первого перехода состояние неизвестно; если переходов нет,
    // единственное наблюдение — текущее состояние с момента firstTs
    if (s === null && !steps.length) s = db.prepare('SELECT up FROM server_state WHERE server_id=?').get(sid)?.up ?? null;
    const seg = (tNext, st) => {
      if (st === null || tNext <= tPrev) return;
      let t = tPrev;
      while (t < tNext) {
        const b = Math.min(nb - 1, Math.floor((t - from) / (bucketSec * 1000)));
        const bEnd = Math.min(tNext, from + (b + 1) * bucketSec * 1000);
        buckets[b].totalMs += bEnd - t;
        if (st === 1) buckets[b].upMs += bEnd - t;
        t = bEnd;
      }
    };
    for (const st of steps) { seg(st.ts, s); s = st.up; tPrev = st.ts; }
    seg(ts, s);
  }
  return buckets.map((b) => ({
    ts: b.ts,
    pct: b.totalMs > 0 ? Math.round((1000 * b.upMs) / b.totalMs) / 10 : null,
    samples: Math.round(b.totalMs / 1000),
  }));
}

// === Чтение для API (совместимость со старыми форматами) ===================

// Данные опроса для кеша/API: {ts, temps, fans, events, power, faults,
// fru, error, up} — всё из БД, доступно сразу после рестарта.
export function pollCache(serverId) {
  if (!db) initDb();
  const st = db.prepare('SELECT * FROM server_state WHERE server_id=?').get(serverId);
  if (!st) return null;
  const values = sensorValues(serverId);
  const temps = values.filter((v) => v.kind === 'temp').map((v) => ({ name: v.name, value: v.value }));
  const fans = values.filter((v) => v.kind === 'fan').map((v) => ({ name: v.name, value: v.value }));
  let events = [];
  const sel = db.prepare('SELECT events FROM sel_last WHERE server_id=?').get(serverId);
  if (sel) { try { events = JSON.parse(sel.events); } catch {} }
  let faults = {}, fru = {};
  try { faults = JSON.parse(st.faults || '{}'); } catch {}
  try { fru = JSON.parse(st.fru || '{}'); } catch {}
  return {
    ts: st.last_poll_ts, temps, fans, events,
    power: st.power, faults, fru,
    error: st.poll_error || null, up: !!st.up,
    channels: {
      ping: st.ping_ok === null ? null : { ok: !!st.ping_ok, ms: st.ping_ms },
      web: st.web_ok === null ? null : { ok: !!st.web_ok, ms: st.web_ms },
      ipmi: { ok: !!st.up },
    },
  };
}

export function getLastKnown(serverId) {
  if (!db) initDb();
  const r = db.prepare('SELECT ts, inventory FROM last_known WHERE server_id=?').get(serverId);
  if (!r) return null;
  try { return { ts: new Date(r.ts).toISOString(), inventory: JSON.parse(r.inventory) }; } catch { return null; }
}

export function getChanges(serverId, limit = 100) {
  if (!db) initDb();
  const rows = serverId
    ? db.prepare('SELECT ts, server_id, field, prev, next FROM config_changes WHERE server_id=? ORDER BY id DESC LIMIT ?').all(serverId, limit)
    : db.prepare('SELECT ts, server_id, field, prev, next FROM config_changes ORDER BY id DESC LIMIT ?').all(limit);
  return rows.map((r) => ({ ts: new Date(r.ts).toISOString(), serverId: r.server_id, field: r.field, from: r.prev, to: r.next }));
}

export function getVersions(serverId, limit = 50) {
  if (!db) initDb();
  const rows = db.prepare('SELECT ts, by, versions FROM versions WHERE server_id=? ORDER BY id DESC LIMIT ?').all(serverId, limit);
  return rows.map((r) => { let v = {}; try { v = JSON.parse(r.versions); } catch {} return { ts: new Date(r.ts).toISOString(), by: r.by || null, versions: v }; });
}

// Ретеншн: история/журналы старше N дней. Состояние НЕ трогаем — оно
// актуальное, а не историческое.
export function prune(retentionDays = 30) {
  if (!db) initDb();
  const cutoff = Date.now() - retentionDays * 86400 * 1000;
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM sensor_history WHERE ts < ?').run(cutoff);
    db.prepare('DELETE FROM polls WHERE ts < ?').run(cutoff);
    db.prepare('DELETE FROM sel_events WHERE first_seen < ?').run(cutoff);
    db.prepare('DELETE FROM events WHERE ts < ?').run(cutoff);
    db.prepare('DELETE FROM config_changes WHERE ts < ?').run(cutoff);
    db.prepare('DELETE FROM versions WHERE ts < ?').run(cutoff);
    db.prepare('DELETE FROM avail_changes WHERE ts < ?').run(cutoff);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// === Миграция старой схемы (разовая) =======================================

// Переносит data/metrics.sqlite (ряды сенсоров/ping) и data/storage.json
// (lastKnown/changes/versions/events) в новую БД. Возвращает счётчик.
// Сами файлы НЕ удаляются — freezeLegacy() переименовывает их в *.migrated.
export function migrateLegacy(dataDir, log = () => {}) {
  if (!db) initDb();
  let migrated = 0;

  // 1) metrics.sqlite -> история сенсоров/опросов/переходы
  const oldMetrics = path.join(dataDir, 'metrics.sqlite');
  if (existsSync(oldMetrics)) {
    try {
      const old = new Database(oldMetrics, { readonly: true });
      const pings = old.prepare("SELECT server_id, ts, value FROM metrics WHERE metric='ping' ORDER BY ts ASC").all();
      const durations = {};
      for (const r of old.prepare("SELECT server_id, ts, value FROM metrics WHERE metric='response_ms' ORDER BY ts ASC").all()) {
        durations[r.server_id + '|' + r.ts] = r.value;
      }
      const prevBySrv = {};
      for (const p of pings) {
        const prev = prevBySrv[p.server_id];
        if (prev === undefined || prev !== p.value) {
          db.prepare('INSERT INTO avail_changes (server_id, ts, up, response_ms) VALUES (?,?,?,NULL)').run(p.server_id, p.ts, p.value);
          prevBySrv[p.server_id] = p.value;
        }
        db.prepare('INSERT INTO polls (ts, server_id, ok, duration_ms, error) VALUES (?,?,?,?,NULL)').run(p.ts, p.server_id, p.value, durations[p.server_id + '|' + p.ts] ?? 0);
      }
      const rows = old.prepare("SELECT server_id, metric, ts, value FROM metrics WHERE metric LIKE 'temp:%' OR metric LIKE 'fan:%' ORDER BY ts ASC").all();
      const insSensor = db.prepare('INSERT INTO sensors (server_id, name, kind, units, first_ts, last_ts) VALUES (?,?,?,?,?,?) ON CONFLICT(server_id,name) DO UPDATE SET last_ts=excluded.last_ts');
      const setState = db.prepare('INSERT INTO sensor_state (server_id, name, value, ts) VALUES (?,?,?,?) ON CONFLICT(server_id,name) DO UPDATE SET value=excluded.value, ts=excluded.ts');
      const insHist = db.prepare('INSERT INTO sensor_history (server_id, name, ts, value) VALUES (?,?,?,?)');
      const lastVal = {};
      for (const r of rows) {
        const name = r.metric.slice(r.metric.indexOf(':') + 1);
        const kind = r.metric.startsWith('temp:') ? 'temp' : 'fan';
        const units = kind === 'temp' ? 'degrees C' : 'RPM';
        insSensor.run(r.server_id, name, kind, units, r.ts, r.ts);
        const key = r.server_id + '|' + name;
        if (lastVal[key] === undefined || lastVal[key] !== r.value) insHist.run(r.server_id, name, r.ts, r.value);
        lastVal[key] = r.value;
        setState.run(r.server_id, name, r.value, r.ts);
      }
      // server_state: up/последний опрос по последнему пингу
      const lastPing = {};
      for (const p of pings) lastPing[p.server_id] = p;
      for (const [sid, p] of Object.entries(lastPing)) {
        db.prepare(`INSERT INTO server_state (server_id, up, last_ok_ts, last_poll_ts, response_ms, power, faults, fru, poll_error)
          VALUES (?,?,?,?,NULL,NULL,'{}','{}',NULL)
          ON CONFLICT(server_id) DO UPDATE SET up=excluded.up, last_ok_ts=excluded.last_ok_ts, last_poll_ts=excluded.last_poll_ts`)
          .run(sid, p.value, p.value ? p.ts : null, p.ts);
      }
      migrated += rows.length + pings.length;
      old.close();
      log(`migrate: metrics.sqlite — ${rows.length} точек сенсоров, ${pings.length} пингов`);
    } catch (e) { log('migrate metrics.sqlite failed: ' + (e.message || e)); }
  }

  // 2) storage.json -> last_known/config_changes/versions/events
  const storageFile = path.join(dataDir, 'storage.json');
  if (existsSync(storageFile)) {
    try {
      const j = JSON.parse(readFileSync(storageFile, 'utf8'));
      let n = 0;
      if (j.lastKnown && typeof j.lastKnown === 'object') {
        for (const [sid, v] of Object.entries(j.lastKnown)) {
          if (v && v.inventory && Object.keys(v.inventory).length) {
            const ts = Date.parse(v.ts || '') || Date.now();
            db.prepare('INSERT INTO last_known (server_id, ts, inventory) VALUES (?,?,?) ON CONFLICT(server_id) DO UPDATE SET ts=excluded.ts, inventory=excluded.inventory')
              .run(sid, ts, JSON.stringify(v.inventory));
            n++;
          }
        }
      }
      if (Array.isArray(j.changes)) {
        for (const c of j.changes) {
          const ts = Date.parse(c.ts || '') || Date.now();
          db.prepare('INSERT INTO config_changes (ts, server_id, field, prev, next) VALUES (?,?,?,?,?)').run(ts, c.serverId, c.field, c.from, c.to);
          n++;
        }
      }
      if (Array.isArray(j.events)) {
        for (const e of j.events) {
          const ts = Date.parse(e.ts || '') || Date.now();
          db.prepare('INSERT INTO events (ts, server_id, kind, text) VALUES (?,?,?,?)').run(ts, e.serverId, e.kind, e.text);
          n++;
        }
      }
      if (j.versions && typeof j.versions === 'object') {
        for (const [sid, arr] of Object.entries(j.versions)) {
          if (!Array.isArray(arr)) continue;
          for (const v of arr) {
            const ts = Date.parse(v.ts || '') || Date.now();
            db.prepare('INSERT INTO versions (ts, server_id, by, versions) VALUES (?,?,?,?)').run(ts, sid, v.by || null, JSON.stringify(v.versions || {}));
            n++;
          }
        }
      }
      migrated += n;
      log(`migrate: storage.json — lastKnown=${Object.keys(j.lastKnown || {}).length}, changes=${(j.changes || []).length}, events=${(j.events || []).length}, versions-серверов=${Object.keys(j.versions || {}).length}`);
    } catch (e) { log('migrate storage.json failed: ' + (e.message || e)); }
  }
  return migrated;
}

// Заморозить legacy-файлы (rename -> *.migrated), не удаляя
export function freezeLegacy(dataDir) {
  for (const m of ['metrics.sqlite', 'metrics.sqlite-shm', 'metrics.sqlite-wal']) {
    const from = path.join(dataDir, m);
    const to = from + '.migrated';
    try { if (existsSync(from) && !existsSync(to)) renameSync(from, to); } catch {}
  }
}

export function dbFile() { return DB_FILE; }
