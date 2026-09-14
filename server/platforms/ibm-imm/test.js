// Самотест модуля ibm-imm (без сети): матч веб-сигнатуры IMM.
// Запуск: node --test server/platforms/ibm-imm/test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { matchImm } from './probe.js';
import { loadPlatforms } from '../../sdk/registry.js';

const IMM_ROOT = `<!--  --><html><head><title></title>
<link rel="stylesheet" href="/designs/imm/dojoOverrides.css" />
<script src="/designs/ibmdojo/dojo/dojo.js"></script>
<script>dojo.require("imm.layer-login");</script>
<img src="/designs/imm/images/title-imm.png"/>
</head><body>IBM Integrated Management Module</body></html>`;

const OTHER = `<html><head><title>BMC HTTP Server</title></head><body>Avocent</body></html>`;

test('ibm-imm: матч веб-сигнатуры (designs/imm, ibmdojo, layer-login)', () => {
  assert.equal(matchImm(200, IMM_ROOT), true);
  assert.equal(matchImm(401, IMM_ROOT), false);
  assert.equal(matchImm(200, OTHER), false);
});

test('ibm-imm: модуль загружается реестром и имеет probe', async () => {
  const mods = await loadPlatforms({ force: true });
  const m = mods.find((x) => x.manifest.id === 'ibm-imm');
  assert.ok(m && m.impl, 'ibm-imm: нет impl');
  assert.equal(typeof m.impl.probe, 'function');
  assert.equal(m.manifest.priority, 92);
});
