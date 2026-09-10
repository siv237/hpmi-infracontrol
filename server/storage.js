// Состояние монтирования ISO (п.10.4/10.5): serverId -> {isoId, isoName,
// ts, by}. Хранится в data/storage.json (вне git) — это НЕ IPMI-сбор,
// а операционное состояние приложения, поэтому остаётся в JSON и НЕ
// попадает под инвариант «rm -rf data/db/ очищает весь сбор».
// События/снимки/версии переехали в SQLite (server/db.js, data/db/).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, '..', 'data', 'storage.json');

let db = { mounts: {} };
let loaded = false;

async function load() {
  if (loaded) return db;
  try { db = { mounts: {}, ...JSON.parse(await readFile(FILE, 'utf8')) }; } catch {}
  loaded = true;
  return db;
}

async function persist() {
  await mkdir(path.dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify({ mounts: db.mounts }, null, 2), { mode: 0o600 });
}

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
