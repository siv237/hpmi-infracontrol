// Модуль платформы mahogany-avr (Fujitsu iRMC S2/S3, Avocent/Mahogany AVR).
// Контракты ядра: probe / login / createConsole / createMedia.
// Весь платформенный код S2 живёт в этой папке. Канон пикселей: 0x00RRGGBB
// (irmc-decode.js). Виртуальный носитель — нативный движок M2 (Avocent URS).
import probes from './probe.js';
import manifest from './manifest.js';
import login from './login.js';
import { IrmcClient } from './irmc.js';
import * as m2 from './m2.js';

const DBG = () => process.env.IRMC_DEBUG === '1';

export default {
  async probe(cfg, sdk) {
    for (const name of manifest.probes || []) {
      const fn = probes[name];
      if (!fn) continue;
      try {
        const r = await fn(cfg, sdk);
        if (r && r.matched) return r;
      } catch (e) { sdk?.log?.(`[${manifest.id}] probe ${name}: ${e.message}`); }
    }
    return { matched: false, confidence: 0 };
  },

  login,

  // Консоль AVR (видео+HID). События движка приводим к канону ядра:
  // onStatus('live') на 'vesa:*', onFrame(fb, rects) как есть.
  createConsole(sessionCfg, events, sdk) {
    return new IrmcClient(sessionCfg, {
      onStatus: (s) => {
        if (DBG()) console.log('[irmc]', s);
        if (typeof s === 'string' && s.startsWith('vesa:')) events.onStatus?.('live');
        else events.onStatus?.(s);
      },
      onError: (e) => events.onError?.(e),
      onExit: () => events.onExit?.(),
      onFrame: (fb, rects) => events.onFrame?.(fb, rects),
    });
  },

  // Виртуальный носитель S2: нативный Avocent-URS (M2). Обёртка в единый
  // контракт MediaRedirector (start/close/stats) + cfg.host для [24].
  createMedia(sessionCfg, { isoPath }, sdk) {
    const host = sessionCfg.host, port = sessionCfg.port || 80;
    return {
      cfg: { host },
      statsMeter: null,
      async start() { return m2.share({ host, port, sharePath: isoPath }); },
      close() { try { m2.unshare(); } catch {} },
      stats() { return m2.stats(); },
    };
  },
};
