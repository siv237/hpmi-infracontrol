// Реализация контрактов платформы. Ядро вызывает ТОЛЬКО эти методы.
// Реализуйте то, что объявлено в manifest.capabilities; остальное можно не
// делать (ядро отключит). Всё взаимодействие — через sdk (без внутренностей
// ядра). Канон пикселей: fb.pix = 0x00RRGGBB (R — старший байт).
import probes from './probe.js';
import manifest from './manifest.js';

export default {
  // 1) Определение: подходит ли модуль этому BMC.
  // cfg: { host, port, secure, username, password }
  // -> { matched: bool, confidence: 0..1, info: {...} }
  async probe(cfg, sdk) {
    for (const name of manifest.probes || []) {
      const fn = probes[name];
      if (!fn) continue;
      try {
        const r = await fn(cfg, sdk);
        if (r && r.matched) return r;
      } catch (e) { sdk.log(`[${manifest.id}] probe ${name}: ${e.message}`); }
    }
    return { matched: false, confidence: 0 };
  },

  // 2) Вход: КАК вводить креды (схема платформы). Креды даёт ядро.
  // -> sessionCfg (непрозрачно для ядра; ядро передаёт его в createConsole)
  async login(cfg, sdk) {
    throw new Error('login() не реализован');
  },

  // 3) Консоль видео+HID (обязателен при capabilities.kvm=true).
  // events: { onStatus, onFrame, onError, onExit }
  createConsole(sessionCfg, events, sdk) {
    throw new Error('createConsole() не реализован');
  },

  // 4) Виртуальный носитель (опционален).
  createMedia(sessionCfg, { isoPath }, sdk) {
    throw new Error('createMedia() не реализован');
  },
};
