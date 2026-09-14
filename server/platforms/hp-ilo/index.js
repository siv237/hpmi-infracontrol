// Платформа hp-ilo: probe-only. Консоль IRC не мостим (capabilities.kvm=false),
// login/createConsole не реализуем — ядро не пойдёт сюда за консолью.
// Опрос сенсоров/журнала идёт по Redfish (server/redfish.js) — ядро включает
// фолбэк по capability redfish.
import * as probeMod from './probe.js';

export default {
  probe: probeMod.probe,
};
