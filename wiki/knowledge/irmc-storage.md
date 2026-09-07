# Механизм виртуального диска iRMC (проброс ISO) — разбор легаси

Как легаси-вьювер (`raw/avr_irmc_s2.jar`, Avocent/Mahogany) монтирует
ISO в iRMC. Источники: декомпиляция CFR (`/tmp/kilo/all/`), строки
бинарников M2 (`LIBM2-64.so`, `M2-64.dll` — лежат внутри jar).

## Архитектура: всю передачу делает нативная библиотека M2

Ключевой факт: **образ не передаётся ни Java-клиентом, ни «тянется
iRMC по сети»**. Движок — нативная библиотека:

- `NativeInterface2` (com/serverengines/nativeinterface) распаковывает
  из jar `LIBM2-64.so` (Linux) / `M2-32|64.DLL` (Windows) в `~/.iRMC_temp_*`,
  пишет желаемый порт в файл `StorageServer.Port`, делает `System.load`.
- Библиотека поднимает локальный TCP-сервер — `MahoganyStorageServer`
  на **127.0.0.1** (порт из `StorageServer.Port`, дефолт 5901), реальный
  порт пишет в `StorageServer.ActualPort` (Java опрашивает до 40×250 мс).
- Дальше Java общается с M2 только через этот локальный сокет, а M2 сама
  устанавливает соединения с iRMC и отдаёт данные устройства.

Следствия:
- порт 5901 из viewer-параметра `StoragePort` — это **локальный** порт M2,
  а не порт, куда подключается iRMC;
- ip/порт в 153-команде — не адрес клиента: в `sendStorageShareMsg`
  ставится `serverHost` (адрес iRMC) и `m_storagePort` (= **HTTP-порт
  iRMC**, в `init`: `m_storagePort = m_HttpPort`);
- сама 153 (`StorageClientConnect`) в Java **нигде не отправляется**
  (`MessageSender.storageClientComnnect` без вызовов) — её шлёт M2 по
  своему каналу.

## Локальный протокол Java ↔ M2 (127.0.0.1:5901)

Фрейминг — `LittleEndianBufferMgr` (little-endian). Классы
`mahoganyprotocol/*`:

### Discovery — `StorageMsgRequest` (544 Б)
```
u16 portNumber (LE; из viewer-параметра StoragePort)
u8  reserved[3]
u8  connectionType = 0xFE (-2)
u8  reserved[538]
```
Ответ (readStorageResponse): заголовок 19 Б, в смещении 9 — ASCII-hex
длина (8 символов), дальше текст: строки устройств через `\n`,
поля в строке через `|` (`MountedDriveMgr.FIELD_SEPERATOR`):
`путь|тип(16-рично)`. Список дисков M2 берёт сама (setmntent/getmntent —
читает /etc/mtab; типы 4/7/8 фильтруются по политикам вьюера).

### Share (монтирование) — `StorageShareRequest` + `URSStorage`
Запрос = 544 Б заголовок + 1044 Б payload:
```
u8  reserved[5]
u8  connectionType = 0xFA (-6)   // 0xF9 (-7) — native video
u8  reserved[538]
--- URSStorage ---
u8  len0  (длина sharePath0 в UTF-16LE байтах)
u8  len1
u8  shareType0        // 11 = DT_CD_ISO_IMAGE, 12 = DT_DVD_ISO_IMAGE
u8  shareType1
u8  sharePath0[510]   // UTF-16LE, добивка 0x00
u8  sharePath1[510]
u8  ipAddr[16]        // адрес iRMC (IPv4 — последние 4 Б)
u16 portNumber        // HTTP-порт iRMC
u8  sequence          // 1 = default
u8  ipType            // 0 = IPv4, 1 = IPv6
```
Ответ share — 1 Б; код ошибки — 2 Б (`processStorageErrorCodeResponse`).

Отмонтирование — команда 154 (`StorageClientDisconnect`); статус —
137 (`StorageStatus`) по каналу KVM.

## Проводной протокол M2 ↔ iRMC (из строк M2-64.dll)

Debug-строки DLL восстанавливают последовательность (Pilot — прошивка
BMC; исходное дерево `C:\PILOT\3.10A9P1\pilot\clients\Storage\...`):

1. `URS Connect: %d.%d.%d.%d:%d` → `URS connected` → `Signature sent`
   (M2 соединяется с iRMC и шлёт signature; соединения создаются
   парами — «Creating connection: %8.8x»).
2. `RC310 URS setup received. Waiting for URSClientStorageConnect:`
   (в ответе BMC: byShareType0/1, **TCP port = %d** — порт данных
   сообщает сам iRMC).
3. `Storage A connecting to Pilot` → `Sending storage signature A to
   Pilot` → `Waiting for Pilot status response`; то же для B
   (`Waiting for Pilot status B response`).
4. `Sending client confirmation` → `Beginning SCSI sequence on storage
   set`.
5. Дальше — транзакции SCSI: BMC шлёт CDB, M2 отвечает данными из
   файла/устройства (`pread64`/`pwrite64`); классы-таргеты:
   `ScsiIsoStorageTarget` (наш случай, ISO-файл), `ScsiCdromStorageTarget`,
   `ScsiDvdromStorageTarget`, `ScsiDasdStorageTarget`,
   `ScsiFloppyStorageTarget`, `ScsiUSBRemoteStorageTarget`,
   `ScsiImgStorageTarget`; команды: Inquiry, ReadCapacity, Read10,
   Write10, ModeSense(10), ReadTOC, GetEventStatus,
   ReadFormatCapacities, RequestSense, PreventAllowMediumRemoval,
   ReadDiscInformation, PassThrough, BusReset.
   Прочее: `About to read mxss` (маркер кадра?), `SSC:CST %ld %ld`,
   `Invalid sharetype in ConfigST`, `StorageSetup:`, `Sending
   pre-connect response:`, `unmountDevice`, `parseDevicePath`.

Зависимости .so: `libpthread.so.0`, **`libstdc++.so.5`** (GCC 3.x ABI!),
`libm.so.6`, `libgcc_s.so.1`, `libc.so.6`.

## Почему наш текущий вариант не доставляет данные

Мы шлём 153 с нашим IP:5901 и слушаем у себя — iRMC регистрирует share
(sr0 создаётся), но **данных не отдаёт никто**: канал данных должен
открывать мы сами (как M2: URS-соединение → signature → статус →
подтверждение → SCSI-транзакции), либо использовать саму M2.
Живой тест 07.09 это подтвердил (sr0 = 2097151 секторов, blkid пуст).

## Рабочий локальный протокол Java ↔ M2 (проверено, июнь/08.09)

Проверенный рабочий формат (движок `server/m2.js`), единство vs легаси:

### Discovery — `StorageMsgRequest` (544 Б)
```
u16 portNumber (LE) = 5901      // StoragePort (локальный порт M2)
u8  reserved[3]
u8  connectionType = 0xFE (-2)
u8  reserved[538]
```
Ответ: 19 Б `"00000000 00000000\r\n"` — hex-длина по смещению 9 (8 симв.);
сюда добавлены payload (у нас 0, т.к. на сервере нет локальных приводов).
Discovery обязателен перед share (легаси всегда гоняет его на том же сокете).

### Share (монтирование) — заголовок + URSStorage, 544 + 1044 Б
```
u8  reserved[5]
u8  connectionType = 0xFA (-6)
u8  reserved[538]
--- URSStorage (1044 Б) ---
u8  len0   // число UTF-16 СИМВОЛОВ пути (cchPath0), не байт!
u8  len1
u8  shareType0   // 11 = DT_CD_ISO_IMAGE (файл-образ)
u8  shareType1   // 0xFF = UNDEFINED
u8  sharePath0[510]   // UTF-16LE, pad 0x00
u8  sharePath1[510]
u8  ip[16]       // IPv4 — по offset 0 (НЕ как в 153!)
u16 portNumber   // HTTP-порт iRMC (LE)
u8  sequence     // 1
u8  ipType       // 0 = IPv4
```
Ответ share может не приходить сразу (успех = тишина; M2 ведёт URS к iRMC
сама); короткое окно ловит error. **Заголовок 0xFA обязателен** — без него
M2 молчит (неверный вывод про buffer.clear() из sendStorageShareMsg, см.
log.md). IP строго по offset 0 — иначе M2 видит 0.0.0.0 и падает с
«storage subsystem ... initializing. Exception: 0xe000002c»
(ECONNREFUSED на 0.0.0.0:80).

### Подтверждение (08.09)
Монтирование xubuntu-26.04 → 10.67.17.101: на root@10.67.19.5 появился
/dev/sr1 (транспорт USB): `TYPE=iso9660`, `LABEL="Xubuntu 26.04 amd64"`,
`PTTYPE=PMBR`, `isosize=5183416320` (= размер образа). Старый sr0 (пустой,
1024M) — от прежних экспериментов с 153.

## Решения по проекту (07.09/08.09)

- Движок M2 встроен и РАБОТАЕТ (`server/m2.js`, python-dlopen `LIBM2-64.so`,
  `libstdc++.so.5` в `data/m2/lib`), монтирование подтверждено физически.
- Полный реверс M2↔iRMC и чистая Node-реализация — **в листе ожидания**
  (ROADMAP п.10.0b).
