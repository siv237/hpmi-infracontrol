// Хранилище пользователей (редактор «Пользователи»).
// Пароли хранятся шифрованно так же, как креды серверов: AES-256-GCM
// (общий crypto-box, ключ data/key.bin) — в блобе {iv,tag,data}, наружу
// не возвращаются (только флаг hasPassword). Смена пароля — через
// updateUser({password}).
// Роли: admin (создаёт пользователей, управляет серверами) и user
// (только просмотр добавленного). Гранулярных ограничений нет;
// аутентификации в приложении ещё нет — личность выбирается в интерфейсе
// (заголовок X-Acting-User), при переключении запрашивается пароль.

import crypto from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getKey, encrypt, decrypt } from './crypto-box.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

// Ролевые шаблоны. Используются и валидацией, и фронтом.
export const ROLES = {
  admin: 'Администратор',
  user: 'Пользователь',
};

function encryptPass(pw) {
  return encrypt({ password: String(pw) });
}

// Постоянное сравнение (без утечки по времени) через дайджесты
function equalSecret(a, b) {
  const ha = crypto.createHash('sha256').update(String(a), 'utf8').digest();
  const hb = crypto.createHash('sha256').update(String(b), 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
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

// При первом запуске — два аккаунта: администратор (admin/admin) и
// пользователь (user/user). Пароли сразу в шифрованном блобе.
async function ensureDb() {
  let db = await readDb();
  if (db) return db;
  await getKey();
  const now = new Date().toISOString();
  db = [
    { id: crypto.randomUUID(), login: 'admin', name: 'Администратор', role: 'admin', enabled: true, pass: encryptPass('admin'), createdAt: now },
    { id: crypto.randomUUID(), login: 'user', name: 'Пользователь', role: 'user', enabled: true, pass: encryptPass('user'), createdAt: now },
  ];
  await writeDb(db);
  return db;
}

export async function listUsers() {
  await getKey();
  const db = await ensureDb();
  return db.map(mask);
}

export async function saveUser({ login, name, role, enabled, password }) {
  await getKey();
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
    pass: password ? encryptPass(password) : null,
    createdAt: new Date().toISOString(),
  };
  db.push(u);
  await writeDb(db);
  return mask(u);
}

export async function updateUser(id, patch) {
  await getKey();
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
  if (patch.password) u.pass = encryptPass(patch.password);
  await writeDb(db);
  return mask(u);
}

export async function deleteUser(id, actingId) {
  await getKey();
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

// Проверка пароля по id (используется входом). Учётка без пароля не
// считается защищённой — verify вернёт false только при неверном пароле.
export async function verifyPassword(userId, plain) {
  await getKey();
  const db = await ensureDb();
  const u = db.find((x) => x.id === userId);
  if (!u) return false;
  if (!u.pass) return equalSecret('', plain ?? '');
  const dec = decrypt(u.pass);
  return equalSecret(dec.password ?? '', plain ?? '');
}

// Поиск по логину (для страницы входа) — маска без секретов.
export async function findByLogin(login) {
  await getKey();
  const db = await ensureDb();
  const u = db.find((x) => x.login.toLowerCase() === String(login || '').trim().toLowerCase());
  return u ? mask(u) : null;
}

// Смена пароля самим пользователем: проверяем текущий (если установлен),
// новый — обязателен и не короче 3 символов.
export async function updatePassword(userId, current, next) {
  await getKey();
  const db = await ensureDb();
  const u = db.find((x) => x.id === userId);
  if (!u) return { ok: false, error: 'not found' };
  if (u.pass) {
    const dec = decrypt(u.pass);
    if (!equalSecret(dec.password ?? '', current ?? '')) return { ok: false, error: 'Текущий пароль указан неверно' };
  }
  if (!next || String(next).length < 3) return { ok: false, error: 'Пароль слишком короткий (минимум 3 символа)' };
  u.pass = encryptPass(next);
  await writeDb(db);
  return { ok: true };
}
