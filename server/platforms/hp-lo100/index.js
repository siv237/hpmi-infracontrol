// Платформа hp-lo100: фасад. login — Digest + httpdata-токен kvms.html;
// createConsole — общий AVR-движок (server/sdk/avr/irmc.js) с паддингами HP
// (16/20/128) и токеном вместо пароля. События движка приводим к канону ядра:
// onStatus('live') при получении видео-режима.
import { IrmcClient } from './avr/irmc.js';
import * as probeMod from './probe.js';
import login from './login.js';

const DBG = () => process.env.IRMC_DEBUG === '1';

export default {
  probe: probeMod.probe,
  login,

  // sessionCfg — результат login() ({ host, kvmPort, httpdata, kvmSecure, ... }).
  // Возвращает НЕ запущенный движок — ядро зовёт cli.start().
  createConsole(sessionCfg, events, sdk) {
    const cli = new IrmcClient({
      host: sessionCfg.host,                  // адрес BMC (из login)
      port: sessionCfg.kvmPort,               // NonSecure_KVMPort
      secure: sessionCfg.kvmSecure,           // SSL-флаг KVM-порта (не веб!)
      username: sessionCfg.username,
      password: sessionCfg.password,
      httpdata: sessionCfg.httpdata,          // одноразовый токен kvms.html
      pad: { user: 16, pass: 20, full: 128 }, // HP LO100i
    }, {
      onStatus: (s) => {
        if (DBG()) console.log('[hp-lo100]', s);
        if (typeof s === 'string' && s.startsWith('vesa:')) events.onStatus?.('live');
        else events.onStatus?.(s);
      },
      onError: (e) => events.onError?.(e),
      onExit: () => events.onExit?.(),
      onFrame: (fb, rects) => events.onFrame?.(fb, rects),
    });
    return cli;
  },
};
