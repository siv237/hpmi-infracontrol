// Самотест модуля hp-lo100 (без сети): чистые матч-функции проб + профиль
// паддингов HP (16/20/128) в собственном AVR-движке модуля.
// Запуск: node --test server/platforms/hp-lo100/test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { matchLo100Root, matchLo100Kvms } from './probe.js';
import { IrmcClient } from './avr/irmc.js';

const LO100_ROOT = `<html><head><title>BMC HTTP Server</title></head>
<body>Avocent Lights-Out 100 Remote Console menu</body></html>`;

const LO100_KVMS = `<html><body>
<APPLET CODE="com.serverengines.mahogany.MahoganyViewer.class" ARCHIVE="M2.JAR">
<PARAM NAME="httpdata" VALUE="1a2b3c4d">
<PARAM NAME="NonSecure_KVMPort" VALUE="80">
<PARAM NAME="ipaddress" VALUE="192.168.6.51">
</APPLET></body></html>`;

const ILO_ROOT = `<html><head><title>HP Integrated Lights-Out 4</title></head>
<body class="EOV-GUI"><div id="RpPageHeader">Hewlett Packard Enterprise</div></body></html>`;

test('hp-lo100: матч по title BMC HTTP Server («/»)', () => {
  assert.equal(matchLo100Root(200, LO100_ROOT), true);
  assert.equal(matchLo100Root(401, LO100_ROOT), false);
  assert.equal(matchLo100Root(200, ILO_ROOT), false);
});

test('hp-lo100: матч по kvms.html (APPLET + httpdata)', () => {
  assert.equal(matchLo100Kvms(200, LO100_KVMS), true);
  assert.equal(matchLo100Kvms(200, '<APPLET CODE="X">'), false);
});

test('hp-lo100: профиль паддингов 16/20/128 (собственный движок модуля)', () => {
  const hp = new IrmcClient({ pad: { user: 16, pass: 20, full: 128 } });
  // 5*u32(20) + user16 + pass20 + config u32(4) + key(0) + passFull128 = 188
  assert.equal(hp.wire(0x5a5a5a5a, 'Administrator', 'token', 'token', '').length, 188);
  // Дефолт (без pad) — iRMC-профиль 48/48/228: 20 + 48 + 48 + 4 + 228 = 348
  const def = new IrmcClient({});
  assert.equal(def.wire(0x5a5a5a5a, 'Administrator', 'token', 'token', '').length, 348);
});
