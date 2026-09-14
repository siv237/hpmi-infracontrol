# HPE iLO 4/5 — опрос по Redfish (когда RMCP+ выключен)

`platforms/hp-ilo/redfish.js` — опрос BMC по HTTPS `/redfish/v1`, когда
IPMI-over-LAN (RMCP+) не отвечает. Живой случай: **baspx03 (192.168.3.206,
ProLiant DL380p Gen8, iLO 4 fw 2.80)** — ipmitool молчит, Redfish живой.

> ⚠ Статус интеграции: библиотека лежит **внутри модуля** `platforms/hp-ilo/`
> и пока **не подключена к поллеру**. Ядро (`pollSensors`, `ipmi.js`, `db.js`,
> `vnc.js`) НЕ трогали: HP-код изолирован в своей папке. Чтобы iLO с
> выключенным RMCP+ реально опрашивался автоматически, нужен отдельный
> (согласованный) хук в ядре: при отказе IPMI → проба платформы →
> `capabilities.redfish` → `redfish.readAll`. До этого — только ручной вызов.
> Проверенные парсеры (`parseThermal/Power/System/ImlEntry`) и `readAll`
> работоспособны (живой прогон baspx03).

## Квёрки живого iLO 4 (fw 2.80) — все проверены 2026-09-14

- **Рвёт подряд идущие HTTPS-запросы** (`socket hang up` на 2-м запросе
  без паузы). Лечится: каждый запрос своим соединением (`Connection: close`)
  + пауза ≥0.9 с между запросами + ретрай ×3 (2 с, 4 с).
- `/redfish/v1/` (корень) отдаётся **без логина** (маркер `Oem.Hp`); но
  Systems/Managers/Chassis/Thermal/Power требуют **Basic-auth** (401
  `Base.0.10.NoValidSession`). root — не Basic, но полезен только для
  ссылок на коллекции.
- **Fans в Thermal — в процентах** (`CurrentReading: 19, Units: "Percent"`),
  не RPM. units тащится по всей цепочке: redfish.readAll → recordPoll →
  sensors.units (БД) → pollCache → фронт.
- **IML ленивый**: `.../IML/Entries/` содержит только `@odata.id`-заглушки,
  данные — отдельный GET на запись. Всего 18 записей на baspx03.
- `root.Systems` — ссылка на **коллекцию**; `LogServices` есть только у
  **члена** (`/redfish/v1/Systems/1/`). Не перепутать.
- Часть темп-сенсоров `Status.State: "Absent"` (пустые DIMM/PCI слоты) с
  `ReadingCelsius: 0` — пропускаем, не показываем «0 °C».

## Что собирает readAll (живой прогон baspx03)

| Поле | Источник | Значение (14.09.2026) |
|------|----------|-----------------------|
| temps | Chassis/1/Thermal `Temperatures[]` | 42 сенсора (18–50 °C) |
| fans | Thermal `Fans[]` | 6 кулеров, Percent |
| events | Systems/1/LogServices/IML | 18 записей (post error, redundancy) |
| power | Systems/1 `PowerState` | on |
| powerWatts | Chassis/1/Power `PowerControl[0]` | 133 Вт |
| fru | Systems/1 + Managers/1 | DL380p Gen8, CZ2408009L, SKU 653200-B21, iLO 4 v2.80 |

Канон результата = `ipmi.readAll` (temps/fans/events/power/faults/fru/net),
плюс маркеры `redfish: true` и `powerWatts`. Для отображения процентов iLO
кулеров на фронте потребуется сквозная передача units (в ядре пока не
включена — см. статус выше).

## Планируемая цепочка опроса (требует согласованного хука в ядре)

```
pollSensors (index.js, раз в 60 c)
  ├─ ipmi.readAll(cfg)        — RMCP+
  │    └─ пустой lan print → THROW «RMCP+ не отвечает»
  └─ catch → matchPlatform(cfg)  — подбор платформы (проба только на отказе)
       └─ capabilities.redfish (модуль platforms/hp-ilo) →
            platforms/hp-ilo/redfish.js readAll({...cfg, port:443, secure:true})
              ├─ успех → recordPoll(rf)   // up=1, источник — Redfish
              └─ провал → recordPollFailure(...)
```

Фолбэк задуман **capability-driven**: библиотека Redfish — часть модуля
`hp-ilo`, а `capabilities.redfish` объявлен в его `manifest.js`. Ядро
изменять нельзя без отдельного разрешения владельца (правило: ядро
неприкосновенно; HP-сюрпризы не навязываем другим платформам). Фолбэк должен
идти на **443/https** — независимо от web-порта записи (LO100 хранит 80/http;
для iLO 80-й — redirect на https).

## Тесты

`platforms/hp-ilo/test.js` — самотест модуля: чистые парсеры на фикстурах
живого iLO 4 (Thermal с Absent-фильтром и units, Power, Systems с триммингом
серийника, IML) + матч-функции проб. Сети в тестах нет.
Запуск: `node --test server/platforms/hp-ilo/test.js`.
