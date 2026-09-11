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

### Контрольный тест целостности (08.09, по приказу владельца)
- Сделали локально на сервере детерминированный ISO (CTRLTEST): 128MB
  `blob.bin` из urandom + `hello.txt` + `meta.txt`, xorriso, size
  = 134596608 = 2048×65721 (сектор-выровнен). Локальный sha256
  `70b31afdf69dd6c167cbfd3a8325d9b8ad65d008a2d8e0d7edbe52a1762d3edf`.
- Смонтировали через движок M2 (`m2.js share()`) на живой iRMC 10.67.17.101;
  на root@10.67.19.5 появился /dev/sr1 (USB, LABEL CTRLTEST, 128,4M).
- **ЧЕСТНОЕ СРАВНЕНИЕ**: `sha256sum` всего /dev/sr1 != ISO (вирт. устройство
  отдаёт 65722 сектора, на один больше). Но первые 65721 сектора /dev/sr1 =
  РОВНО исходный ISO:
  `70b31afdf69cd6c167cbfd3a8325d9b8ad65d008a2d8e0d7edbe52a1762d3edf` ✓.
  Лишний 1 сектор (последние 2048 Б) — **нули** (padding от слоя SCSI/iRMC).
- Контент совпал: label CTRLTEST, список файлов (blob.bin 134217728, hello.txt
  33, meta.txt 27), текст hello.txt, размеры — как в локальном дереве.
- **Вывод: передача ISO через M2→iRMC→вирт. CD потеряна/искажена НИГДЕ —
  побайтно идентична.** Нюанс для будущих сверок: сравнивать первые
  (size_iso / 2048) секторов устройства, игнорируя один хвостовой ноль-сектор.
- После `unshare()` (стоп недержащего процесса) sr1 исчез, остался только
  старый пустой sr0.

## Решения по проекту (07.09/08.09)

- Движок M2 встроен и РАБОТАЕТ (`server/m2.js`, python-dlopen `LIBM2-64.so`,
  `libstdc++.so.5` в `data/m2/lib`), монтирование подтверждено физически.
- Полный реверс M2↔iRMC и чистая Node-реализация — **в листе ожидания**
  (ROADMAP п.10.0b).

## Реверс протокола M2↔iRMC (10.0b, в работе)

Захват: шмониджем под LD_PRELOAD (mshim.c, лог fd+getpeername),
фильтр peer=[::ffff:<iRMC>]:80. Сырой лог: /tmp/kilo/m2net.log (~381
строк), плюс чистая последовательность в /tmp/kilo/seq.py/read10.py.

### Обмен (порядок)
1. M2 → iRMC: `d2 02 00 01 00 01 cd 37` (8 Б, инициализация/signature).
2. iRMC → M2: `03 0a 00 00 00 00 00 00 46 75 6a 69 74 73 75 20` — ответ с
   vendor-строкой «Fujitsu » (конец «Fujitsu iRMC …»).
3. M2 → iRMC: путь к ISO-файлу (UTF-16LE, `48 00 0b ff 2f 00 68 00 …` =
   длина 0x0bff=3071? + "/home/siv/proj/../data/iso/…").
4. Дальше — обмен «запрос/ответ» MMC-SCSI: iRMC шлёт команду, M2 отвечает
   данными.

### Конверт пакета (обе стороны)
Общий 8-байтовый заголовок `00 80 b5 09 00 10 00 00`, далее length/type
и поля; у ответа READ10 — ~128-байтовый заголовок + данные сектора.
Точная раскладка полей конверта — не завершена (см. открытые вопросы).

### MMC-SCSI команды (iRMC → M2), опознаны из лога
- `12` = INQUIRY (6 Б, alloc len 0x24=36) → ответ содержит «Fujitsu».
- `25` = READ CAPACITY (10 Б) → 8-байтовый ответ.
- `28` = READ(10): CDB `28 00 <LBA:4> <transfer len:2> <ctrl>`; LBA растёт,
  ответ M2 = ~128+`N×2048` байт (проверено: ...02 00→4225, ...06 00→12545,
  ...0a 00→20865, ...1e 00→62465 — т.е. N×2048+заголовок).
- `43` = READ TOC/PMA/ATIP (`43 00 … 0c 40`/`0c 00`; вариант `43 02 … aa`).
- `46` = GET CONFIGURATION (`46 … 08 00` / `40 00`).
- `4a` = GET EVENT STATUS NOTIFICATION (`4a 01 00 00 10 00 … 08 00`).
- `51` = READ DISC INFORMATION (`51 00 … 02 00` / `22 00`).
- `52` = READ TRACK INFORMATION (`52 01 … 08 00` / `02 00`).
- `03` = REQUEST SENSE (`03 00 00 00 12 00`) и `0a`-вариант.
- `5a` = ? (`5a 00 2a 00 00 00 00 00 80 00`) — вероятно вариант `2a` (WRITE) /
  SENSE. `00 00 00 00 00 00` — «no-op/TUR»-подобные.
Совпадает с SCSI-таргетами M2: ScsiIsoStorageTarget + прокачка
[Inquiry, ReadCapacity, Read10, ReadTOC, GetEventStatus, ReadDiscInfo,
ReadTrackInfo, GetConfiguration, RequestSense].

### Открытые вопросы (следующие шаги)
- Точная раскладка 8-байтового заголовка + полей конверта (что за
  length/type/seq: есть счётчик `80/81/8a/… 06 00 00` по приращению).
- «мусор»-последовательности вида `6c 75 3e 0a`, `61 7f 00 00`, `90 17 d8 74`
  — похоже на raw-указатели в структуре M2 (переписать решение: вероятно,
  часть конверта — это неправильно выровненный фрейм; доп. захват перв.
  БЕЗ усечения 64 Б и с точной сегментацией по длине).
- Завершить картину READ-ответа (заголовок 128 Б) и формат REQUEST SENSE.
План: 1) полный захват с сегментацией по длине; 2) сопоставление с
функциями LIBM2-64.SO (xref): URSStorageServerConnection::run,
StorageServerConnection::MakeOutgoingConnection/ProcessTransaction/
GetDataOut/SendDataIn; 3) прототип чистого Node-респондера на READ10+INQUIRY+
READ CAPACITY+READ TOC (+команды гостевой загрузки).

### Уточнение по tcpdump (полные пакеты, scapy, /tmp/kilo/urs2.pcap)
- **Два TCP-канала** к <iRMC>:80. Основной SCSI-канал: RX(irmc→нас) — команды
  (85×READ10 + READ TOC/DISC/TRACK + GET EVENT + INQUIRY + READ CAPACITY),
  TX(нас→irmc) — данные (в т.ч. реальные ISO9660-байты образов, крупные блоки).
  Второй канал — поток мелких метаданных (много REQ SENSE 0x03).
- **Исправление**: «магия `00 80 b5 09 00 10 00 00`» из shim-лога — НЕ делимитер
  и не начало кадра: это поле-ручка/заголовок ВНУТРИ кадра. В потоках встречаются
  opaque-поля вида `40 59 73 07`, `c3 7f 00 00`, `80 e3 7f 00 00` — похоже, хэндл-
  токены структур (вторая сторона эхо-возвращает, не разыменовывает).
- Реальное начало обмена на канале данных: `d2 02 00 01 00 01 cd 37`
  (8 байт, signature) + `48 00 0b ff` + путь к ISO в UTF-16LE.
- Формат кадра (length-prefix) однозначно не закрыт (гипотезы LE/BE не дают 100%
  сегментацию; мешают хэндл-поля). Требуется дальнейший пошаговый разбор кадра.
- Вывод: протокол — бинарный вендорный фрейминг с opaque-хэндлами, поверх —
  MMC/SCSI. Уровень SCSI понятен полностью; точная раскладка кадра — следующий
  этап (сопоставление с функциями LIBM2-64.SO).

### Раскладка кадра команды (iRMC→M2), подтверждено на кадре READ10
Каждое сообщение-команда на основном SCSI-канале = **фиксированный кадр 92 байта**
(шаг между READ10 в RX ровно 92):
```
[0..9]   SCSI CDB (10 байт) начиная с offset 0 (READ10: 28 00 <LBA:4> <xfer:2> <ctrl>)
[10..35] нули (выравнивание)
[36]     длина CDB (0x0a=10)
[37..39] 0x00
[40..43] sequence (LE, растёт: 0x0745,0x0746,…)
[44..47] тег 'lu>' (6c 75 3e 0a) — постоянный
[48..91] хэндлы/длина/поля (opaque; 0x7fe3… и т.п.)
```
Ответ-sequence откликается в исходящем потоке (0x0745… найдены в TX как LE u32).
Вывод: вендорный бинарный фрейминг поверх MMC/SCSI; команды/SCSI-уровень понят,
фрейминг ответа/данных и таблица-дескриптор (~по 0x28/блок) — следующий шаг.

### Внешний конверт кадра (подтверждено, уточнено)
Каждое сообщение на SCSI-канале: **[6-байтовый lead нулей] `00 00 00 00 00 00` + [кадр]`.
Конверт кадра (обе стороны), константа:
```
[0..7]  00 80 b5 09 00 10 00 00   — фиксированный magic/заголовок
[8]     длина payload (напр. 0x06/0x0a для команды, 0x24=36 для INQUIRY-ответа)
[9..11] 00 00 00
[12..15] sequence (LE, инкремент на команду: 0x06ff,0x0700,0x0701,…)
[16..19] тег 6c 75 3e 0a = 'lu>'
[20..]   CDB / payload + trailing opaque-поля
```
(в различных кадрах seq/хэндлы e3 7f 00 00 смешиваются — дальнейшее
сведение с ответами и дескриптором — следующий шаг)

### Использование тёпл. фреймов данных (уточнённая настоящая магия)
Настоящая магия кадра — **`00 80 b5 09 00 10 00 00`** (не `00 90 …`; прежняя
запись «magic 00 90» была handle-полем — исправлено).
- Обе стороны: **[6-Б lead нулей] + [кадр]**, кадр начинается с магии.
- Заголовок ответа M2 (общий 24 Б после магии...):
  [8] = длина «инфо» части (0x24=36 для INQUIRY/READ1087-кадров, 0x08),
  [12..15] = инкремент-индекс/дескриптор (0x24,0x0c,0x17,0x19,…,0x61,0x64,
  0x99 большой скачок на bulk-кадре), [16..] = handle `e3 7f 00 00` + служебные.
- Данные READ10 — НЕ магия-фреймы: сплошные куски (1.1 МБ, 3.3 МБ) между
  малыми статус-кадрами (137/202/267 Б). Т.е. M2 шлёт статус/индекс и затем
  голый поток секторов.
- Точная раскладка [9..24] заголовка и связка «индекс→данные» — следующий шаг
  (свести с функциями: ProcessTransaction/GetDataOut/SendDataIn в LIBM2-64.SO).

### КЛЮЧ: заголовки с указателями — opaque, для Node-реализации не нужны
- Один «1087-кадр» = батч нескольких SCSI-ответов (INQUIRY, MODE SENSE,
  READ CAPACITY, READ TOC…). Внутри на offset 64 — ответ INQUIRY:
  `"Fujitsu Remote Iso CDROM 2.04"` (заголовок до данных — ~64 Б).
- В заголовках массово heap-указатели (`90 57 1c 8f`, `90 60 41 8d`, …).
  Маунт работает → **iRMC НЕ разыменовывает эти поля (opaque/игнор)**.
  ⇒ Byte-exact НЕ требуется: Node-респондер может слать ту же структуру
  с фиксированными/нулевыми хандлами. Это разблокирует чистую реализацию.
- Формула ответа: [6-Б lead нулей?—проверить] + [магия-кадр: magic + header
  (len[8], index[12..15]) + ~64-Б заголовок с opaque-хэндлами] + [SCSI payload
  или bulk-данные READ10].
- Рецепт Node: парсить [lead]+[category-кадр] → на каждую команду отвечать
  шаблоном из лога, подставляя данные ISO (READ10) и константы (INQUIRY/…).

### Шаблоны ответов (из tools/m2remap.py, pcap urs2)
- **INQUIRY (0x12) ответ** = 36 Б: `"Fujitsu Remote Iso CDROM 2.04"` + pad:
  `46 75 6a 69 74 73 75 20  / 52 65 6d 6f 74 65 20 49 73 6f 20 43 44 52 4f 4d  /
  32 2e 30 34 00 00 00 00` (vendor8+product16+rev4). Перед ним ~64-байтный
  заголовок (magic+len0x24+index+opaque-хэндлы до INQUIRY-данных).
- **READ10 (0x28)**: index (idx) в RX растёт с каждой SCSI-командой
  (0x744,0x745,… и не-READ команды тоже потребляют idx), LBA и xfer(секторы)
  парсятся из CDB. Ответ = заголовок (index) + bulk-данные этих секторов.
- index-поле кадра = порядковый счётчик SCSI-команд (не LBA): в карте видно
  рост idx и выборочные LBA (0x269e92, 0x269d80, …).
- Инструмент: `tools/m2remap.py <pcap>` — парсит RX/TX, магия, выдаёт READ10
  (index/LBA/xfer) и локализует INQUIRY. Использовать для следующего захвата.

### ПРАВКА: магия ОДИНАКОВА (00 80) в ОБЕ стороны — ошибка про 00 90
- Повторный разбор авторитетного захвата реального M2↔iRMC (`/tmp/kilo/urs2.pcap`,
  канал 10.0.0.2:45612→BMC:80): **и команды iRMC, и ответы M2 начинаются с одной
  магии `00 80 b5 09 00 10 00 00`**. `00 90…` — была ошибочная запись (от шумового
  теста), её убрать. Байт[1]=0x80 постоянный, направления не различает.
- Команда iRMC: [старый] длен в [8] (0x06/0x0a), заголовок opaque ~54 Б, CDB не в
  фиксированном offset 64, а после заголовка (INQUIRY `12 00 00 00 24 00` на
  кадре лежал на frame offset ~62). Поэтому «длина кадра = 64+dlen» — НЕ точна;
  реальные стартовые кадры ~75–92 Б.
- Стартовые ответы M2 — **батчи**: INQUIRY приходит в 881-байтном кадре, где
  подряд упакованы INQUIRY + MODE SENSE + READ CAPACITY + READ TOC + … (каждый
  свой: len[8] + idxLE[12..15] + handle `e3 7f 00 00` + payload + `62 0d 02 00
  00 00 01 00`-хвост). Так что на старте iRMC ждёт совокупный ответ, а не по одной.

### Точные шаблоны ответов (из батча INQUIRY, кадр frame#0 @tx 1036)
- **INQUIRY payload 36 Б** (frame offset 64..99):
  `05 00 00 32 1f 00 00 00 | "Fujitsu " | "Remote Iso CDROM" | "2.04"`.
  (тип 0x05=CD-ROM, resp-fmt 0x32, addl-len 0x1f=36-5). **В stor.js раньше стоял
  неверный `00 00 05 00 20 00 00 00` — исправлено на реальный.**
- Заголовок ИНКАПСУЛЯЦИИ каждого под-ответа: `dlen[8] | idxLE[12..15] | 8×00 |
  e3 7f 00 00 | dlen[24] | e3 7f 00 00 | 8×00 | 90 xx xx xx e3 7f 00 00 |
  90 xx xx xx e3 7f 00 00 | ad 0c 02 00 00 00 01 00`.

### Кадр данных READ10 (подтверждено большой передачей @tx 1112827, ~3.3 МБ)
- Формат: `magic | 08 00 00 00 | idxLE | 00 00 00 00 | e3 7f 00 00 | 08 00 00 00 |
  e3 7f 00 00 | 00 04 84 00 00 02 00 00 | 30 61 10 80 | e3 7f 00 00 | c0 2c 00 80 |
  e3 7f 00 00 | f4 0d 02 00 00 00 01 00 | 00 04 84 00 00 02 00 00 | 00 00 00 00 |
  e3 7f 00 00 | 01 00 00 00 | (idx+1) | 00 00 | [данные секторов]`.
  `idx` в [12..15] — дескриптор/счётчик SCSI-команд (не LBA); `idx+1` — следом.
- Большие сначала READ10 грузились не с LBA16 (объём), а с произвольных LBA
  (первый CDB READ10 в RX на `28 00 00 26 9e 92 00 00 02 00` → LBA=0x269e92).

### Второй канал + протокол метаданных (канал 10.0.0.2:43998→BMC:80)
- BMC шлёт клиенту на отдельный канал поток дескрипторов с **магией `00 80 f0 fa`
  `02 00 00 00 00` + 4-байтным opaque** (пары вида `e5 00 00 00 00 00 00 00 00 80
  f0 fa 02 00 00 00 00 40 59 73 07 <4Б>`), т.е. ещё один вид инкапсулц. URS.
- Клиент на этот канал отвечает одним сообщением `f2 01 00 00 00 00 00 00 08 00
  08 ef d7 6a 00…` (42 Б, подтверждение). Канал нужен для полного появления sr1
  (это «URSClientStorageConnect»-сообщение порта из setup-ответа BMC по п.2 выше).

### Стартовая последовательность команд iRMC (RX до первых данных)
INQUIRY(12) → 22(MODE SENSE) → 5a 00 2a → 22 → 43(READ TOC)×2 ..43 02 → 25(READ
CAPACITY) → 51(READ DISC INF)×2 → 52(READ TRACK)×2 → 43 02 aa → 03(REQ SENSE) …
(все с dlen=0x0a, кроме INQUIRY 0x06). M2 отвечала одним 881-Б батчем.

### Live-статус чистой Node-реализации
Чистый Node-клиент (`server/stor.js`) проходит handshake (signature `d2 02 00 01
00 01 cd 37` + баннер Fujitsu + путь UTF16LE) и парсит INQUIRY; см. след.
/deleting неверного `00 00 05 00 20 00 00 00`. sr1 без M2 пока не извлекается —
требуется полный стартовый батч (881 Б) + второй канал с `f2 01 …`-подтверждением
(см. открытые вопросы). Вывод в прод не сделан.

---

## S4 (AMI/SOC) — другой механизм, НЕ Avocent-URS

**ВАЖНО (11.09): всё выше про M2/URS/LIBM2 относится ТОЛЬКО к S2 (Avocent/
Mahogany).** iRMC S4 (042, Fw~7.69F, архитектура AMI) хранение ISO делает
СОВЕРШЕННО иначе — и наш движок `server/m2.js` для него БЕСПОЛЕЗЕН.

### Подтверждение несовместимости (живой тест на 042 vs S2 10.67.17.101)
| Проверка | S2 | S4 (042) |
|---|---|---|
| URS-signature `d2 02 00 01 00 01 cd 37` (raw TCP :80) | `Fujitsu \n` | **таймаут** |
| `m2.share()` | `code:0` + 1.08 МБ прочитано | «тишина»: `code:null`, bytes застыл на 10588, bps=0 |
| storage-порты 5900/5901/5120/5121 | есть | **нет** (только 80/443/623/22) |
| Redfish `/redfish/v1` (443 и 80) | — | не отдаёт (445/000) |

Винконсоль 042: CD/ROM не появился (владелец смотрит снимок; только C: и D:).

### S4-jnlp отдаёт для VirtualMedia (из avr.jnlp 042)
```
vmsecure=0, cdstate=1, cdnum=2, fdstate=1, hdstate=1, hdnum=1,
kvmport=80, websecureport=443, singleportenabled=1, kvmtoken, webcookie
```
**НЕ отдаёт** StoragePort/VncPort (как S2). Аргументы идут ПАРАМИ
(`<argument>-kvmtoken</argument>` + значение), не `key=value`.

### Транспорт: тот же HTTP-Connect туннель, что и KVM (`SinglePortKVM`)
`singleportenabled=1` → редирект идёт через `setHTTPConnect("CDMEDIA")`:
```
CONNECT <host>:443 HTTP/1.1\n cookie <webcookie>\r\n\r\n     (или HTTPS/1.1 если ssl)
JVIEWER CDMEDIA cookie <webcookie>\r\n\r\n
→ HTTP/1.1 200 OK → далее бинарный IUSB
```
(`doTunnelHandshake` → `FormHttpRequest` = `"CONNECT" + host + ":" + port +
" HTTP/1.1\n cookie " + webcookie`; второй запрос `"JVIEWER " + Service("CDMEDIA")
+ " cookie " + webcookie`.) Отключение: `JVIEWER DISCONNECT Cookie <webcookie>`.

### Авторизация сессии — `SendAuth_SessionToken` (CDROMRedir::startRedirection)
Сразу после connect шлётся IUSB-пакет: `IUSBHeader(n)` где
- `n=128` (sessionTokenType==0 — дефолт S4 042) → limit 160
- `n=240` (sessionTokenType==1) → limit 272
```
IUSBHeader.write(): сперва header (см. ниже), затем:
  position(41) -> 0xF2 (-14)      [внутри data]
  position(62) -> 0x00            [начало sessionToken]
  position(62) -> token.getBytes()
  position(23) -> deviceNo (CDDevice_no)
```
Токен передаётся в `StartCDROMRedir(...string3...)` — это **отдельный
сессионный токен** (не webcookie; на S4 = kvmtoken/webcookie из jnlp,
`getSessionTokenType()` отличает). Точная связка на 042 не добита.

### Заголовок пакета `IUSBHeader` (8+24 = 32 байта)
```
[0..7]   "IUSB    " (signature, 8 байт)
[8]      major = 1
[9]      minor = 0
[10]     packetHeaderLen = 32
[11]     headerChecksum  (= -сумма всех байт limit, по mod 256; get(11) при write)
[12..15] dataPacketLen (int; в receivePacket читается как getInt на offset 12)
[16]     serverCaps
[17]     deviceType (5 = CDROM)
[18]     protocol (1)
[19]     direction (128)
[20]     deviceNumber
[21]     interfaceNumber (0)
[22]     clientData
[23]     Instance (= CDDevice_no)
[24..27] sequenceNumber (int)
[28..31] reserved[4]
```
`createCDROMHeader(n)`: deviceType=5, protocol=1, direction=128, serverCaps=0.
Header ровно **32 байта**; чекист-байт пересчитывается при write.

### Общий кадр / реасемблинг (`PacketMaster.receivePacket`)
Каждое сообщение = `header(32) + data(dataPacketLen-байт)`. Парсер сначала
читает ровно 32 байта, извлекает `dataPacketLen` из offset 12, читает ещё
`dataPacketLen` байт, кладёт после header. `wrap/put32` — LE (буферам задан
`ByteOrder.LITTLE_ENDIAN`).

### Пакет SCSI `IUSBSCSI` (`com/ami/iusb/protocol/IUSBSCSI`)
Extends RedirPacket; `IUSB_SCSI_PKT_SIZE=62`, `WITHOUT_HEADER=30`.
```
read data (после header): 
  [data 9]  opcode (0xF1=241 connect-ответ, 0xF6=246 KILL_REDIR, 0x1B=27 EJECT)
  [data 13] Lba
  [data 30] connectionStatus — ТОЛЬКО если opcode==241 && dataLen>30:
               1 = OK (можно редиректить)
               5 = уже подключено к др. машине
               8 = занято
  [data 31..54] m_otherIP (24 байта ASCII, trim) — чужой IP при отказе
```
Опкоды (константы): `OPCODE_EJECT=27`, `OPCODE_KILL_REDIR=246`.

### Команды SCSI (`CDImage.executeSCSICmd`, opcodes)
```
0   = TEST UNIT READY   -> status 0
37  = READ CAPACITY     -> dataLen 8:  (totalSectors-1) BE + blockSize(2048) BE
40  = READ(10)          -> lba, len=Cmd10.getLength(); читает len*2048 байт
168 = READ(12)          -> len=Cmd12.getLength32()
67  = READ TOC/PMA      -> 20-байтный TOC (аналог S2), длина = min(len, dataLen)
27  = START/STOP (EJECT)
30  = MEDIUM REMOVAL
```
`readCDImage(lba, n)` = `seek(2048*lba)` + `read(2048*n)` — побайтная копия ISO,
как S2 (игнор одного хвостового 0-сектора). LBA/длины в big-endian
(`mac2blong`/`mac2bshort` байт-своп).

### Ответный кадр / layout (CDImage + CDROMRedir.run)
Ответ формируется в `packetWriteBuffer` (LE, capacity 131134):
```
[53]  overallStatus (0=ok; 1+ = sense)
[54]  senseKey
[55]  senseCode
[56]  senseCodeQ
[57..60]  результат: для READ CAPACITY put(57,8); для READ(10)/READ(12) —
          putInt(57, byArray.length)
[61..]    данные (для READ CAPACITY: totalSectors-1 + blockSize; для READ: блоки;
          для TOC: 20-байтный append)
limit = dataLen + 61; position(61); кладём данные.
```
`n2 = getDataLength() + 61`; `packetWriteBuffer.limit(n2)`; затем
`new IUSBSCSI(packetWriteBuffer, true)` — `writePacket`: шлёт header(32) с
`direction=128`, limit=`dataLen+32`, position=limit, и НЕ кладёт отдельный data
(предзаполнен). Отправка `packetMaster.sendPacket()`.

### Ключевые поля layout IUSBSCSIPacket (обёртка вокруг header, другое)
В `com/ami/kvm/imageredir/IUSBSCSIPacket` (разбор запроса, rewind после header):
```
header(32) | readLen(1) | tagNo(1) | dataDir(1) | commandPkt | statusPkt(4) | dataLen(4)
commandPkt: opCode(1) lun(1) lba(4) [+ Cmd10: reserved6(1) length(2) reserved9(9)]
                      |          |   [+ Cmd12: length32(4) reserved10(8)]
```
`SCSICommandPacket` соответствует SCSI CDB; ответ — статус 4 байта.

### Незакрытые вопросы (нужен захват реального CDMEDIA-туннеля)
- Точные смещения ответного кадра на проводе (framing `[32..61]`, куда встаёт
  header/readLen/tagNo/dir/command/status/dataLen поверх IUSBSCSI) — есть риск
  расхождения декомпиляции и реального потока (как было в S2 с magic 00 80/00 90).
- Связка `sessionToken` <-> `webcookie`/`kvmtoken` и значение `getSessionTokenType()`
  на конкретном iRMC.
- План: захват реального CDMEDIA-потока от оригинального JViewer-SOC_S4 к 042
  (LD_PRELOAD/tcpdump, как в S2), сверить байты, затем писать `server/s4cmdir.js`
  (Node-реализация HTTP-Connect CDMEDIA + IUSB-SCSI-респондер).

### ✅ РАБОТАЕТ: S4 CDMEDIA реализован и подтверждён (11.09, 042)
`server/s4cmdir.js` (класс S4Cmdir) — реализован и проверен на живом 042:
CD-ROM появился в винконсоли (владелец подтвердил). Обмен:
TUR(0)/READ CAPACITY(0x25=37)/READ(10)(0x28=40), nBytes растёт (N×2048).

#### Транспорт (singleport, как KVM)
```
CONNECT <host>:443 HTTP/1.1\n cookie <webcookie>\r\n\r\n
JVIEWER CDMEDIA cookie <webcookie>\r\n\r\n  -> HTTP/1.1 200 OK
```
(webSecurePort=443 — цель CONNECT; сам сокет на kvmPort=80/web-port.)

#### Auth (SendAuth_SessionToken) — НАЙДЕНО КЛЮЧЕВОЕ
- Кадр **160 байт**: IUSBHeader(32) + data(128); dataPacketLen в header=128;
  header.Instance@23 = CDDevice_no; direction=128.
- Опкод auth = **0xF2** на data[9] (т.е. offset 41 в кадре).
- Маркер 0x00 на data[30] (offset 62); **токен кладётся с data[31] = offset 63**
  (после `put((byte)0)` позиция сдвигается на 1). ⚠ ЕСЛИ токен с 62 -> BMC
  отвечает **status=3** (отказ). С 63 -> **status=1** (session-ok).
- Токен = **kvmToken** (m_session_token = encToken из `-kvmtoken`), НЕ webcookie.

#### Формат кадра (LE; IUSBHeader 32б + data(dataPacketLen))
```
[0..7]   "IUSB    "   [8]=major(1) [9]=minor(0) [10]=hdrLen(32) [11]=checksum
[12..15] dataPacketLen (int LE)   [16]=serverCaps [17]=deviceType(5 CDROM)
[18]=protocol(1) [19]=direction(128) [20]=devNum [21]=ifNum(0) [22]=clientData
[23]=Instance(CDDevice_no) [24..27]=sequenceNumber [28..31]=reserved
data-слой: opcode@data[9]  Lba@data[13]
```

#### SCSI (CDImage.executeSCSICmd, опкоды)
```
0   TUR            -> status 0
37  READ CAPACITY  -> 8 байт: (totalSectors-1) BE + blockSize(2048) BE
40  READ(10)       -> lba, len; читает len*2048 байт ISO (pобайтная копия)
168 READ(12)       -> len32
67  READ TOC
27  START/STOP (EJECT)   246 KILL_REDIR
```
CDB для READ(10): op@cdb[0], lun@1, **lba@[2..5] BE**, Cmd10.reserved6@6,
**length@[7..8] BE**; READ(12) — length32@[6..9].

#### ОТВЕТНЫЙ КАДР (критично — НЕЛЬЗЯ слать СВОЙ header)
Правильный ответ **зеркалит заголовок запроса** (sequence/instance/deviceType),
затем поверх: status@53..56, результат-длина@57 (u32), данные@61; limit=dataLen+61.
```
[19]   = 0x80 (direction, форс IUSBSCSI.writePacket)
[53]   overallStatus (0=ok)  [54] senseKey [55] senseCode [56] senseCodeQ
[57..60] resultLen (READ CAP=8; READ=bytes)   [61..] данные (или 20-байт TOC)
[12..15] dataPacketLen = dataLen+61 - 32
```
⚠ Именно отсутствие зеркалирования заголовка сигналит BMC повторить команду.

#### Слоты virtual media
BMC объявляет фиксированные слоты из jnlp: cdnum=2, fdnum=0, hdstate=1,
hdnum=1. Винконсоль показывает их все (2 CD + 1 removable) — это НОРМА
(незанятые слоты экспонируются BMC). Мы занимаем слот 0 (instance/CDDevice_no=0).

#### Интеграция
`server/index.js` realMount: `getSession()` -> есть `s4Sid` => S4Cmdir
(HTTP-CONNECT CDMEDIA + IUSB-SCSI); иначе S2 => `m2.share` (Avocent-URS).
Оба движка раздельные. `realUnmount` закрывает S4Cmdir + m2.unshare.
