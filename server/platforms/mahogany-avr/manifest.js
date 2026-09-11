// Fujitsu iRMC S2/S3 — Avocent/Mahogany (AVR).
// ЗАГОТОВКА: код будет перенесён сюда по живому железу (irmc.js, irmc-decode.js,
// m2.js, m2host.py, stor.js). Пока manifest описывает известные факты.
export default {
  id: 'mahogany-avr',
  title: 'Fujitsu iRMC S2/S3 (Avocent/Mahogany AVR)',
  vendor: 'Fujitsu',
  family: 'iRMC S2/S3',
  sdk: 1,
  priority: 100,
  supported: [
    { model: 'iRMC S2', firmware: '*', status: 'verified' },
    { model: 'iRMC S3/S3-2', firmware: '*', status: 'experimental' },
  ],
  access: {
    web:   { ports: [80, 443], secure: [false, true] },
    ipmi:  { port: 623 },
    kvm:   { transport: 'raw-tcp', target: 'VncPort', auth: 'httpdata+digest' },
    media: { transport: 'avocent-urs-m2', service: 'StoragePort 5901' },
    login: 'digest',
  },
  capabilities: {
    kvm: true,
    virtualMedia: ['cd'],
    ipmi: { sensors: true, sel: true, chassis: true, fru: 'basic', lanPrint: true },
    inventory: { web: true, ipmi: true },
  },
  probes: ['web-signature', 'avr-jnlp'],
};
