# IBM System x IMM/IMM2 (Avocent KVM) — платформа

Живой BMC: **10.67.17.17**. Прошивка BMC **8.41**, IPMI 2.0, mfg id 20301
(«IBM eServer X»), productId `0x0144`, board `80Y9299` (2012). Модуль:
`server/platforms/ibm-imm/` (probe-only).

## Что за железо (10.67.17.17)

- **Веб** — только HTTPS:443 (Dojo-UI IBM IMM: `/designs/imm/…`, `ibmdojo`,
  `imm.layer-login`). HTTP:80 порт открыт, но на HTTP не отвечает.
  Redfish отсутствует (`/redfish/v1/` → 404). `/data/login.js` → 401.
- **IPMI (RMCP+)** — работает: SEL 35 событий, lan print (IP/MAC, fw 8.41),
  FRU baseboard (80Y9299). SDR-сенсоры (темп./кулеры) не отдались
  (temps=0/fans=0), power по chassis — null.
- **Консоль — НЕ VNC** (несмотря на открытый 5900). Это **IBM Custom Avocent
  KVM**: страница отдаёт JNLP `viewer(<host>@443@…@jnlp@<user>@…).jnlp`,
  приложение `com.avocent.ibmc.kvm.Main`, **KVM-порт 3900** (TCP открыт).
  Аргументы JNLP: `kmport=3900`, `vport=3900`, `user=0x…` (hex-токен сессии,
  генерится `remote-control.php`), `passwd=` пусто, `immversion=2`, `vm=1`
  (виртуальный носитель), `apcp=1`, `color=2`.
- **JAR вьювера** — `/designs/imm/aessrp/avctIBMViewer__V030321.jar` (+ нативные
  `avctKVMIO*`/`avctVMAPI*`); качается **без авторизации** (1.17 МБ).
  Скачан в `raw/avctIBMViewer__V030321.jar` (обфусцированные классы `a/a/…`).
  Образец JNLP — `raw/viewer(10.67.17.17@…).jnlp`.

## Статус модуля

`probe-only`: распознаём IMM по веб-сигнатуре (`platforms/ibm-imm/probe.js`),
IPMI-данные (SEL/FRU/lan print) собирает штатное ядро. `capabilities.kvm=false`.

## План: KVM-мост (Avocent IBM Custom, порт 3900)

Повторяем путь S2/S4:
1. Декомпилировать `raw/avctIBMViewer__V030321.jar` (CFR) — найти
   `com.avocent.ibmc.kvm.Main` и протокольные классы (handshake, токен, кадры,
   HID). Классы обфусцированы (`a/a/…`) — искать по строкам/константам.
2. Понять: как `login()` получает JNLP (форма IMM → `remote-control.php`) и
   как из `user=0x…`/`passwd` строится рукопожатие на 3900.
3. Реализовать в модуле `login()` + `createConsole()` (видео+HID, канон
   `0x00RRGGBB`), виртуальный носитель (`vm=1`) — отдельно.
4. НЕ делать движок/логин общими с `mahogany-avr`/`hp-lo100`: другой продукт
   Avocent; изоляция, чтобы не сломать Fujitsu/HP.

## Связанные страницы

- platform-module-manifesto.md — контракты модулей.
- irmc-protocol.md, irmc-storage.md — как делались Avocent-мосты (S2).
- wiki/index.md, `server/platforms/ibm-imm/README.md`.
