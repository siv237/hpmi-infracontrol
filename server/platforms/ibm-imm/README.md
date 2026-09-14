# ibm-imm — IBM System x Integrated Management Module (IMM/IMM2)

Живой BMC: **10.67.17.17**, прошивка BMC **8.41**, IPMI 2.0
(mfg id 20301 «IBM eServer X», productId 0x0144), board 80Y9299 (2012).

## Что проверено (10.67.17.17)

- **Веб:** только HTTPS:443. HTTP:80 открыт, но на HTTP не отвечает.
  Стартовая страница — IBM IMM Dojo-UI (`/designs/imm/…`, `ibmdojo`,
  `imm.layer-login`). Redfish отсутствует (`/redfish/v1/` → 404), `/login` → 404.
- **IPMI (RMCP+, UDP 623):** работает. SEL — 35 событий; lan print (MAC/IP,
  fw 8.41); FRU — baseboard (80Y9299). SDR-сенсоры (темп./кулеры) не отдались
  (temps=0/fans=0), chassis power — null (см. manifest.capabilities.ipmi).
- **Консоль:** НЕ VNC. Это **IBM Custom Avocent KVM**: страница отдаёт JNLP
  `viewer(<host>@443@…@jnlp@<user>@…).jnlp`, приложение
  `com.avocent.ibmc.kvm.Main`, **KVM-порт 3900** (TCP открыт).
  Токен сессии — hex в аргументе `user=0x…` (генерится `remote-control.php`).
  JAR вьювера — `/designs/imm/aessrp/avctIBMViewer__V030321.jar` (+ нативные
  `avctKVMIO*`/`avctVMAPI*` по ОС); качается **без авторизации**.

Пример JNLP лежит в `raw/viewer(10.67.17.17@…).jnlp`.

## Статус

- **probe-only** (`capabilities.kvm=false`): распознаём IMM по веб-сигнатуре,
  IPMI-данные собирает штатное ядро.
- **KVM-мост — в планах.** Путь как у S2/S4: взять `avctIBMViewer__V030321.jar`,
  декомпилировать (CFR), разобрать протокол Avocent IBM Custom на порту 3900
  (handshake/токен/кадры/HID) и реализовать `login()` + `createConsole()`.
  Не делать консоль/логин общими с `mahogany-avr`/`hp-lo100` — другой продукт
  Avocent, HP/IBM-специфику не навязывать другим платформам.

# Файлы
- `manifest.js` — метаданные (priority 92, access, capabilities)
- `probe.js` — проба веб-сигнатуры (+ чистая `matchImm` для тестов)
- `index.js` — фасад для реестра (пока только probe)
- `test.js` — самотест модуля
