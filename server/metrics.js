// Хранилище метрик и событий (п.5): SQLite (better-sqlite3), data/metrics.sqlite.
// Пишет интервальный IPMI-LAN опрос (server/index.js): сенсоры по имени, а
// также доступность опроса (ping 0/1 + response_ms). Читает дашборд «Обзор»
// (п.1) — series/lastValues/availabilitySummary/availabilityBuckets.
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

let db = null;
let stmts = null;

export function initMetrics(dbFile = path.join(DATA_DIR, 'metrics.sqlite')) {
  if (db) return db;
  db = new Database(dbFile);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id TEXT NOT NULL,
      metric TEXT NOT NULL,
      ts INTEGER NOT NULL,
      value REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_metrics_smt ON metrics (server_id, metric, ts);
    CREATE INDEX IF NOT EXISTS idx_metrics_ts ON metrics (ts);
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      server_id TEXT,
      kind TEXT NOT NULL,
      text TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts);
  `);
  stmts = {
    insMetric: db.prepare('INSERT INTO metrics (server_id, metric, ts, value) VALUES (?, ?, ?, ?)'),
    insEvent: db.prepare('INSERT INTO events (ts, server_id, kind, text) VALUES (?, ?, ?, ?)'),
    series: db.prepare('SELECT ts, value FROM metrics WHERE server_id = ? AND metric = ? AND ts >= ? ORDER BY ts ASC'),
    lastPerServer: db.prepare(`
      SELECT m.server_id, m.metric, m.ts, m.value FROM metrics m
      JOIN (SELECT server_id, metric, MAX(ts) AS mx FROM metrics GROUP BY server_id, metric) l
        ON m.server_id = l.server_id AND m.metric = l.metric AND m.ts = l.mx`),
    events: db.prepare('SELECT ts, server_id, kind, text FROM events ORDER BY ts DESC, id DESC LIMIT ?'),
    eventsServer: db.prepare('SELECT ts, server_id, kind, text FROM events WHERE server_id = ? ORDER BY ts DESC, id DESC LIMIT ?'),
    pruneMetrics: db.prepare('DELETE FROM metrics WHERE ts < ?'),
    pruneEvents: db.prepare('DELETE FROM events WHERE ts < ?'),
  };
  return db;
}

export function writeMetric(serverId, metric, value, ts = Date.now()) {
  if (!stmts) initMetrics();
  stmts.insMetric.run(serverId, metric, ts, value);
}

// Доступность одного опроса: ping 0/1 + время ответа, мс
export function writeAvailability(serverId, up, ms, ts = Date.now()) {
  if (!stmts) initMetrics();
  stmts.insMetric.run(serverId, 'ping', ts, up ? 1 : 0);
  stmts.insMetric.run(serverId, 'response_ms', ts, ms);
}

export function addEvent(serverId, kind, text, ts = Date.now()) {
  if (!stmts) initMetrics();
  stmts.insEvent.run(ts, serverId, kind, text);
}

export function getEvents(limit = 100, serverId = null) {
  if (!stmts) initMetrics();
  const rows = serverId ? stmts.eventsServer.all(serverId, limit) : stmts.events.all(limit);
  return rows.map((r) => ({ ts: new Date(r.ts).toISOString(), serverId: r.server_id, kind: r.kind, text: r.text }));
}

// Временной ряд метрики: [[ts, value], ...]
export function series(serverId, metric, windowSec = 86400, ts = Date.now()) {
  if (!stmts) initMetrics();
  const from = ts - windowSec * 1000;
  return stmts.series.all(serverId, metric, from).map((r) => [r.ts, r.value]);
}

// Последние значения по каждому серверу (текущее состояние)
export function lastValues() {
  if (!stmts) initMetrics();
  const out = {};
  for (const r of stmts.lastPerServer.all()) {
    if (!out[r.server_id]) out[r.server_id] = {};
    out[r.server_id][r.metric] = { ts: r.ts, value: r.value };
  }
  return out;
}

// Процент успешных опросов за окно по каждому серверу
export function availabilitySummary(windowSec = 86400, ts = Date.now()) {
  if (!stmts) initMetrics();
  const from = ts - windowSec * 1000;
  const rows = db.prepare("SELECT server_id, SUM(value) AS up, COUNT(*) AS n FROM metrics WHERE metric = 'ping' AND ts >= ? GROUP BY server_id").all(from);
  const out = {};
  for (const r of rows) out[r.server_id] = { samples: r.n, upSamples: r.up, pct: r.n ? Math.round((100 * r.up) / r.n * 10) / 10 : null };
  return out;
}

// Почасовая гистограмма доступности за окно (для графика дашборда)
export function availabilityBuckets(windowSec = 86400, bucketSec = 3600, ts = Date.now()) {
  if (!stmts) initMetrics();
  const from = ts - windowSec * 1000;
  const rows = db.prepare(`
    SELECT (ts / ?) * ? AS bucket, SUM(value) AS up, COUNT(*) AS n
    FROM metrics WHERE metric = 'ping' AND ts >= ?
    GROUP BY bucket ORDER BY bucket ASC`).all(bucketSec * 1000, bucketSec * 1000, from);
  return rows.map((r) => ({ ts: r.bucket, pct: r.n ? Math.round((100 * r.up) / r.n * 10) / 10 : null, samples: r.n }));
}

export function prune(retentionDays = 30) {
  if (!stmts) initMetrics();
  const cutoff = Date.now() - retentionDays * 86400 * 1000;
  stmts.pruneMetrics.run(cutoff);
  stmts.pruneEvents.run(cutoff);
}
