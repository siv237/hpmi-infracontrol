// Менеджер загрузки/хранения ISO-образов (п.10.2).
// Образы лежат на инфра-сервере в data/iso/ (вне git). Загрузка — стримом
// (файл не грузится в память). Мета — data/iso/.meta.json.

import { mkdir, readFile, writeFile, stat, rename as fsRename, unlink, readdir } from 'node:fs/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ISO_DIR = path.join(__dirname, '..', 'data', 'iso');
const META_FILE = path.join(ISO_DIR, '.meta.json');

let meta = {};

async function loadMeta() {
  try { meta = JSON.parse(await readFile(META_FILE, 'utf8')); } catch { meta = {}; }
}

async function saveMeta() {
  await mkdir(ISO_DIR, { recursive: true });
  await writeFile(META_FILE, JSON.stringify(meta, null, 2), { mode: 0o600 });
}

// Безопасное имя для хранения (сохраняем язык/подчёркивания, убираем пути)
function safeName(name) {
  const base = String(name || '').replace(/[\\/]/g, '_').trim();
  return base || 'unnamed.iso';
}

// Список образов (имя, размер, дата загрузки, id)
export async function listImages() {
  await loadMeta();
  const out = [];
  for (const [id, m] of Object.entries(meta)) {
    const file = path.join(ISO_DIR, id);
    let size = m.size;
    let ts = m.ts;
    try { const s = await stat(file); size = size || s.size; ts = ts || s.mtime.toISOString(); } catch { /* файл может быть удалён руками */ }
    out.push({ id, name: m.name, size, ts: ts || null });
  }
  out.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
  return out;
}

// Загрузка стримом из req: пишем в data/iso/<id> без хранения всего в памяти.
// Возвращает {id, name, size}. Вычислить точный размер можем по content-length
// или по статистике после записи.
export async function uploadStream(req, { name, signal }) {
  await loadMeta();
  const id = randomUUID();
  const filePath = path.join(ISO_DIR, id);
  const display = safeName(name);
  await mkdir(ISO_DIR, { recursive: true });
  const ws = createWriteStream(filePath);
  let size = 0;
  const onAbort = () => ws.destroy(new Error('upload aborted'));
  signal?.addEventListener('abort', onAbort);
  try {
    for await (const chunk of req) {
      if (ws.destroyed) throw new Error('write stream closed');
      if (!ws.write(chunk)) await new Promise((r) => ws.once('drain', r));
      size += chunk.length;
    }
    await new Promise((r, j) => ws.end(r), (e) => j(e));
  } catch (e) {
    ws.destroy();
    await unlink(filePath).catch(() => {});
    throw e;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  meta[id] = { name: display, size, ts: new Date().toISOString() };
  await saveMeta();
  return { id, name: display, size };
}

// Удалить образ
export async function deleteImage(id) {
  await loadMeta();
  const m = meta[id];
  if (!m) return false;
  await unlink(path.join(ISO_DIR, id)).catch(() => {});
  delete meta[id];
  await saveMeta();
  return true;
}

// Переименовать образ (display name)
export async function renameImage(id, newName) {
  await loadMeta();
  const m = meta[id];
  if (!m) return false;
  m.name = safeName(newName);
  await saveMeta();
  return m;
}

// Прочитать файл образа (read-only раздача) — возвращает {size, stream}
export async function openImage(id) {
  await loadMeta();
  const m = meta[id];
  if (!m) return null;
  const file = path.join(ISO_DIR, id);
  const s = await stat(file);
  return { meta: m, size: s.size, stream: createReadStream(file) };
}

// Абсолютный путь файла образа на диске (для движка монтирования M2)
export function isoPath(id) {
  return path.join(ISO_DIR, id);
}
