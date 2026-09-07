// Хранилище данных IPMI: last-known снимки инвентаря, журнал изменений
// конфигурации, события подключений и история версий оборудования.
// Файл data/storage.json — вне git. (Слой A, безопасно: никакого
// фонового мониторинга — данные снимаются ТОЛЬКО по факту подключения.)

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, '..', 'data', 'storage.json');
const LEGACY_LASTKNOWN = path.join(__dirname, '..', 'data', 'last-known.json');

const KEY_FIELDS = ['System Type', 'Chassis Type', 'Serial', 'System GUID', 'BIOS Version', 'System Name', 'System O/S', 'System IP'];
const VERSION_FIELDS = ['BIOS Version', 'Firmware Revision', 'iRMC Version', 'iRMC Firmware', 'OEM', 'System O/S', 'OS Version', 'System Name', 'Serial', 'System GUID'];
const CHANGES_LIMIT = 1000;
const EVENTS_LIMIT = 500;
const VERSIONS_LIMIT = 200;

let db = { lastKnown: {}, changes: [], events: [], versions: {}, mounts: {} };
let loaded = false;

async function load() {
  if (loaded) return db;
  try { db = { lastKnown: {}, changes: [], events: [], versions: {}, mounts: {}, ...JSON.parse(await readFile(FILE, 'utf8')) }; } catch {}
  if (!Object.keys(db.lastKnown).length) {
    try {
      const old = JSON.parse(await readFile(LEGACY_LASTKNOWN, 'utf8'));
      if (old && Object.keys(old).length) {
        db.lastKnown = Object.fromEntries(Object.entries(old).map(([id, v]) => [id, { ts: v.ts, inventory: v.inventory }]));
      }
    } catch {}
  }
  loaded = true;
  return db;
}

async function persist() {
  await mkdir(path.dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(db, null, 2), { mode: 0o600 });
}

// Сохранить снимок инвентаря; возвращает ключевые изменения конфигурации.
export async function saveSnapshot(serverId, inventory) {
  if (!inventory || !Object.keys(inventory).length) return { changes: [], skipped: 'empty inventory' };
  await load();
  const prev = db.lastKnown[serverId];
  const ts = new Date().toISOString();
  const changes = [];
  if (prev && prev.inventory && Object.keys(prev.inventory).length) {
    for (const f of KEY_FIELDS) {
      const a = String(prev.inventory[f] ?? ''), b = String(inventory[f] ?? '');
      if (a !== b) changes.push({ field: f, from: a || '—', to: b || '—', ts });
    }
  }
  db.lastKnown[serverId] = { ts, inventory };
  for (const c of changes) db.changes.push({ serverId, ...c });
  if (db.changes.length > CHANGES_LIMIT) db.changes = db.changes.slice(-CHANGES_LIMIT);
  await persist();
  return { changes };
}

export async function getLastKnown(serverId) {
  const d = await load();
  return d.lastKnown[serverId] || null;
}

export async function getChanges(serverId, limit = 100) {
  const d = await load();
  const list = d.changes.filter((c) => !serverId || c.serverId === serverId);
  return list.slice(-limit).reverse();
}

// Событие подключения/обновления данных
export async function addEvent(kind, text, serverId = null, ts = new Date().toISOString()) {
  const d = await load();
  d.events.push({ ts, serverId, kind, text });
  if (d.events.length > EVENTS_LIMIT) d.events = d.events.slice(-EVENTS_LIMIT);
  await persist();
}

export async function getEvents(limit = 100, serverId = null) {
  const d = await load();
  let list = serverId ? d.events.filter((e) => e.serverId === serverId) : d.events;
  return list.slice(-limit).reverse();
}

// Снимок версий оборудования при фактическом подключении (timeline)
export async function recordVersionSnapshot(serverId, inventory, by = null, ts = new Date().toISOString()) {
  if (!inventory || !Object.keys(inventory).length) return;
  const d = await load();
  const pick = {};
  for (const f of VERSION_FIELDS) {
    const v = String(inventory[f] ?? '').trim();
    if (v) pick[f] = v;
  }
  if (!Object.keys(pick).length) return;
  if (!Array.isArray(d.versions[serverId])) d.versions[serverId] = [];
  d.versions[serverId].push({ ts, by: by || null, versions: pick });
  if (d.versions[serverId].length > VERSIONS_LIMIT) d.versions[serverId] = d.versions[serverId].slice(-VERSIONS_LIMIT);
  await persist();
}

export async function getVersions(serverId, limit = 50) {
  const d = await load();
  const list = d.versions[serverId] || [];
  return list.slice(-limit).reverse();
}

// === Монтирование ISO (п.10.4/10.5): состояние «примонтированный образ» ===
// Стабильное: хранится на сервере, переживает F5. Поле mounts: serverId -> {isoId, isoName, ts, by}
export async function getMounts() {
  const d = await load();
  return d.mounts;
}
export async function getMount(serverId) {
  const d = await load();
  return d.mounts[serverId] || null;
}
export async function setMount(serverId, iso, by = null) {
  const d = await load();
  d.mounts[serverId] = { isoId: iso.id, isoName: iso.name, ts: new Date().toISOString(), by: by || null };
  await persist();
  return d.mounts[serverId];
}
export async function clearMount(serverId) {
  const d = await load();
  if (!d.mounts[serverId]) return false;
  delete d.mounts[serverId];
  await persist();
  return true;
}
