# Модули платформ (platforms) — манифест разработчика

Одна папка = одна серверная платформа. Ядро **не знает** платформ: оно
объявляет контракты (`server/sdk/contracts.js`) и при старте сканирует эту
папку (`server/sdk/registry.js`). Добавление новой платформы = новая папка
здесь, **без правок ядра**.

Канонические принципы: `wiki/knowledge/platform-module-manifesto.md`.

## Структура модуля

```
platforms/<platform-id>/
  manifest.js   # ЕДИНЫЙ декларативный файл: что поддерживаем, порты, доступ, caps, пробы
  index.js      # реализация контрактов ядра (код)
  probe.js      # (опц.) методы проб (имена перечислены в manifest.probes)
  README.md     # что проверено, на каком железе/прошивке, грабли
  test.js       # (опц.) самотест модуля; подхватывается npm test
```

Скопируйте `_template/` в `<platform-id>/` и заполните.

## Правила (коротко)

1. **Всё платформенное — в папке модуля.** Ядро не содержит платформенных строк.
2. **Ядро только вызывает объявленные методы**; чужих методов не требует.
3. **Пробы и доступ — здесь.** Явно перечисляйте порты и способы доступа.
4. **Креды — универсальны (ядро).** Как их вводить (digest/форма/Basic) —
   платформенный код `index.js → login()`.
5. **IPMI платформо-зависим** — точно перечисляйте, что платформа реально отдаёт.
6. **Один файл-список поддержки** — `manifest.supported` с конкретными
   `модель + версия прошивки`. Хочешь попробовать свою — добавь строку
   (`status: experimental`) и смотри.
7. **Ошибка модуля не роняет ядро** — реестр ловит и логирует, идёт дальше.
8. **Формат простой.** Модуль не обязан уметь всё: объявил capability —
   ядро включило; не объявил — ядро отключило.
9. **Канон пикселей `0x00RRGGBB`** (R — старший байт). Приведение каналов —
   обязанность модуля; общий RFB/PNG работает только с каноном.
10. **Только через `sdk`.** Модуль не лезет во внутренности ядра.

## Минимальный `manifest.js`

```js
export default {
  id: 'vendor-family',
  title: 'Vendor Family (кратко)',
  sdk: 1,
  priority: 50,
  supported: [{ model: '...', firmware: '...', status: 'experimental' }],
  access: { web: { ports: [80, 443], secure: [false, true] }, login: 'digest-post-form' },
  capabilities: { kvm: true, virtualMedia: ['cd'], ipmi: { sensors: true } },
  probes: ['web-title'],
};
```

## Контракты `index.js`

```js
export default {
  async probe(cfg, sdk) {},                    // -> { matched, confidence, info }
  async login(cfg, sdk) {},                    // -> sessionCfg
  createConsole(sessionCfg, events, sdk) {},   // -> ConsoleClient
  createMedia(sessionCfg, { isoPath }, sdk) {},// -> MediaRedirector
};
```

Реализуйте только то, что объявили в `capabilities`; остальное ядро отключит.
Контракты и их поля — `server/sdk/contracts.js`.

## Чеклист

1. `cp -r server/platforms/_template server/platforms/<id>`
2. Заполнить `manifest.js` (в первую очередь `supported` — модели+прошивки).
3. Реализовать нужные методы в `index.js`, пробы — в `probe.js`.
4. Описать проверку железа в `README.md`; при желании — `test.js`.
5. Запись в `wiki/knowledge/platforms/<id>.md` + `wiki/index.md`.
6. Ядро не трогать. Проверка: `node server/sdk/registry.js` (список модулей).

## Текущие модули

| id | Платформа | Статус |
|----|-----------|--------|
| `mahogany-avr` | Fujitsu iRMC S2/S3 (Avocent/Mahogany) | заготовка, перенос кода по живому железу |
| `ami-soc` | Fujitsu iRMC S4 (AMI/SOC) | заготовка, перенос кода по живому железу |
