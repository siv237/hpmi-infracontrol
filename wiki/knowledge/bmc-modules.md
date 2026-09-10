# Модульный стек BMC (плагины поддержки железок)

Сервера в парке — разные BMC (вендоры, поколения, прошивки). Чтобы каждая
новая железка не ломала сбор, поддержка описана **модулями-плагинами**:
реестр сигнатур + честные возможности + известные особенности.

- Код: `server/bmc-registry.js` (реестр), `server/discover.js` (веб-диагностика),
  `server/ipmi.js:quickCheck` (IPMI-проба).
- API: `POST /api/check` — быстрая проверка при добавлении/для сохранённого
  (`{serverId}` или инлайн): триада ping/web/IPMI + веб-диагностика кредов
  + подбор модуля (`compat`).
- Тесты: `test/bmc-registry.test.js` (npm test).

## Зачем

Реальный случай (2026-09-09, dgk51srv042): IPMI принимает креды, веб «не
авторизуется». Диагноз через `/api/check`: это **iRMC S4** (Fw 7.69F) —
его веб на GET «/» отвечает 302→`/login`→страница-триггер (форма
`APPLY=99`), Digest-челлендж прячется за POST. Креды верны, но Digest-вход
**не создаёт сессию** — контент за «Login required» (нужен form-вход,
не реализован). IPMI-инвентарь при этом полностью жив.

## Как устроен модуль

```js
{
  id: 'fujitsu-irmc-s4',          // уникальный: vendor-family[-sub]
  title: 'Fujitsu iRMC S4 (ServerView, Fw 7.x)',
  priority: 95,                    // выше = проверяется раньше
  match: (sig) => ...,             // сигнатура -> true (см. ниже)
  caps: [...],                     // CAP.* — что реально работает
  quirks: ['...'],                 // особенности, читаемые человеком
}
```

Сигнатура `sig` (собирается `/api/check`-ом):
- `realm`, `title` — со страницы/челленджа веба BMC;
- `manufacturer`, `bmcFirmware` — из IPMI `mc info`;
- `webScheme` — Digest/Basic/Form/«форма-триггер»;
- `ipmiOk` — ответил ли RMCP+.

`match()` вызывается по убыванию `priority`; несовпавшие — fallback
`generic-ipmi` (только IPMI-опрос, без веба).

Возможности (caps): `ipmi-lan`, `web-digest`, `web-basic`, `web-form`,
`web-inventory`, `kvm-avr`, `kvm-vnc`, `iso-m2`, `tls-legacy`.

## Как добавить модуль (инструкция)

1. Добавьте объект в `MODULES` (`server/bmc-registry.js`), id уникален.
2. `match()` — по сигнатуре: realm/title для веб-семейства, manufacturer
   для вендора. Не бросайте исключений, возвращайте true/false.
3. `caps` — только то, что реально проверено на железе. Не проверено —
   не добавляйте (лучше меньше, чем враньё).
4. `quirks` — одной строкой особенность и обход (если есть).
5. Тест в `test/bmc-registry.test.js`: сигнатура новой железки -> id.
6. Обновите таблицу «Учёт модулей» ниже.

## Учёт модулей

| id | Что | Статус | Проверено на |
|----|-----|--------|--------------|
| fujitsu-irmc-s2 | iRMC S2 (ServerView): Digest 401 на «/», HTTP:80 (443 вешает), KVM AVR, ISO M2 | ✅ работает | dgk10str011, dgk24srv040 (041: Digest-вход извне виснет — известный дефект S2) |
| fujitsu-irmc-s4 | iRMC S4 (Fw 7.x): 302→/login, Digest за формой-триггером; веб-сессии Digest НЕ даёт | ✅ опрос IPMI + проверка кредов; ⚠ веб-инвентарь не собирается (нужен form-вход — задача) | dgk51srv042 (Fw 7.69F) |
| fujitsu-irmc-s3plus | iRMC S3/S3-2: 302→login, Digest обычно стабилен | 🟡 предполагается (не проверялся на живом) | — |
| hp-lo100 | HP LO100/LO100i (DL180 G6 fw 4.22): Digest HTTP:80, IPMI 2.0; KVM Mahogany (M2.JAR) — модуль server/hp.js | ✅ KVM работает (live 192.168.6.51, 1024×768, кадр снимается); 🤔 ISO (LIBM2) — проверить | 192.168.6.51 (DL180 G6) |
| generic-ipmi | любой IPMI 2.0 без распознанного веба | ✅ fallback | — |

## Сигнатуры реальных железок (для match)

- S2: `realm="iRMC S2@<host>"`, title «ServerView…». GET / → 401 Digest.
- S4: GET / → 302 `/login` → 200 «Login required» (форма APPLY=99);
  POST → 401 `realm="iRMC S4@<host>"`; Digest 200, но контент не даёт.
- (добавляйте новые находки сюда)
