// Реестр модулей поддержки BMC (плагинная система, ROADMAP «Модульный стек
// BMC»). Каждый модуль описывает семейство/вендора/версию BMC и его
// особенности: какие протоколы и в каких вариантах поддерживаются.
//
// Цель: при добавлении сервера «пробник» определяет сигнатуру BMC и
// подбирает совместимый модуль; инвентарь/проверки не ломаются на
// незнакомых железках — деградируют с явным диагнозом.
//
// === КАК ДОБАВИТЬ МОДУЛЬ ===
// 1. Скопируйте шаблон-заготовку (ниже, kind:'template').
// 2. id — уникальный (vendor-family[-sub]), например 'fujitsu-irmc-s2'.
// 3. match() — по сигнатуре из probeBmcSignature(): верните true, если
//    сигнатура вашего железа. Порядок проверки — по priority (убыв.).
// 4. caps — честные возможности (см. CAP_* константы).
// 5. quirks — известные особенности/обходы (текстовые ключи, читаемые
//    человеком; конкретные обходы живут в соответствующих модулях кода
//    и ссылаются сюда по ключу).
// 6. Зарегистрируйте модуль в MODULES внизу файла. Тест: npm test.
// 7. Ведите учёт в wiki/knowledge/bmc-modules.md (что добавлено/статус).

// Возможности (caps) — что умеет связка «наш код + это BMC»:
export const CAP = {
  IPMI_LAN: 'ipmi-lan',        // RMCP+ опрос (сенсоры/SEL/chassis)
  WEB_DIGEST: 'web-digest',   // веб-вход HTTP Digest (MD5, qop=auth)
  WEB_BASIC: 'web-basic',     // веб-вход HTTP Basic
  WEB_FORM: 'web-form',       // веб-вход формой (POST login.cgi и т.п.)
  WEB_INVENTORY: 'web-inventory', // инвентарь со страниц веба (FRU-подобный)
  KVM_AVR: 'kvm-avr',         // KVM-консоль протоколом AVR (Mahogany)
  KVM_VNC: 'kvm-vnc',         // KVM-консоль родным VNC
  ISO_M2: 'iso-m2',           // проброс ISO через движок M2 (StoragePort)
  TLS_LEGACY: 'tls-legacy',   // старый TLS (v1, SHA1) для HTTPS BMC
};

const MODULES = [
  {
    id: 'fujitsu-irmc-s2',
    title: 'Fujitsu iRMC S2 (ServerView)',
    priority: 100,
    match: (sig) => /iRMC\s*S2/i.test(sig.realm || '') || /iRMC\s*S2/i.test(sig.title || ''),
    caps: [CAP.IPMI_LAN, CAP.WEB_DIGEST, CAP.WEB_INVENTORY, CAP.KVM_AVR, CAP.ISO_M2, CAP.TLS_LEGACY],
    quirks: [
      'веб только HTTP:80 — HTTPS:443 вешает BMC (legacy renegotiation)',
      'Digest-логин извне иногда виснет (одноразовый nonce) — повтор',
      'одна активная KVM-сессия: чистый ClientDisconnect(0xd8) обязателен',
      'веб-сессия httpdata истекает — брать свежую перед AVR',
    ],
  },
  {
    id: 'fujitsu-irmc-s4',
    title: 'Fujitsu iRMC S4 (ServerView, Fw 7.x)',
    priority: 95,
    match: (sig) => /iRMC\s*S4/i.test(sig.realm || '') || /iRMC\s*S4/i.test(sig.title || ''),
    caps: [CAP.IPMI_LAN, CAP.WEB_DIGEST, CAP.KVM_AVR, CAP.ISO_M2, CAP.TLS_LEGACY],
    quirks: [
      'веб на «/» 302-редиректит на /login, GET отдаёт форму-триггер (не 401)',
      'Digest-челлендж прячется за POST /login APPLY=99 — креды так проверяются',
      'Digest-вход НЕ создаёт веб-сессию: страницы контента всё равно «Login required» — реальный вход формой (POST creds), веб-инвентарь пока не собирается (IPMI-инвентарь жив)',
      'инвентарь/вебка: использовать IPMI (FRU/lan print) до реализации form-входа',
    ],
  },
  {
    id: 'fujitsu-irmc-s3plus',
    title: 'Fujitsu iRMC S3/S3-2 (ServerView)',
    priority: 90,
    match: (sig) => /iRMC\s*(S3|Advanced)/i.test(sig.realm || '') || /iRMC/i.test(sig.realm || ''),
    caps: [CAP.IPMI_LAN, CAP.WEB_DIGEST, CAP.WEB_INVENTORY, CAP.KVM_AVR, CAP.ISO_M2, CAP.TLS_LEGACY],
    quirks: [
      'веб на «/» отвечает 302-редиректом (http→https или на login), не 401 — следовать за редиректом',
      'Digest обычно стабилен; HTTPS штатно работает',
    ],
  },
  {
    id: 'generic-ipmi',
    title: 'Generic IPMI 2.0 (без известного веба)',
    priority: 10,
    match: () => true, // fallback: IPMI отвечает, веб неизвестен/отсутствует
    caps: [CAP.IPMI_LAN],
    quirks: [
      'веб-интерфейс не распознан — только IPMI-опрос (сенсоры/SEL)',
      'инвентарь ограничен FRU из IPMI',
    ],
  },
];

// Подбор модуля по сигнатуре (probeBmcSignature из check-диагностики).
// Возвращает {module, matched:boolean} — fallback generic-ipmi если
// ничего не подошло.
export function matchBmcModule(sig) {
  const sorted = [...MODULES].sort((a, b) => (b.priority || 0) - (a.priority || 0));
  for (const m of sorted) {
    try { if (m.match(sig)) return { module: m, matched: m.id !== 'generic-ipmi' }; } catch {}
  }
  return { module: MODULES.find((m) => m.id === 'generic-ipmi'), matched: false };
}

export function listBmcModules() {
  return MODULES.map(({ id, title, priority, caps, quirks }) => ({ id, title, priority, caps, quirks }));
}
