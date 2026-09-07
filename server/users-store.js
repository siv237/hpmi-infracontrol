// Хранилище пользователей (редактор «Пользователи»).
// Пароли пользователей — ТОЛЬКО необратимый хэш: scrypt (соль + hash),
// расшифровка невозможна. (Шифруемые AES-блобом хранятся только креды
// серверов — server/store.js, им нужно расшифровываться для подключения.)
// Смена пароля — через updateUser({password}) / updatePassword().
// Роли: admin (создаёт пользователей, управляет серверами) и user
// (только просмотр добавленного). Аутентификация — по логину+паролю
// на /api/login; сессии в server/index.js.

import crypto from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

// Ролевые шаблоны. Используются и валидацией, и фронтом.
export const ROLES = {
  admin: 'Администратор',
  user: 'Пользователь',
};

// Необратимый хэш пароля: scrypt, случайная соль на пользователя.
function hashPass(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64);
  return { algo: 'scrypt', salt: salt.toString('hex'), hash: hash.toString('hex') };
}

// Постоянное сравнение (без утечки по времени) через дайджесты
function equalSecret(a, b) {
  const ha = crypto.createHash('sha256').update(String(a), 'utf8').digest();
  const hb = crypto.createHash('sha256').update(String(b), 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

function checkPass(stored, plain) {
  if (!stored || stored.algo !== 'scrypt') return false;
  const salt = Buffer.from(stored.salt, 'hex');
  const expect = Buffer.from(stored.hash, 'hex');
  const calc = crypto.scryptSync(String(plain ?? ''), salt, expect.length);
  return crypto.timingSafeEqual(calc, expect);
}

// Миграция старых записей (эксперимент: пароли в AES-блобах) -> scrypt.
// Расшифровка делается однократно только ради пере-хэширования; в хранилище
// после миграции остаётся лишь необратимый хэш. При ошибке расшифровки блоб
// НЕ трогаем (можно повторить позже), иначе пароль будет потерян.
function migrateLegacyPass(u, decryptLegacy) {
  const p = u.pass;
  if (p && typeof p === 'object' && p.iv && p.tag && p.data) {
    let dec;
    try { dec = decryptLegacy(p); } catch { return false; }
    u.pass = dec && dec.password ? hashPass(dec.password) : null;
    return true;
  }
  return false;
}

function mask(u) {
  return { id: u.id, login: u.login, name: u.name, role: u.role, enabled: !!u.enabled, hasPassword: !!u.pass, createdAt: u.createdAt };
}

async function readDb() {
  try { return JSON.parse(await readFile(USERS_FILE, 'utf8')); } catch { return null; }
}

async function writeDb(db) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(USERS_FILE, JSON.stringify(db, null, 2), { mode: 0o600 });
}

// При первом запуске — два аккаунта: администратор и пользователь
// (пароли задаёт инсталлер/владелец; здесь сиды для дев-окружения).
async function ensureDb() {
  let db = await readDb();
  if (db) return db;
  const now = new Date().toISOString();
  db = [
    { id: crypto.randomUUID(), login: 'admin', name: 'Администратор', role: 'admin', enabled: true, pass: hashPass('admin'), createdAt: now },
    { id: crypto.randomUUID(), login: 'user', name: 'Пользователь', role: 'user', enabled: true, pass: hashPass('user'), createdAt: now },
  ];
  await writeDb(db);
  return db;
}

// Разовая миграция старых AES-блобов паролей (если есть) в scrypt-хэши.
// decryptLegacy передаётся вызывающим (server/index.js) — users-store сам
// ничего не расшифровывает при обычной работе.
export async function migrateLegacy(decryptLegacy) {
  const db = await ensureDb();
  let changed = false;
  for (const u of db) if (migrateLegacyPass(u, decryptLegacy)) changed = true;
  if (changed) await writeDb(db);
}

export async function listUsers() {
  const db = await ensureDb();
  return db.map(mask);
}

export async function saveUser({ login, name, role, enabled, password }) {
  const db = await ensureDb();
  login = String(login || '').trim();
  if (!login) throw new Error('login required');
  if (db.some((u) => u.login.toLowerCase() === login.toLowerCase())) throw new Error('login already exists');
  if (role && !ROLES[role]) throw new Error('unknown role');
  const u = {
    id: crypto.randomUUID(),
    login,
    name: String(name || '').trim() || login,
    role: ROLES[role] ? role : 'user',
    enabled: enabled === undefined ? true : !!enabled,
    pass: password ? hashPass(password) : null,
    createdAt: new Date().toISOString(),
  };
  db.push(u);
  await writeDb(db);
  return mask(u);
}

export async function updateUser(id, patch) {
  const db = await ensureDb();
  const u = db.find((x) => x.id === id);
  if (!u) return null;
  if (patch.login !== undefined) {
    const login = String(patch.login).trim();
    if (!login) throw new Error('login required');
    if (db.some((x) => x.id !== id && x.login.toLowerCase() === login.toLowerCase())) throw new Error('login already exists');
    u.login = login;
  }
  if (patch.name !== undefined) u.name = String(patch.name).trim() || u.login;
  if (patch.role !== undefined) {
    if (!ROLES[patch.role]) throw new Error('unknown role');
    u.role = patch.role;
  }
  if (patch.enabled !== undefined) u.enabled = !!patch.enabled;
  if (patch.password) u.pass = hashPass(patch.password);
  await writeDb(db);
  return mask(u);
}

export async function deleteUser(id, actingId) {
  const db = await ensureDb();
  const u = db.find((x) => x.id === id);
  if (!u) return { ok: false, error: 'not found' };
  if (id === actingId) return { ok: false, error: 'нельзя удалить самого себя' };
  const next = db.filter((x) => x.id !== id);
  if (!next.length) return { ok: false, error: 'нельзя удалить последнего пользователя' };
  // последний активный администратор удалять нельзя
  if (u.role === 'admin' && u.enabled && !next.some((x) => x.role === 'admin' && x.enabled)) {
    return { ok: false, error: 'нельзя удалить последнего активного администратора' };
  }
  await writeDb(next);
  return { ok: true };
}

// Проверка пароля по логину (страница входа): только сравнение хэшей.
export async function verifyPasswordByLogin(login, plain) {
  const db = await ensureDb();
  const u = db.find((x) => x.login.toLowerCase() === String(login || '').trim().toLowerCase());
  if (!u || !u.pass) return null;
  return checkPass(u.pass, plain) ? u : null;
}

// Смена пароля самим пользователем: проверяем текущий, новый — обязателен
// и не короче 3 символов.
export async function updatePassword(userId, current, next) {
  const db = await ensureDb();
  const u = db.find((x) => x.id === userId);
  if (!u) return { ok: false, error: 'not found' };
  if (u.pass && !checkPass(u.pass, current ?? '')) return { ok: false, error: 'Текущий пароль указан неверно' };
  if (!next || String(next).length < 3) return { ok: false, error: 'Пароль слишком короткий (минимум 3 символа)' };
  u.pass = hashPass(next);
  await writeDb(db);
  return { ok: true };
}
