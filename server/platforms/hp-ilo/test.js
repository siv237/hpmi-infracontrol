// Самотест модуля hp-ilo (без сети): матч-функции проб + чистые парсеры
// Redfish на фикстурах живого iLO 4 fw 2.80.
// Запуск: node --test server/platforms/hp-ilo/test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { matchIloWeb, matchIloRedfish } from './probe.js';
import { parseThermal, parsePower, parseSystem, parseImlEntry } from './redfish.js';

const ILO4_ROOT = `<html><head><title>HP Integrated Lights-Out 4</title></head>
<body class="EOV-GUI"><div id="RpPageHeader">Hewlett Packard Enterprise</div></body></html>`;
const ILO_REDFISH = `{"Name":"HP RESTful Root Service","Oem":{"Hp":{"Moniker":"iLO4"}}}`;
const LO100_ROOT = `<html><head><title>BMC HTTP Server</title></head><body>Avocent</body></html>`;

test('hp-ilo: матч веб-оболочки и Redfish-корня, НЕ матчит LO100', () => {
  assert.equal(matchIloWeb(200, ILO4_ROOT), true);
  assert.equal(matchIloWeb(401, ILO4_ROOT), false);
  assert.equal(matchIloWeb(200, LO100_ROOT), false);
  assert.equal(matchIloRedfish(200, ILO_REDFISH), true);
  assert.equal(matchIloRedfish(200, '{"Name":"unknown"}'), false);
});

const THERMAL = {
  Temperatures: [
    { Name: '01-Inlet Ambient', ReadingCelsius: 18, Status: { Health: 'OK', State: 'Enabled' } },
    { Name: '02-CPU 1', ReadingCelsius: 40, Status: { Health: 'OK', State: 'Enabled' } },
    { Name: '05-P1 DIMM 4-6', ReadingCelsius: 0, Status: { Health: 'OK', State: 'Absent' } },
    { Name: '28-PCI 1', ReadingCelsius: null, Status: { State: 'Absent' } },
  ],
  Fans: [
    { FanName: 'Fan 1', CurrentReading: 19, Units: 'Percent', Status: { Health: 'OK', State: 'Enabled' } },
    { FanName: 'Fan 3', CurrentReading: null, Units: 'Percent', Status: { State: 'Absent' } },
  ],
};

test('hp-ilo.redfish.parseThermal: Absent пропускаются, units тащатся', () => {
  const { temps, fans } = parseThermal(THERMAL);
  assert.equal(temps.length, 2);
  assert.deepEqual(temps[0], { name: '01-Inlet Ambient', value: 18 });
  assert.equal(fans.length, 1);
  assert.deepEqual(fans[0], { name: 'Fan 1', value: 19, units: 'Percent' });
  assert.deepEqual(parseThermal(null), { temps: [], fans: [] });
});

test('hp-ilo.redfish.parsePower: ватты из PowerControl[0]', () => {
  assert.deepEqual(parsePower({ PowerControl: [{ PowerConsumedWatts: 210, PowerCapacityWatts: 1200 }] }), { powerWatts: 210, capacityWatts: 1200 });
  assert.equal(parsePower(null), null);
});

test('hp-ilo.redfish.parseSystem: тримминг серийника, PowerState -> on', () => {
  const s = parseSystem({ Model: 'ProLiant DL380p Gen8', SerialNumber: 'CZ2408009L      ', SKU: '653200-B21      ', BIOSVersion: 'P69: v1.20', PowerState: 'On', Status: { Health: 'OK' } });
  assert.equal(s.model, 'ProLiant DL380p Gen8');
  assert.equal(s.serial, 'CZ2408009L');
  assert.equal(s.sku, '653200-B21');
  assert.equal(s.power, 'on');
  assert.equal(parseSystem(null), null);
});

test('hp-ilo.redfish.parseImlEntry: канон recordPoll + категория', () => {
  const ev = parseImlEntry({ RecordId: 84, Created: '2026-09-09T02:31:00Z', Message: 'Drive Array Accelerator battery low', Severity: 'Warning' });
  assert.equal(ev.id, 'iml-84');
  assert.equal(ev.level, 'warning');
  assert.equal(ev.category, 'storage');
  assert.equal(parseImlEntry(null), null);
});
