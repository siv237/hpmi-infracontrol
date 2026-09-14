// Платформа IBM System x — Integrated Management Module (IMM/IMM2).
// BMC IBM: веб на HTTPS:443 (Dojo-UI «imm»), IPMI 2.0 (RMCP+) работает.
// Консоль — IBM Custom Avocent KVM (не VNC, не Mahogany): JNLP
// viewer(<host>@443@…@jnlp@<user>@…).jnlp, приложение
// com.avocent.ibmc.kvm.Main, KVM-порт 3900 (kmport/vport). Токен сессии —
// hex в аргументе user (=…). Мост консоли пока НЕ реализован (probe-only).
export default {
  id: 'ibm-imm',
  title: 'IBM System x Integrated Management Module (IMM/IMM2)',
  vendor: 'IBM',
  family: 'IMM / IMM2 (Avocent KVM)',
  sdk: 1,
  // 92: ниже Fujitsu (100/95) и hp-ilo (94), выше hp-lo100 (90) —
  // IBM-пробы не идут раньше фуджитсовых.
  priority: 92,
  // Быстрая IPMI-подпись: IBM eServer X (IMM, productId 324).
  signatures: { ipmi: { manufacturer: 'IBM' } },
  supported: [
    { model: 'System x / BladeCenter (IMM2, Avocent KVM)', firmware: '8.41', status: 'experimental' },
  ],
  access: {
    web:   { ports: [443], secure: [true] },   // HTTP:80 не отвечает по HTTP
    ipmi:  { port: 623 },
    kvm:   { transport: 'avocent-ibmc', target: 3900, auth: 'jnlp token (user=0x…, из remote-control.php)' },
    media: { transport: 'avocent-vm', service: 'JNLP vm=1 (порт 3900)' },
    login: 'form (IMM web) -> JNLP viewer(...).jnlp',
  },
  capabilities: {
    kvm: false,          // Avocent IBM Custom (порт 3900) ещё не разобран — мост в планах
    virtualMedia: [],    // в JNLP vm=1 (виртуальный носитель есть), мост не реализован
    // Наблюдения живого BMC (fw 8.41): SEL — 35 событий; SDR-сенсоры (темп./кулеры)
    // не отдались (temps=0/fans=0), power по chassis — null. FRU — baseboard.
    ipmi: { sensors: false, sel: true, chassis: false, fru: 'basic', lanPrint: true },
    inventory: { web: false, ipmi: true },
  },
  probes: ['imm-web-signature'],
};
