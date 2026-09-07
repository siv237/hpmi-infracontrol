// Encrypted at-rest storage for saved iRMC servers.
// Credentials are encrypted with AES-256-GCM (shared crypto-box, key
// data/key.bin created on first run with mode 0600). Meta (id/name) stays in
// plaintext for listing; the connection details are encrypted.

import crypto from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getKey, encrypt, decrypt } from './crypto-box.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'servers.json');

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
