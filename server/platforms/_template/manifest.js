// ЕДИНЫЙ декларативный файл модуля платформы.
// Копируйте папку _template и заполните. Всё, что «поддерживаем», решается
// ЗДЕСЬ (список supported: модель + версия прошивки + статус проверки).
// Загружается server/sdk/registry.js при старте.
export default {
  id: 'vendor-family',                 // уникальный id (папка = id)
  title: 'Vendor Family (кратко)',      // человекочитаемо
  vendor: 'Vendor',
  family: 'Family',
  sdk: 1,                              // требуемая версия контрактов ядра
  priority: 50,                        // порядок проб, убыв.

  // СПИСОК ПОДДЕРЖКИ: конкретные модель + прошивка (+ статус).
  // Хочешь попробовать свою — добавь строку со status:'experimental'.
  supported: [
    { model: 'Model X', firmware: '1.00', status: 'experimental' },
  ],

  // ДОСТУП: порты и способы (явно). login — имя схемы, реализуемой в index.js.
  access: {
    web:   { ports: [80, 443], secure: [false, true] },
    ipmi:  { port: 623 },
    kvm:   { transport: 'raw-tcp', target: null },
    media: { transport: null, service: null },
    login: 'digest-post-form',
  },

  // ЧТО УМЕЕТ отдавать (точно). Примеры ключей — см. _template/index.js.
  capabilities: {
    kvm: false,
    virtualMedia: [],
    ipmi: { sensors: false, sel: false, chassis: false, fru: false, lanPrint: false },
    inventory: { web: false, ipmi: false },
  },

  // МЕТОДЫ ПРОБ (реализуются в probe.js этой папки; ядро вызывает по имени).
  probes: ['web-title'],
};
