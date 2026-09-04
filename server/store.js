// Encrypted at-rest storage for saved iRMC servers.
// Credentials are encrypted with AES-256-GCM; the key lives in data/key.bin
// (created on first run with mode 0600). Meta (id/name) stays in plaintext for
// listing; the connection details are encrypted.

import crypto from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const KEY_FILE = path.join(DATA_DIR, 'key.bin');
const DB_FILE = path.join(DATA_DIR, 'servers.json');
const ALGO = 'aes-256-gcm';

let keyBuf = null;

async function getKey() {
  if (keyBuf) return keyBuf;
  await mkdir(DATA_DIR, { recursive: true });
  try {
    keyBuf = await readFile(KEY_FILE);
    if (keyBuf.length !== 32) throw new Error('bad key length');
  } catch {
    keyBuf = crypto.randomBytes(32);
    await writeFile(KEY_FILE, keyBuf, { mode: 0o600 });
  }
  return keyBuf;
}

function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, keyBuf, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString('base64'), tag: tag.toString('base64'), data: enc.toString('base64') };
}

function decrypt(blob) {
  const iv = Buffer.from(blob.iv, 'base64');
  const tag = Buffer.from(blob.tag, 'base64');
  const data = Buffer.from(blob.data, 'base64');
  const decipher = crypto.createDecipheriv(ALGO, keyBuf, iv);
  decipher.setAuthTag(tag);
  const out = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(out.toString('utf8'));
}

async function readDb() {
  try {
    return JSON.parse(await readFile(DB_FILE, 'utf8'));
  } catch {
    return [];
  }
}
async function writeDb(arr) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(DB_FILE, JSON.stringify(arr, null, 2), { mode: 0o600 });
}

function mask(entry) {
  return {
    id: entry.id,
    name: entry.name,
    host: entry.host,
    username: entry.usernamePlain || '',
    port: entry.port,
    secure: entry.secure,
    hasPassword: !!(entry.enc),
    createdAt: entry.createdAt,
  };
}

export async function listServers(withSecrets = false) {
  await getKey();
  const db = await readDb();
  return db.map((e) => {
    if (withSecrets) {
      const dec = e.enc ? decrypt(e.enc) : { host: e.host || '', username: e.usernamePlain || '', password: '', httpdata: '' };
      return { ...dec, id: e.id, name: e.name, port: e.port, secure: e.secure, createdAt: e.createdAt };
    }
    return { ...mask(e) };
  });
}

export async function saveServer({ name, host, username, password, port = 80, secure = false, httpdata = '' }) {
  await getKey();
  const db = await readDb();
  const id = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
  const enc = encrypt({ host, username, password, httpdata });
  const entry = {
    id,
    name: name || host,
    host,
    usernamePlain: username,
    port,
    secure,
    enc,
    createdAt: new Date().toISOString(),
  };
  db.push(entry);
  await writeDb(db);
  return { id, name: entry.name, port, secure, createdAt: entry.createdAt };
}

export async function updateServer(id, patch) {
  await getKey();
  const db = await readDb();
  const e = db.find((x) => x.id === id);
  if (!e) return null;
  if (patch.port !== undefined) e.port = Number(patch.port);
  if (patch.secure !== undefined) e.secure = !!patch.secure;
  if (patch.name !== undefined) e.name = patch.name;
  if (patch.host !== undefined) { e.host = patch.host; }
  // optionally update creds if provided
  if (patch.username !== undefined || patch.password !== undefined || patch.httpdata !== undefined || patch.host !== undefined) {
    const dec = e.enc ? decrypt(e.enc) : { host: e.host, username: e.usernamePlain || '', password: '', httpdata: '' };
    const merged = {
      host: patch.host !== undefined ? patch.host : dec.host,
      username: patch.username !== undefined ? patch.username : dec.username,
      password: patch.password !== undefined ? patch.password : dec.password,
      httpdata: patch.httpdata !== undefined ? patch.httpdata : dec.httpdata,
    };
    e.enc = encrypt(merged);
    if (patch.username !== undefined) e.usernamePlain = patch.username;
  }
  await writeDb(db);
  return { id: e.id, name: e.name, port: e.port, secure: e.secure };
}

export async function deleteServer(id) {
  await getKey();
  const db = await readDb();
  const next = db.filter((e) => e.id !== id);
  await writeDb(next);
  return db.length !== next.length;
}

export async function getServer(id) {
  await getKey();
  const db = await readDb();
  const e = db.find((x) => x.id === id);
  if (!e) return null;
  const dec = e.enc ? decrypt(e.enc) : { host: e.host || '', username: e.usernamePlain || '', password: '', httpdata: '' };
  return { ...dec, id: e.id, name: e.name, port: e.port, secure: e.secure };
}
