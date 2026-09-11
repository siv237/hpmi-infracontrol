// Реестр модулей платформ: САМ сканирует server/platforms/, читает manifest.js
// каждого модуля, подгружает index.js и сортирует по priority. Ядро не знает
// конкретных платформ — только вызывает объявленные контракты.
//
// Загрузка изолирована: ошибка одного модуля логируется и не роняет остальные.
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SDK_VERSION } from './contracts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLATFORMS_DIR = path.join(__dirname, '..', 'platforms');

let cache = null;

// Скан папки модулей. Служебные (_template, .*) пропускаются.
export async function loadPlatforms({ force = false } = {}) {
  if (cache && !force) return cache;
  const mods = [];
  let entries = [];
  try { entries = await readdir(PLATFORMS_DIR, { withFileTypes: true }); }
  catch { cache = []; return cache; }

  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('_') || e.name.startsWith('.')) continue;
    const dir = path.join(PLATFORMS_DIR, e.name);
    try {
      const { default: manifest } = await import(pathToFileURL(path.join(dir, 'manifest.js')).href);
      if (!manifest || !manifest.id) throw new Error('нет manifest.id');
      if ((manifest.sdk || 1) > SDK_VERSION) throw new Error(`требует sdk ${manifest.sdk} > ${SDK_VERSION}`);
      let impl = null;
      try { impl = (await import(pathToFileURL(path.join(dir, 'index.js')).href)).default; }
      catch (err) { if (err.code !== 'ERR_MODULE_NOT_FOUND') throw err; }
      mods.push({ manifest, impl, dir: e.name });
    } catch (err) {
      console.error(`[platforms] модуль «${e.name}» не загружен: ${err.message}`);
    }
  }
  mods.sort((a, b) => (b.manifest.priority || 0) - (a.manifest.priority || 0));
  cache = mods;
  return mods;
}

// Подбор платформы: пробегаем по priority, зовём probe(), первый matched.
// Явный override — если cfg.platform задан, берём его без проб.
export async function matchPlatform(cfg, sdk) {
  const mods = await loadPlatforms();
  if (cfg && cfg.platform) {
    const m = mods.find((x) => x.manifest.id === cfg.platform);
    if (m) return { ...m, probe: { matched: true, confidence: 1, info: { explicit: true } } };
  }
  for (const m of mods) {
    if (!m.impl || typeof m.impl.probe !== 'function') continue;
    try {
      const r = await m.impl.probe(cfg, sdk);
      if (r && r.matched) return { ...m, probe: r };
    } catch (e) {
      (sdk?.log || console.error)(`[platforms] probe ${m.manifest.id}: ${e.message}`);
    }
  }
  return null;
}

export async function listPlatforms() {
  const mods = await loadPlatforms();
  return mods.map(({ manifest, dir }) => ({
    id: manifest.id, dir, title: manifest.title, priority: manifest.priority,
    sdk: manifest.sdk, supported: manifest.supported, capabilities: manifest.capabilities,
    loaded: !!mods.find((m) => m.manifest.id === manifest.id).impl,
  }));
}

// CLI: node server/sdk/registry.js — показать найденные модули.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const list = await listPlatforms();
  console.log(`Платформы (${list.length}):`);
  for (const p of list) {
    const sup = (p.supported || []).map((s) => `${s.model} fw:${s.firmware} [${s.status}]`).join('; ');
    console.log(`- ${p.id} (${p.title}) priority=${p.priority} sdk=${p.sdk} impl=${p.loaded ? 'yes' : 'нет'}`);
    if (sup) console.log(`    supported: ${sup}`);
  }
}
