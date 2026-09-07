// Общий криптобокс: AES-256-GCM, ключ data/key.bin (mode 0600).
// Используется и для кредов серверов (store.js), и для паролей
// пользователей (users-store.js) — хранение одинаково шифрованное.

import crypto from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const KEY_FILE = path.join(DATA_DIR, 'key.bin');
const ALGO = 'aes-256-gcm';

let keyBuf = null;

export async function getKey() {
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

export function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, keyBuf, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString('base64'), tag: tag.toString('base64'), data: enc.toString('base64') };
}

export function decrypt(blob) {
  const iv = Buffer.from(blob.iv, 'base64');
  const tag = Buffer.from(blob.tag, 'base64');
  const data = Buffer.from(blob.data, 'base64');
  const decipher = crypto.createDecipheriv(ALGO, keyBuf, iv);
  decipher.setAuthTag(tag);
  const out = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(out.toString('utf8'));
}
