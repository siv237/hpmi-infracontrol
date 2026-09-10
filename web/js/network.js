// ---- Вкладка «Сеть» (BMC/IPMI): lan print + mc info из БД (п.4a) -------
// Данные собирает интервальный опрос (server/ipmi.js readNetwork -> БД),
// вкладка читает /api/ipmi/network — офлайн-доступен последний снимок.
const NET_ROWS = [
  ['IP-адрес BMC', 'ip', 'copy'],
  ['Маска подсети', 'subnet'],
  ['Шлюз по умолчанию', 'gateway'],
  ['MAC-адрес', 'mac', 'copy'],
  ['Источник адреса', 'ipSource', (v) => v === 'dhcp' ? 'DHCP' : (v === 'static' ? 'Статический' : v)],
  ['VLAN (802.1q)', 'vlan', (v) => v === null || v === '' ? '—' : v],
  ['Приоритет VLAN', 'vlanPriority'],
  ['SNMP community', 'snmp'],
  ['ARP-контроль BMC', 'bmcArp'],
  ['RMCP+ Cipher Suites', 'cipherSuites'],
  ['Прошивка BMC', 'bmcFirmware'],
  ['Версия IPMI', 'ipmiVersion'],
  ['Производитель BMC', 'manufacturer', (v) => `${v} (ID ${netRow('manufacturerId')})`],
  ['Product ID', 'productId'],
];

function netRow(k) {
  // для композитных значений (manufacturer) — достаём из текущего net
  const c = (typeof netCur === 'object' && netCur) || {};
  return String(c[k] ?? '');
}
let netCur = null;

function renderNetwork(net, ts) {
  netCur = net || {};
  const t = $('netTable');
  const info = $('netInfo');
  if (!t) return;
  const has = netCur && (netCur.ip || netCur.mac || netCur.bmcFirmware);
  if (!has) {
    t.innerHTML = '<tr><td class="v">Нет данных опроса</td></tr>';
    if (info) info.textContent = '';
    return;
  }
  let h = '';
  for (const [label, key, xform] of NET_ROWS) {
    let v = netCur[key];
    if (v === undefined || v === null || v === '') v = '—';
    else if (typeof xform === 'function') v = xform(v);
    const copyable = xform === 'copy' && v !== '—';
    h += '<tr><td class="k">' + label + '</td><td class="v">' + esc(v)
      + (copyable ? ' <a href="#" class="netcopy" data-v="' + esc(v) + '" title="Скопировать">⧉</a>' : '') + '</td></tr>';
  }
  t.innerHTML = h;
  if (info) info.textContent = ts ? ('· снимок ' + fmtDump(new Date(ts).toISOString())) : '';
  t.querySelectorAll('.netcopy').forEach(a => a.onclick = (e) => {
    e.preventDefault();
    try { navigator.clipboard.writeText(a.getAttribute('data-v')); snack('Скопировано: ' + a.getAttribute('data-v')); } catch {}
  });
}

async function loadNetwork(id) {
  if (!id) return;
  const j = await api('/api/ipmi/network?serverId=' + encodeURIComponent(id), { _noKick: true });
  if (id !== sel) return;
  if (!j || !j.ok || !j.net) {
    renderNetwork(null);
    return;
  }
  renderNetwork(j.net, j.ts);
}
