import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchBmcModule, listBmcModules, CAP } from '../server/bmc-registry.js';
import { quickCheck } from '../server/ipmi.js';

// Реестр модулей BMC: сигнатуры реальных железок -> правильный модуль.
test('bmc-registry: S2/S4/S3/generic матчатся по сигнатуре', () => {
  const s2 = matchBmcModule({ realm: 'iRMC S2@10.1.1.1', title: null, ipmiOk: true });
  assert.equal(s2.module.id, 'fujitsu-irmc-s2');
  assert.ok(s2.matched);

  const s4 = matchBmcModule({ realm: 'iRMC S4@iRMCdgk51srv042', title: '... iRMC S4 Web Server ...', ipmiOk: true });
  assert.equal(s4.module.id, 'fujitsu-irmc-s4');
  assert.ok(s4.matched);
  // S4: честные caps — веб-инвентаря нет (form-вход не реализован)
  assert.ok(s4.module.caps.includes(CAP.IPMI_LAN));
  assert.ok(!s4.module.caps.includes(CAP.WEB_INVENTORY));

  const s3 = matchBmcModule({ realm: 'iRMC S3-2 DGK', title: null, ipmiOk: true });
  assert.equal(s3.module.id, 'fujitsu-irmc-s3plus');

  const generic = matchBmcModule({ realm: null, title: null, manufacturer: 'Supermicro', ipmiOk: true });
  assert.equal(generic.module.id, 'generic-ipmi');
  assert.equal(generic.matched, false);
});

test('bmc-registry: приоритеты убывают, модули уникальны', () => {
  const mods = listBmcModules();
  const ids = mods.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, 'дубли id модулей');
  for (let i = 1; i < mods.length; i++) {
    assert.ok(mods[i - 1].priority >= mods[i].priority, 'порядок priority');
  }
});

test('bmc-registry: у каждого модуля caps+quirks, match() не кидает', () => {
  for (const m of listBmcModules()) {
    assert.ok(Array.isArray(m.caps) && m.caps.length > 0, 'caps пуст: ' + m.id);
    assert.ok(Array.isArray(m.quirks), 'quirks нет: ' + m.id);
  }
  // match() не кидает на пустой сигнатуре (fallback)
  assert.doesNotThrow(() => matchBmcModule({}));
});

// quickCheck: недоступный хост -> ipmi.ok=false, auth=null (не отвечал),
// lan=null, ms измерен. Пароль не должен попасть в вывод.
test('ipmi.quickCheck: мёртвый хост — отказ без утечки пароля', async () => {
  const r = await quickCheck({ host: '192.0.2.123', username: 'admin', password: 'SECRET-PASS' });
  assert.equal(r.ipmi.ok, false);
  assert.equal(r.ipmi.auth, null); // хост не отвечает — креды неизвестны
  assert.equal(r.lan, null);
  assert.ok(typeof r.ms === 'number' && r.ms > 0);
  assert.ok(!JSON.stringify(r).includes('SECRET-PASS'), 'пароль утёк в ответ');
});
