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

// Быстрое сопоставление по IPMI-сигнатуре (manufacturer/productId), если
// модуль объявил manifest.signatures.ipmi. Это «дешёвая» стадия до веб-проб
// (веб у legacy BMC может виснуть). Возвращает { ...mod, probe } или null.
export async function matchPlatformByIpmi(ipmiId, sdk) {
  if (!ipmiId) return null;
  const mods = await loadPlatforms();
  const mfg = String(ipmiId.manufacturer || '');
  const pid = Number(ipmiId.productId) || null;
  for (const m of mods) {
    const sig = m.manifest?.signatures?.ipmi;
    if (!sig) continue;
    let ok = true;
    if (sig.manufacturer) {
      const re = sig.manufacturer instanceof RegExp ? sig.manufacturer : new RegExp(sig.manufacturer, 'i');
      if (!re.test(mfg)) ok = false;
    }
    if (ok && Array.isArray(sig.productIds) && sig.productIds.length) {
      if (!pid || !sig.productIds.includes(pid)) ok = false;
    }
    if (ok && sig.firmwareMajor) {
      const fwmaj = Number(String(ipmiId.bmcFirmware || '').split('.')[0]) || 0;
      if (fwmaj !== sig.firmwareMajor) ok = false;
    }
    if (ok) return { ...m, probe: { matched: true, confidence: 0.9, info: { via: 'ipmi', manufacturer: mfg, productId: pid } } };
  }
  return null;
}

export async function listPlatforms() {
  const mods = await loadPlatforms();
  return mods.map(({ manifest, dir, impl }) => ({
    id: manifest.id, dir, title: manifest.title, vendor: manifest.vendor || '',
    family: manifest.family || '', priority: manifest.priority, sdk: manifest.sdk,
    supported: manifest.supported || [], capabilities: manifest.capabilities || {},
    access: manifest.access || {}, probes: manifest.probes || [],
    loaded: !!impl,
    hasConsole: !!(impl && typeof impl.createConsole === 'function'),
    hasMedia: !!(impl && typeof impl.createMedia === 'function'),
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
