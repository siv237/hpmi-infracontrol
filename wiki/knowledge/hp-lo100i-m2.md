# HP ProLiant DL180 G6 / Lights-Out 100i: raw/M2.JAR (Mahogany)

`M2.JAR` (685 КБ, сборка 2009-12-30) — Java-вьювер **Mahogany** для HP
**Lights-Out 100i (LO100i)** на ProLiant DL180 G6. Это тот же Avocent-стек,
что и у Fujitsu iRMC: рукопожатие и таблица команд совпадают, отличия
точечные (паддинги кредов, нет digest, способ выбора SSL). Внутри —
нативный движок `LIBM2-*.SO`, тот же класс движка, что используется для
проброса ISO у iRMC (см. knowledge/irmc-storage.md, server/m2host.py).

## Состав jar (unzip -l, декомпиляция CFR)

- `LIBM2-32.SO` (120 813 Б), `LIBM2-64.SO` (144 593 Б) — нативный движок M2.
- Пакеты: `com/serverengines/mahogany` (вьювер: CConn, MahoganyViewer,
  MessageSender/MessageReceiverThread, PixelBufferImage, DesktopWindow…),
  `mahoganyprotocol` (протокольные классы: handshakes, Command,
  StorageMsgRequest…), `kvm` (Configuration/параметры, LogWriter),
  `nativeinterface` (LUD — загрузчик .so), `storage` (диалоги проброса
  ISO: MountedDriveMgr, ConnectRemoteStorageDlg, DriveType…), `cookies`,
  `helper`, `keyboard`, `resmgr`, `sessionmgmt`.
- Декомпилировано CFR 0.152 в `/tmp/m2_decomp` (tmp неперсистентен —
  восстановить: `java -jar cfr-0.152.jar raw/M2.JAR --outputdir ...`).

## Приложение MahoganyViewer (JApplet)

Параметры апплета (= имена param из веб-страницы BMC): `ipaddress`,
`username`, `httpdata` (пароль!), `port` (storage-порт, default **5901**),
`NonSecure_KVMPort` / `NonSecure_KMPort` / `NonSecure_VPort`,
`SSL_VMPort` / `SSL_KPort`, `sessiontype` = **`kvm`** | **`kvmssl`**.
Входная точка: `run()` → `new CConn(...)` → `CConn.init(...)` →
`startReceiverThread()`.

## Рукопожатие — идентично iRMC

- Сигнатуры: embedded-апплет `0x5A5A5A5A`, standalone `0x12121212`
  (из констант протокольных классов).
- `ServerHandshake` id **200** → `ClientHandshake` id **221**,
  привилегии **31** («kvms»), затем `ClientNOP`.
- Digest-сигнатуры `0x13131313` в jar **нет** (в iRMC S2 есть).

## Отличия протокола HP LO100i от iRMC S2 (по разбору CConn.init)

1. **Паддинги кредов**: username pad→**16**, password pad→**20**,
   passwordFull pad→**128** (iRMC S2 в нашем server/irmc.js: 48/48/228).
   Короткое имя дополняется NUL-ами, длинное обрезается; то же для паролей.
2. **SSL**: выбор по настройке `connect.as.method` (=1 → SSL): SSLSocket с
   TrustManager «доверять всем» (`ServerEgninesTrustManager`); порт — из
   `SSL_KPort`/`SSL_VMPort` параметров. Не-TLS — plain `Socket` на
   `NonSecure_KVMPort`.
3. После установки сокета: `setSoTimeout(20)` и `ClientNOP` — как в iRMC.
4. Таблицы команд/событий — те же ID (проверено по MessageSender/
   MessageReceiverThread: NOP/KeyDown/Pointer/FB-события/Storage-ветка).

## Нативный движок M2 (nativeinterface/LUD)

- Извлекает `LIBM2-<32|64>.SO` (выбор по `os.arch` x64/amd64) из jar в
  домашний каталог, пишет файл `StorageServer.Port` (= параметр `port`,
  5901), затем dlopen — движок поднимает локальный StorageServer и
  работает в своих потоках. Тот же механизм, что повторяет
  `server/m2host.py` для iRMC (StorageServer.Port → ActualPort).
- Checksum .so при распаковке: вращающийся XOR (l = (l<<1 | carry) ^ byte).
- Storage-классы (`storage/*`, DriveType: `DT_UNKNOWN_DEVICE = -1` и др.) —
  локальный протокол Java↔M2 идентичен iRMC-шному (см.
  knowledge/irmc-storage.md): discovery 544 Б (0xFE) / share 544 Б (0xFA) +
  URSStorage.

## Следствия для модульной архитектуры

- Отличие протокола HP — **точечное**: только набор паддингов кредов,
  наличие/отсутствие digest и правило выбора порта/TLS. Всё остальное
  (handshake, команды, декодер видео, bridge→noVNC, M2-storage) общее.
- План: параметризовать `IrmcClient` профилем BMC («flavor»):
  `{userPad:16|48, passPad:20|48, pwdFullPad:128|228, digest:false|true,
  tls:'method'|'auto'}` — профили `fujitsu-irmc` (default) и `hp-lo100i`.
- Автодетект LO100i vs iRMC по handshake не различить (одинаковы) — тип BMC
  задаётся вручную в карточке сервера (поле «тип BMC»).
- IPMI-канал (server/ipmi.js, ipmitool) у LO100i должен работать как есть
  (IPMI 2.0 over LAN) — проверить на живом сервере.
- raw/M2.JAR в git не попадает (`.gitignore: *.jar`), лежит локально в raw/.
