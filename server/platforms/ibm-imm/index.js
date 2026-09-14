// Платформа ibm-imm: probe-only. Веб-сигнатура IMM распознаётся; IPMI-опрос
// (SEL/FRU/lan print) идёт штатным ядром. KVM-консоль (Avocent IBM Custom,
// порт 3900) пока НЕ мостится (capabilities.kvm=false) — login/createConsole
// не реализованы, ядро за ними не пойдёт.
import * as probeMod from './probe.js';

export default {
  probe: probeMod.probe,
};
