# HP Lights-Out 100 (DL180 G6): KVM по протоколу Mahogany

Проверено на живом BMC HP ProLiant DL180 G6 (iLO100, 192.168.6.51, прошивка
LO100i): вебка и KVM-апплет устроены так, что **тот же мост Mahogany→noVNC
подходит для HP** с точечными отличиями. Сырьё: `raw/M2.JAR` (jar апплета,
выдаётся самим BMC на странице KVM), декомпиляция CFR в `/tmp/m2_decomp/`.

## Веб-интерфейс BMC

- Только HTTP:80 (digest). Вебка отдаёт меню: Summary, Virtual Power
  (chassis.html), Sensors, SEL (sel.html), **Virtual KVM/Media (kvms.html)**,
  Virtual Storage (vstorage.html), Hardware Inventory, User Admin, Network
  Settings, PET, License Key, Security (sAdmin.html), Firmware Download.
- Digest-логин работает нашим `digestGet` (server/discover.js) — 200 OK.
- BMC нежный к частым запросам: подряд идущие GET рвёт ECONNRESET;
  между запросами пауза ≥2 с, ретраи обязательны.

## Апплет KVM (kvms.html)

`<APPLET CODE="com.serverengines.mahogany.MahoganyViewer.class" ARCHIVE="M2.JAR">`
с параметрами:

- `NonSecure_KVMPort=80` — **KVM слушает порт 80** (TCP plain, не 5900);
- `sessiontype=kvm`; `port=5901` — локальный storage-порт M2 (проброс ISO);
- `ipaddress=<BMC IP>`;
- `httpdata=<96 hex-символов>` — **одноразовый токен сессии** (48 байт),
  BMC генерит его в HTML после успешной digest-аутентификации; это НЕ пароль;
- `username=Administrator`.

Т.е. подключение KVM = (1) digest-сессия, (2) GET /kvms.html, (3) парс
APPLET-параметров, (4) TCP на ipaddress:NonSecure_KVMPort.

## Отличия от iRMC S2 в ClientHandshake

Класс тот же (`com.serverengines.mahogany`), сигнатуры embedded
`0x5A5A5A5A`/standalone `0x12121212` — идентичны (см. irmc-protocol.md),
digest-сигнатуры `0x13131313` в M2.JAR нет. Отличия только в полях:

| Поле | HP LO100 | iRMC S2 (наш irmc.js) |
|---|---|---|
| username | pad 16 | pad 48 |
| password | pad 20 (обрезка!) | pad 48 |
| passwordFull | pad 128 (токен целиком) | pad 228 |
| порт KVM | 80 (NonSecure_KVMPort) | 5900/порт апплета |
| secret | httpdata-токен из kvms.html | пароль |

В Java: `m_password` копируется в массив ровно 20 символов (лишнее
обрезается), `m_passwordFull` — 128. Каскад: password=первые 20 символов
токена, passwordFull=токен(96)+нули до 128.

## Сессия (CConn.init)

- standalone/applet: если параметры переданы — `m_isEmbeddedApplet=true`
  (апплет всегда embedded → сигнатура 0x5A5A5A5A).
- connect.as: `kvm` → plain TCP, `kvmssl` → SSL c ServerEgninesTrustManager
  (trust-all). HP-прошивка 2009: TLS на 443 (web), KVM на 80 plain.
- Сразу после connect: `MessageSender.sendClientNOP()`, затем
  `sendClientHandshake(embedded, user, pass, passFull, 31, "")` — привилегии
  31, как у нас в irmc.js.

## Движок M2 (проброс ISO)

- В jar: `LIBM2-32.SO` / `LIBM2-64.SO` (2009-12-30). Класс `LUD`
  (nativeinterface) распаковывает .so в ~/имя-пользователя/..., пишет
  `StorageServer.Port` (= параметр `port`, 5901), dlopen, ждёт фактический
  порт. Тот же механизм, что `server/m2host.py` у Серёги — **но нужен ли он
  HP**: у LO100 есть отдельная вкладка Virtual Storage (vstorage.html) —
  проверить отдельно.
- StorageMsgRequest (дискавери M2, id=0) тоже в M2.JAR — формат как в
  irmc-storage.md.

## Модуль HP (server/hp.js) — РЕАЛИЗОВАН

`server/hp.js`: `fetchKvmApplet(cfg)` (digest GET /kvms.html с ретраями и
паузами ≥2 c → парс APPLET-параметров) + `openHpConsole(cfg, events)` —
`IrmcClient` с `pad: {user:16, pass:20, full:128}`, `port=NonSecure_KVMPort`,
`httpdata=токен из kvms.html`. Интеграция в `server/index.js` `startSession`:
если `cachedSession` падает «no avr.jnlp link in page» — пробуем HP-ветку.
Декодер и VNC-мост не менялись (тот же протокол).

**Подтверждено на живом 192.168.6.51 (DL180 G6, fw 4.22):** `/api/connect`
даёт `state=live, 1024×768`, снимок `/api/snapshot` отдаёт реальный кадр
(PNG ~11.5 КБ). Расшифровка видео, курсор и клавиатура — тем же механизмом,
что iRMC (см. irmc-protocol.md).

## Связанные страницы

- irmc-protocol.md — общий протокол (рукопожатие, таблицы команд).
- irmc-storage.md — M2-движок и проброс ISO.
- irmc-ipmi.md — метрики по IPMI-over-LAN (не зависят от вендора).
