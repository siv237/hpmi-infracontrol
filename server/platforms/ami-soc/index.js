// Модуль платформы ami-soc (Fujitsu iRMC S4, AMI/SOC, IVTP).
// Реализация контрактов ядра: probe / login / createConsole / createMedia.
// Весь платформенный код S4 живёт в этой папке. Канон пикселей: 0x00RRGGBB.
import probes from './probe.js';
import manifest from './manifest.js';
import login from './login.js';
import { IvtpClient } from './console-ivtp.js';
import { S4Cmdir } from './s4cmdir.js';

const DBG = () => process.env.IRMC_DEBUG === '1';

export default {
  // Определение платформы по сигнатуре веб-сервера BMC.
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

  // Консоль IVTP (видео+HID). Приводим события движка к канону ядра:
  // onStatus('live'), onFrame(fb, rects). IVTP-кадр всегда полный экран.
  createConsole(sessionCfg, events, sdk) {
    return new IvtpClient({ ...sessionCfg }, {
      onStatus: (s) => {
        if (DBG()) console.log('[ivtp]', s);
        if (s === 'session:valid') events.onStatus?.('live');
        else events.onStatus?.(s);
      },
      onError: (e) => events.onError?.(e),
      onExit: () => events.onExit?.(),
      onFrame: (fb) => {
        if (fb.width > 0 && fb.height > 0) {
          events.onFrame?.(fb, [{ x: 0, y: 0, w: fb.width, h: fb.height }]);
        }
      },
    });
  },

  // Виртуальный носитель S4: HTTP-Connect CDMEDIA + IUSB-SCSI.
  createMedia(sessionCfg, { isoPath }, sdk) {
    return new S4Cmdir({
      host: sessionCfg.host, username: sessionCfg.username,
      kvmtoken: sessionCfg.kvmtoken || '', webcookie: sessionCfg.webcookie || '',
      kvmPort: sessionCfg.kvmPort || 80, kvmSecure: !!sessionCfg.kvmSecure,
      webSecurePort: sessionCfg.webSecurePort || 443,
      isoPath, cdnum: 0,
    }, {
      onStatus: (s) => { if (DBG()) console.log('[cdmedia]', s); },
      onError: (e) => { if (DBG()) console.log('[cdmedia] ERR:', e); },
      onExit: () => { if (DBG()) console.log('[cdmedia] exit'); },
      onRaw: (f) => { if (DBG()) console.log('[cdmedia] rx', f.length, f.toString('hex')); },
    });
  },
};
