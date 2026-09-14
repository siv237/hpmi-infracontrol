// Платформа HP Lights-Out 100 / LO100i (ProLiant G5/G6) — Avocent/Mahogany AVR.
// Тот же протокол, что у Fujitsu iRMC S2 (общий движок server/sdk/avr/irmc.js),
// но: сигнатура embedded 0x5A5A5A5A, паддинги кредов 16/20/128, httpdata —
// одноразовый токен из kvms.html (а не пароль), KVM-порт = NonSecure_KVMPort.
export default {
  id: 'hp-lo100',
  title: 'HP Lights-Out 100 / LO100i (ProLiant G5/G6)',
  vendor: 'HP',
  family: 'LO100 / LO100i',
  sdk: 1,
  priority: 90,
  supported: [
    { model: 'ProLiant DL/ML/SL G5 (LO100)', firmware: '*', status: 'experimental' },
    { model: 'ProLiant DL/ML/SL G6 (LO100i)', firmware: '4.22', status: 'verified' },
  ],
  access: {
    web:   { ports: [80], secure: [false] },   // HTTPS:443 у LO100 не вешаем — только HTTP:80
    ipmi:  { port: 623 },
    kvm:   { transport: 'raw-tcp', target: 'NonSecure_KVMPort', auth: 'httpdata (токен kvms.html, не пароль)' },
    login: 'digest (HTTP, realm = hostname)',
  },
  capabilities: {
    kvm: true,
    virtualMedia: [],   // LIBM2 в M2.JAR умеет ISO, но мост не реализован — не декларируем
    ipmi: { sensors: true, sel: true, chassis: true, fru: 'basic', lanPrint: true },
    inventory: { web: false, ipmi: true },
  },
  probes: ['web-title (BMC HTTP Server)', 'kvms-applet'],
};
