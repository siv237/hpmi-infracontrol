# Метрики и события по IPMI-over-LAN (RMCP+/UDP 623/664)

iRMC отдаёт по **стандартному IPMI через LAN** (не только AVR/KVM-консоль):
сенсоры, журнал событий, питание/здоровье, инвентарь FRU. Проверено живьём 08.09.

## Два независимых канала

- **AVR/KVM**: TCP 80, консоль/видео (`MAHOGANY KVMS LBW`, handshake `0xc8`,
  `InformVesaMode`…). Сенсоров тут НЕТ. Это то, что держит/держит сессии вьювера.
- **IPMI-LAN**: UDP **623** (RMCP) / **664** (RMCP+). Поверх — IPMI-сообщения:
  Open Session → Get Session Challenge → Activate Session → `Get SDR` /
  `Get Sensor Reading` / `Get SEL Entry` / `Get Chassis Status` / `Read FRU`.
  `ipmitool -I lanplus -H <ip> …` так и работает. Здесь лежат темп./кулеры,
  события SEL, питание, FRU.

## Почему вернули ф-хункц (п.5) именно так

Раньше метрики **заморозили** (решение 07.09): прежние подходы **блочили**
/мешали основной работе (держали KVM-сессии). Теперь — **интервальный опрос
по LAN** только по UDP, который:
- не трогает AVR/TCP-консоль → не блокирует и не ломает KVM-сессии вьювера;
- идёт по UDP (623/664), без «удержания» соединения консоли.

## Что собирает `server/ipmi.js` (все команды через `ipmitool lanplus`)

| Данные | Команда | Парсер | Выход |
|---|---|---|---|
| Сенсоры темп. | `sdr type Temperature` | `parseSensors` | `temps[] {name,sensor,status,value}` |
| Кулеры | `sdr type Fan` | `parseSensors` | `fans[] {name,sensor,status,value}` |
| Журнал событий | `sel elist last N` | `parseSEL` | `events[] {id,ts,sensor,detail,category,level}` |
| Питание/здоровье | `chassis status` + `chassis power status` | `parseChassis` | `power` + `faults{drive,cooling,intrusion,powerFault}` |
| Инвентарь FRU | `fru print` | `readFru` | `fru{}` (ключ:значение) |

`readAll()` запускает всё параллельно. Категории SEL: temp/fan/power/voltage/
cpu/memory/watchdog/critical/other; уровни: critical/warning/info.

## База истории (п.5) — SQLite

`server/metrics.js` (better-sqlite3, `data/metrics.sqlite`, WAL):
- Таблица `metrics(server_id, metric, ts, value)` + индекс
  `(server_id, metric, ts)`; таблица `events(ts, server_id, kind, text)`.
- **Метрика доступности**: каждый опрос пишет `ping` 0/1 и `response_ms`.
- Сенсоры пишутся по имени (`temp:*`, `fan:*`).
- Чтение: `series` (ряд за окно), `lastValues`, `availabilitySummary`
  (pct сервером за окно), `availabilityBuckets` (почасовые % для графика),
  `getEvents`. Ретеншн: `prune(30)` — чистка > 30 дней каждые 6ч.

## API

- `GET /api/ipmi/sensors[?serverId=]` — живые сенсоры (кеш опроса 60с).
- `GET /api/ipmi/sel[?serverId=]` — события SEL.
- `GET /api/ipmi/chassis[?serverId=]` — питание/здоровье.
- `GET /api/ipmi/metrics[?serverId=&window=]` — series (temp) + lastValues.
- `GET /api/overview[?window=]` — сводка + `availability.{avgPct,buckets,perServer}`.
- `GET /api/events` — доменные события (из `storage.json`, AVR/ISO).

## Проверено (живой iRMC S2 5.76A, `ipmitool lanplus`)

- UDP 623 и 664 на 10.67.17.101 **открыты**, RMCP+ отвечает.
- Температуры SDR: Ambient 21°C, Systemboard 38–39°C, CPU1 38–40°C, CPU2
  40–42°C (пустые слоты — «No Reading»); кулеры FAN1–5 SYS 3960–4080 RPM.
- 10.111.17.5 (dgk24srv040): 6+14 сенсоров, CPU2=59°C (замечаем перегрев).

Смежное: AVR-протокол — `irmc-protocol.md`; проброс ISO — `irmc-storage.md`;
общий замысел/заморозка — `ROADMAP.md` п.5.
