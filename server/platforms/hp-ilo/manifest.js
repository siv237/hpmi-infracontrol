// Платформа HPE iLO 4/5 (ProLiant Gen8+) — распознавание + опрос по Redfish.
// Консоль iLO — протокол IRC/RC.go (не Avocent AVR), мост не реализован:
// платформа probe-only. Приоритет выше hp-lo100 (90): на iLO матчимся первыми
// и не даём LO100-модулю долбить iLO по kvms.html.
export default {
  id: 'hp-ilo',
  title: 'HPE iLO 4/5 (ProLiant Gen8+)',
  vendor: 'HPE',
  family: 'iLO 4 / iLO 5',
  sdk: 1,
  // 94: выше hp-lo100 (90), но НИЖЕ Fujitsu-платформ (mahogany-avr 100,
  // ami-soc 95) — HP-пробы не должны идти раньше фуджитсовых.
  priority: 94,
  supported: [
    { model: 'iLO 4 (ProLiant Gen8/Gen9)', firmware: '2.80', status: 'verified' },
    { model: 'iLO 5 (ProLiant Gen10+)', firmware: '*', status: 'experimental' },
  ],
  access: {
    web:   { ports: [80, 443], secure: [true] },   // http:80 отвечает 303 → https (путь сохраняется)
    ipmi:  { port: 623 },
    kvm:   { transport: 'irc', auth: 'session-key' }, // НЕ AVR — консоль не мостим
    redfish: { port: 443, secure: true, auth: 'basic' },
    login: 'digest (HTTPS) / Redfish (без Digest)',
  },
  capabilities: {
    kvm: false,          // IRC-консоль не мостим — честно декларируем
    virtualMedia: [],
    ipmi: { sensors: true, sel: true, chassis: true, fru: 'full', lanPrint: true },
    // Redfish: опрос сенсоров (Thermal), журнал IML, инвентарь (Systems/
    // Managers) — путь для железок с выключенным RMCP+ (живой iLO 4 baspx03).
    // Ядро при отказе IPMI пробует Redfish (server/redfish.js).
    redfish: { sensors: true, log: 'IML', inventory: true, auth: 'basic' },
    inventory: { web: true, ipmi: true, redfish: true },
  },
  probes: ['web-signature (EOV-GUI/RpPageHeader)', 'redfish Oem.Hp'],
};
