// Fujitsu iRMC S4 — AMI/SOC (IVTP).
// ЗАГОТОВКА: код будет перенесён сюда по живому железу (console-ivtp.js,
// s4cmdir.js). Пока manifest описывает известные факты.
export default {
  id: 'ami-soc',
  title: 'Fujitsu iRMC S4 (AMI/SOC, IVTP)',
  vendor: 'Fujitsu',
  family: 'iRMC S4',
  sdk: 1,
  priority: 95,
  // Быстрая IPMI-подпись: Fujitsu Siemens iRMC S4 (productId 853, живой S4;
  // BMC fw у S4 отдаётся как 1.00, поэтому опираемся на productId).
  signatures: { ipmi: { manufacturer: 'Fujitsu Siemens', productIds: [853] } },
  supported: [
    { model: 'iRMC S4', firmware: '7.69F', status: 'verified' },
    { model: 'iRMC S4', firmware: '7.*',   status: 'experimental' },
  ],
  access: {
    web:   { ports: [80, 443], secure: [false, true] },
    ipmi:  { port: 623 },
    kvm:   { transport: 'http-connect-tunnel', target: 443, auth: 'webcookie+kvmtoken' },
    media: { transport: 'http-connect-tunnel', service: 'CDMEDIA' },
    login: 'digest-post-form',
  },
  capabilities: {
    kvm: true,
    virtualMedia: ['cd', 'dvd'],
    ipmi: { sensors: true, sel: true, chassis: true, fru: 'basic', lanPrint: true },
    inventory: { web: false, ipmi: true },
  },
  probes: ['web-signature', 'jnlp-args'],
};
