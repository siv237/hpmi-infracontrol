# iRMC S4 / JViewer_S4 — исследование протоколов и механизмов для «ИнфраКонтрол»

**Цель:** материалы для нового модуля работы с KVM-экраном и проброса ISO на Fujitsu PRIMERGY с iRMC S4 (то, что внутри JViewer_S4.jar), в дополнение к уже написанному модулю iRMC S2.
**Метод:** сбор публичных источников (официальная документация Fujitsu, блоги инженеров Fujitsu, OpenStack-код, GPL-исходники прошивки BMC, форумы) + разбор реальных реализаций протокола.
**Дата:** 2026-09-10.

---

## 1. Резюме: главные зацепки для проекта

1. **Java-консоль iRMC S4 запускается одним HTTP-запросом**: `https://<irmc>/avr.jnlp` (HTTP **Digest**-auth). JNLP ссылается на `JViewer_S4.jar` и содержит параметры сессии, включая **короткоживущий одноразовый пароль**. Это стартовая точка реверса: JAR скачивается с того же BMC и декомпилируется.
2. **В iRMC S4 уже есть встроенный браузерный KVM без Java (HTML5 AVR)** — с прошивки **8.05F** (в списке «New redirection function via HTML5» она появилась уже в 8.0x). Включается галкой `Console Redirection → Video Redirection → HTML5 Viewer Enabled` или SCCI-командой (`ConfigSpace OE=1633`: `0`=Java, `1`=HTML5). Протокол HTML5-вьюера публично не документирован, но это JS-код, отдаваемый самим BMC — вскрывается DevTools-перехватом (скорее всего RFB-подобный бинарный протокол поверх WebSocket на том же 443 порту).
3. **Проброс ISO без Java делается серверно, без участия клиентского браузера**, двумя стандартными API:
   - **SCCI**: XML POST на `https://<irmc>/config` (Basic/Digest auth) — команды `ConnectRemoteCdImage` (0x0252) + ConfigSpace `0x1A60..0x1A66/0x1A80` (источник = **NFS или CIFS**-шара с ISO);
   - **Redfish OEM Fujitsu**: `GET/PATCH /redfish/v1/Systems/0/Oem/ts_fujitsu/VirtualMedia/` + `POST .../Actions/Oem/FTSComputerSystem.VirtualMedia` (типы шар: NFS/SMB; HTTPS-шара — в новых поколениях, на S4 проверить).
   То есть в «ИнфраКонтрол» ISO подключается так: ваш бэкенд экспортирует ISO по NFS/SMB и командой BMC монтирует его как виртуальный CD (`Fujitsu Virtual CD` в boot-меню, F12).
4. **KVM и Virtual Media — лицензируемые функции** (iRMC S4 **Advanced Pack**). Без лицензии модуль экрана/ISO не заработает вообще. Настройка режима консоли и «remote image mount» — глобальные для BMC.
5. **KVM-трафик S4 идёт через тот же веб-порт (443)**: практика коллег из Alteeve показывает, что для работы iKVM через firewall достаточно пробросить только 80/443 (отдельный 5900 пробрасывать не нужно). Ровно как у вас устроено для S2 — проверьте на железе.
6. **GPL-исходники прошивки iRMC S4 выложены на GitHub** (`halmartin/fujitsu_irmc_bmc`): драйвер захвата видеобуфера (`videocap`), инжекции клавиатуры/мыши (`hid`), эмуляция USB-устройств для виртуальных носителей (`iUSB`/`usbe`). Сетевые демоны (web/KVM/Redfish) — проприетарные AMI/FTS, в дампе их нет, но архитектура нижнего уровня теперь известна.
7. Готовые референс-реализации: **python-scciclient** (Apache-2.0, сам Fujitsu для OpenStack), **OpenStack Ironic iRMC-драйвер**, **mmurayama/fujitsu-redfish-samples**, **fujitsu/ansible-irmc-integration** (модули `irmc_setvm/irmc_connectvm/irmc_scci/irmc_session`).

---

## 2. Контекст: что такое iRMC S4 и JViewer_S4.jar

- **iRMC S4** (integrated Remote Management Controller, 4-е поколение) — BMC на платах Fujitsu PRIMERGY поколений RX/TX/CX «M1–M4» (2013–2018: RX1330 M2/M3, TX140 S2, RX300 S7/S8, CX400 и т.д.). Классическая SOC-архитектура AMI/ASPEED, свой Linux 3.14.17, свой web-сервер.
- **JViewer_S4.jar** — Java-клиент «Advanced Video Redirection» (AVR): экран + клавиатура + мышь + виртуальные носители (client-side redirection). Скачивается с самого BMC по Java Web Start (JNLP).
- Отличие от iRMC S2/S3: у S2/S3 консоль называлась так же (JViewer/Java Web Start), но это была другая реализация (era ActiveX/Java, порт и протоколы отличаются) — что вы и заметили: «S4 — другой протокол».
- Название компании: до 2009 «Fujitsu Siemens Computers», iRMC S4 — уже чистый Fujitsu (Fsas Technologies). Старые гайды «Fujitsu-Siemens ServerView Remote Storage» относятся к S1/S2 — на S4 не применимы напрямую.

---

## 3. Сервисы, порты, лицензии

### 3.1 Сетевые службы iRMC S4 (по данным документации и сообщества)

| Порт | Транспорт | Служба | Комментарий |
|---|---|---|---|
| 22 | TCP | SSH | CLI, SOL (serial-over-LAN), туннели |
| 80 | TCP | HTTP | редирект на HTTPS (можно отключить) |
| 443 | TCP | HTTPS | **веб-UI, JNLP/JAR, SCCI `/config`, Redfish `/redfish/v1`, KVM/AVR-канал** |
| 161/UDP | UDP | SNMP | мониторинг (v1/v2c/v3) |
| 427 | TCP/UDP | SLP | discovery |
| 623 | UDP | RMCP+/IPMI | ipmitool/FreeIPMI, SOL, питание |

Важно: **HTTPS-порт переназначаем** (Network Settings → Ports and Services), и KVM при этом продолжает работать — т.е. AVR не привязан жёстко к отдельному порту 5900, как у Supermicro. Отдельного «KVM-порта» в recipe Alteeve не было.

### 3.2 Лицензирование (критично!)

- Базовые функции (web, IPMI, Redfish, питание, сенсоры) — бесплатны.
- **Advanced Pack** (платная лицензия, node-locked): **AVR (KVM) + Virtual Media (+eLCM)**.
- Битмаска фич лицензии: bit 1 = Remote KVM, bit 2 = Remote media, bit 3 = eLCM. Формат лицензии (magic `iRMC`, фичи, тип, CRC32 серийника, AES-128+HMAC-SHA1, base32) полностью разобран сообществом (см. watchmysys в источниках) — это удобно знать для инвентаризации лицензий в ИнфраКонтрол: экспорт конфигурации iRMC («Save Configuration → Include License Information») содержит лицензию, есть валидационные скрипты.
- Redfish-модуль `irmc_connectvm` прямо пишет: «VirtualMedia license may not be enabled», если AllowableValues пустые — по этому признаку можно детектить отсутствие лицензии.

---

## 4. Штатный KVM: как запускается JViewer_S4.jar

### 4.1 Получение JNLP — один curl (проверено инженером Fujitsu, работает для S2/S3/S4)

```bash
# iRMC S2/S3/S4: HTTP Digest auth (не Basic!)
curl -s -k -u admin:admin --digest https://<IRMC>/avr.jnlp -o avr.jnlp

# сразу запустить консоль:
javaws avr.jnlp
```

Для iRMC S5 схема другая (Redfish-токен вместо digest) — это заодно маркер того, что в S5+ веб-слой переехал на сессионные токены:

```bash
TOKEN=$(curl -i -s -k -u admin:admin -H "Accept: application/json" -H "Content-Type: application/json" \
  https://<IRMC>/redfish/v1/SessionService/Sessions -d '{"UserName":"admin","Password":"admin"}' \
  | grep "X-Auth-Token" | awk -F':' '{print $2}')
curl -k -s -H "X-Auth-Token: ${TOKEN}" https://<IRMC>/avr.jnlp -o avr.jnlp
```

**Важно (мажорная деталь):** если в iRMC включён HTML5-viewer, тот же `/avr.jnlp` возвращает **HTML-страницу HTML5-консоли вместо JNLP** (в скрипте Fujitsu это прямо проверяется: `grep "jnlp" || echo "HTML5 Viewer is used"`). Значит **URL `/avr.jnlp` — единая точка входа в консоль в обоих режимах**: это ваш хук для «ИнфраКонтрол» в обе стороны.

### 4.2 Что внутри JNLP

- `<jar href="...">` → URL, по которому лежит `JViewer_S4.jar` (скачивается с BMC, качается тем же digest-запросом).
- `<application-desc><argument>...` → параметры сессии. По опыту других BMC (и по предупреждению в ipmi-starter) — JNLP содержит **очень короткоживущий пароль/токен**: файл «протухает» за минуты. Это значит: в ИнфраКонтрол JNLP/сессию надо создавать в момент подключения пользователя, а не заранее.
- Точный список аргументов S4-варианта в открытых источниках не выложен — снимите его со своей железки (см. чек-лист §13) и занесите в этот документ.

### 4.3 Java-грабли (актуально для «персонал подключается без явы»)

- Современные JRE режут старые алгоритмы: `jdk.tls.disabledAlgorithms`, `jdk.jar.disabledAlgorithms`, `jdk.certpath.disabledAlgorithms` — JViewer часто «отваливается» именно поэтому (типовое лечение сообщества: правка `java.security` или старая JRE). Готовый рецепт: проект **netinvent/ipmi-starter** (бандл OpenJDK 8 + IcedTea-Web с ослабленной секьюрити, запуск `javaws viewer.jnlp`).
- Альтернатива для запуска без Java вообще — CheerpJ (Java→WASM бридж), но это экзотика; для ИнфраКонтрол правильный путь — вообще не запускать JViewer (см. §6, §12).

### 4.4 Веб-логин iRMC S4 (для автоматизации сессий)

Проверенный сообществом трюк автологина веб-формы (Remote Desktop Manager):

```
https://<IRMC>/login?APPLY=99&P99=<USERNAME>
```

`P99` — имя поля username в форме логина iRMC S4 (пароль подставляется автозаполнением/POST-ом). Для бэкенда надёжнее: HTTP Digest на legacy-эндпоинтах (`/avr.jnlp`, `/config`, `/iRMC_Settings.pre`) и Redfish-сессии (`/redfish/v1/SessionService/Sessions`) для всего нового.

---

## 5. HTML5-консоль (AVR без Java) — главный кандидат для ИнфраКонтрол

### 5.1 Факты

- Поддерживается **iRMC S4 и S5**; в S4 появляется с прошивки **8.0x** (даташит: «From iRMC S4 firmware version 8.05F users can select HTML5 (Java-free) prior to the start of an AVR session»; Alteeve фиксирует работу с 8.01F). «Operation via a standard web browser» — официальная формулировка Fujitsu.
- Включение:
  - UI: `Console Redirection → Video Redirection → [x] HTML5 Viewer Enabled → Apply` (S4); в S5: `Settings → Services → Advanced Video Redirection (AVR) → Favor HTML5 over Java Applet`.
  - **SCCI (автоматизируемо)** — `ConfigSpace OE="1633"`, значение `0`=Java, `1`=HTML5:

```bash
$ cat irmc_avr_mode.xml
<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<CMDSEQ>
  <CMD Context="SCCI" OC="ConfigSpace" OE="1633" OI="0" Type="SET">
    <DATA Type="xsd::integer">1</DATA>
  </CMD>
</CMDSEQ>

$ curl -u admin:admin --data @irmc_avr_mode.xml https://<IRMC>/config
# ответ:
<?xml version="1.0" encoding="UTF-8" ?>
<Status>
  <Value>0</Value>
  <Severity>Information</Severity>
  <Message>No Error</Message>
</Status>
```

- Запуск: через веб-UI кнопкой «Start Video Redirection» или через `/avr.jnlp` (который теперь отдаёт HTML5-страницу — §4.1).

### 5.2 Что известно о протоколе HTML5-вьюера

Публичной документации протокола **нет** (никто не разбирал в открытых источниках — в отличие от Supermicro/iDRAC, у которых есть Redfish `GetKVMSession`). Что можно утверждать:

- Вьюер — JS-код + canvas, отдаваемый веб-сервером iRMC на том же 443; консоль при этом работает через firewall только с проброшенным 443 (Alteeve).
- Архитектурно iRMC S4 — это платформа AMI/ASPEED со stunnel4 в составе прошивки; сетевой KVM-демон (проприетарный, в GPL-дампе отсутствует) отдаёт видеопоток с драйвера `videocap` (см. §10). Для AMI-платформ HTML5-вьюеры обычно реализуют **RFB-подобный бинарный протокол поверх WebSocket** — iDRAC у соседей по цеху «tunnel the VNC connection over a websocket» (цитата разработчиков Devolutions про BMC-консоли в целом). Это гипотеза с высоким правдоподобием, но требует подтверждения перехватом.
- Аутентификация канала, скорее всего, завязана на веб-сессию (cookie/токен), а не на VNC-пароль.

### 5.3 Как вскрыть протокол за 30 минут (без Java!)

1. Открыть в Chrome: `https://<irmc>/` → логин → `Console Redirection → Start Video Redirection` (HTML5 включён).
2. **DevTools → Network → фильтр WS** → посмотреть, какой endpoint поднимается (`wss://irmc/...`), какие заголовки/cookies уходят, и **расшифровать бинарные фреймы** (DevTools показывает hex).
3. Первые байты: если видите `RFB 003.008` или подобное — это RFB поверх WebSocket → ваш модуль может просто **проксировать этот WS в noVNC** (возможно, вообще без перекодирования).
4. Сохранить JS вьюера (Sources) и поискать строки: `RFB`, `websocket`, `SecurityType`, `SetPixelFormat`, `KeyEvent`, `PointerEvent`, `cuttext` — быстро даст карту сообщений.
5. Если протокол окажется не-RFB — снифать нечего: сравнить фреймы с действиями в UI (клавиши/мышь/обновление экрана) и написать адаптер в noVNC-совместимый формат на бэкенде (вы это уже делали для S2).

---

## 6. Протокол Java-консоли (RFB поверх чего?) и план реверса JViewer_S4.jar

Если HTML5-вьюер по какой-то причине не подойдёт, второй путь — свой KVM-клиент по мотивам JViewer_S4.jar (как вы сделали для S2).

### 6.1 Где взять материал

```bash
# 1) JNLP (digest auth):
curl -s -k -u admin:admin --digest https://<irmc>/avr.jnlp -o avr.jnlp
# 2) вытащить <jar href="..."> из JNLP и скачать JAR с того же хоста:
curl -s -k -u admin:admin --digest https://<irmc>/<путь-из-jnlp>/JViewer_S4.jar -o JViewer_S4.jar
```

### 6.2 Декомпиляция и что искать

- Инструменты: **CFR** (`java -jar cfr.jar JViewer_S4.jar --outputdir src`), Procyon, Fernflower (IntelliJ), для быстрого грепа — `jadx`/`unzip + strings`.
- Ищем:
  - парсинг аргументов JNLP (класс main, ключи вида `IP=`, `PORT=`, токен/пароль);
  - создание сокета: `SSLSocket`/`SSLSocketFactory`/`TrustManager` (тут будет видно — TLS ли канал и на какой порт);
  - **RFB-хендшейк**: строки `RFB 003.008` / `RFB 003.003`, обработка `SecurityType` (стандартные: None=1, VNC Auth=2; проприетарные — важно записать их номера), `SetPixelFormat`, энкодинги (Raw/Hextile/Tight/…);
  - клавиатура/мышь: `KeyEvent`/`PointerEvent` — стандарт RFB или кастом-опкоды;
  - **виртуальные носители client-side**: классы «Remote Storage/CD/FD» — отдельный под-протокол (у S2-эпохи это был «ServerView Remote Storage»); для ИнфраКонтрол он не нужен (у нас серверный mount, §7), но для полноты протокола задокументируйте.
- Динамический трассаж:
  - `java -Djavax.net.debug=ssl,handshake -jar JViewer.jar ...` — увидите TLS-параметры и SNI/порты;
  - MITM: `mitmproxy --mode transparent` + подмена truststore (`-Djavax.net.ssl.trustStore=myca.jks`) или патч декомпилированного класса с дампом plaintext в файл;
  - Wireshark: если хендшейк RFB идёт в plaintext до TLS — увидите `RFB 003.008` сразу; иначе только через MITM/патч.

### 6.3 Ожидаемая картина (по косвенным данным)

- Канал: TLS поверх TCP, инкапсулированный веб-сервисом iRMC (перенос HTTPS-порта тянет за собой KVM — §3.1). Скорее всего соединение инициируется на тот же 443 с особым путём/апгрейдом, либо на отдельный loopback-порт за stunnel — снимать с железки.
- Аутентификация: одноразовый credential из JNLP (§4.2) — по сути session-ticket, а не классический VNC-пароль. Для ИнфраКонтрол это даже удобнее: бэкенд сам запрашивает JNLP/токен digest-запросом и подключается к RFB-каналу сразу же, прокидывая экран в браузер пользователя через websockify/noVNC (та же схема, что у вашего S2-модуля).

---

## 7. Виртуальные носители (проброс ISO) — все механизмы iRMC S4

У iRMC S4 два независимых механизма: **Remote Image Mount** (BMC сам тянет ISO с сетевой шары — нам подходит идеально) и **client-side Virtual Media** (JViewer шлёт данные с рабочего места — Java-only, для веба не подходит).

### 7.1 SCCI Remote Image Mount (NFS/CIFS) — полный разбор из кода python-scciclient

Транспорт: `POST https://<irmc>/config`, тело — XML, `Content-type: application/x-www-form-urlencoded`, auth = **Basic или Digest** (порт 443 → https, 80 → http). Ответ — `<Status><Value>0</Value>...` (0 = ок; известная ловушка: при таймауте сессии — `SCCISessionTimeout`, обрабатывайте).

**Шаг 1. Настроить источник CD (ConfigSpace), один XML:**

```xml
<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<CMDSEQ>
  <!-- Remote Media включён -->
  <CMD Context="SCCI" OC="ConfigSpace" OE="1A80" OI="0" Type="SET"><DATA Type="xsd::integer">1</DATA></CMD>
  <!-- Число эмулируемых CD/DVD -->
  <CMD Context="SCCI" OC="ConfigSpace" OE="1A68" OI="0" Type="SET"><DATA Type="xsd::integer">1</DATA></CMD>
  <!-- Сервер с шарой -->
  <CMD Context="SCCI" OC="ConfigSpace" OE="1A60" OI="0" Type="SET"><DATA Type="xsd::string">192.168.1.50</DATA></CMD>
  <!-- Домен (для CIFS) -->
  <CMD Context="SCCI" OC="ConfigSpace" OE="1A63" OI="0" Type="SET"><DATA Type="xsd::string"></DATA></CMD>
  <!-- Тип шары: 0 = NFS, 1 = CIFS/SMB -->
  <CMD Context="SCCI" OC="ConfigSpace" OE="1A64" OI="0" Type="SET"><DATA Type="xsd::integer">0</DATA></CMD>
  <!-- Имя шары (экспорт) -->
  <CMD Context="SCCI" OC="ConfigSpace" OE="1A65" OI="0" Type="SET"><DATA Type="xsd::string">/srv/iso</DATA></CMD>
  <!-- Имя образа внутри шары -->
  <CMD Context="SCCI" OC="ConfigSpace" OE="1A66" OI="0" Type="SET"><DATA Type="xsd::string">debian-12.iso</DATA></CMD>
  <!-- Пользователь и пароль шары -->
  <CMD Context="SCCI" OC="ConfigSpace" OE="1A61" OI="0" Type="SET"><DATA Type="xsd::string"></DATA></CMD>
  <CMD Context="SCCI" OC="ConfigSpace" OE="1A62" OI="0" Type="SET"><DATA Type="xsd::string" Encrypted="0"></DATA></CMD>
</CMDSEQ>
```

Карта ConfigSpace для носителей (из python-scciclient):

| OE | Назначение | OE | Назначение |
|---|---|---|---|
| 1A80 | Remote Media Enabled | 1A58 | число эмулируемых FD |
| 1A68 | число эмулируемых CD | 1A50 | FD: сервер |
| 1A60 | CD: сервер | 1A53 | FD: домен |
| 1A63 | CD: домен | 1A54 | FD: тип шары (0=NFS/1=CIFS) |
| 1A64 | CD: тип шары | 1A55 | FD: шара |
| 1A65 | CD: шара | 1A56 | FD: имя образа |
| 1A66 | CD: имя образа | 1A51 | FD: пользователь |
| 1A61 | CD: пользователь | 1A52 | FD: пароль |
| 1A62 | CD: пароль | | |

**Шаг 2. Смонтировать/размонтировать CD:**

```xml
<!-- MOUNT_CD: 1 = connect, 0 = disconnect -->
<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<CMDSEQ>
  <CMD Context="SCCI" OC="ConnectRemoteCdImage" OE="0" OI="0" Type="SET">
    <DATA Type="xsd::integer">1</DATA>
  </CMD>
</CMDSEQ>
```

Аналогично: `ConnectRemoteFdImage` (0x0251), `ConnectRemoteHdImage` (0x0253). NOTE: virtual FD deprecated с 9.62F (S4).

**Шаг 3 (полезно). Прочитать текущий конфиг:**

```
GET https://<irmc>/iRMC_Settings.pre?P45=1&SAVE_DATA=1   (digest/basic)
→ XML <CMDSEQ><CMD OE="1A60">...<DATA>...</DATA>...</CMDSEQ>
```

python-scciclient этим пользуется, чтобы проверить, заданы ли Server/Share/Image, перед eject (иначе iRMC вернёт ошибку).

**Нюанс S4:** remote image mount на S4 — **NFS или CIFS**. Тип шары **HTTPS** появляется в новых поколениях (в ansible-модулях Fsas: `share_type: NFS|SMB|HTTPS` для iRMC S6/M8). Если ваша прошивка 9.x внезапно умеет HTTPS-шару — это избавит от NFS-сервера; проверить (`GET /redfish/v1/Systems/0/Oem/ts_fujitsu/VirtualMedia/` → `ShareType` allowable). Если нет — в ИнфраКонтрол проще всего держать NFS-экспорт каталога с ISO (на бэкенде NFS-сервер — маленький контейнер).

### 7.2 Redfish OEM VirtualMedia (новее, чище; для S4 — на прошивках 9.x)

Действия из официальных ansible-модулей Fujitsu (fsas.primergy):

```
# префиксы: vendor="ts_fujitsu" (S5 и ранее) → oem_prefix="FTS"; новые — "Fsas"

GET   /redfish/v1/Systems/0/Oem/ts_fujitsu/VirtualMedia/          # состояние + конфиг
PATCH /redfish/v1/Systems/0/Oem/ts_fujitsu/VirtualMedia/          # записать конфиг
      заголовок If-Match: <@odata.etag из GET>
      body:
      {
        "CD": {
          "Server": "192.168.1.50",
          "ShareName": "/srv/iso",
          "ImageName": "debian-12.iso",
          "ShareType": "NFS" | "SMB" | "HTTPS",
          "UserDomain": "", "UserName": "", "Password": "",
          "MaximumNumberOfDevices": 1
        },
        "RemoteMountEnabled": true
      }

POST  /redfish/v1/Systems/0/Actions/Oem/FTSComputerSystem.VirtualMedia
      body: { "FTSVirtualMediaAction": "ConnectCD" }
      параметры: ConnectCD | DisconnectCD | ConnectHD | DisconnectHD
      (allowable-значения: GET /redfish/v1/Systems/0/ →
       Actions.Oem["#FTSComputerSystem.VirtualMedia"].FTSVirtualMediaAction@Redfish.AllowableValues;
       пустые allowable ⇒ нет лицензии Virtual Media)
```

Сессия: `POST /redfish/v1/SessionService/Sessions {"UserName":..,"Password":..}` → заголовок **X-Auth-Token** (201) + `Location`; дальше `X-Auth-Token` в каждом запросе; удалить сессию — DELETE по Location. Работает и basic-auth поверх, но сессии правильнее.

### 7.3 Что происходит в железе при mount (из GPL-исходников)

- BMC эмулирует **USB-устройства** хосту: драйвер `iUSB` (iusb-cdrom.c, iusb-hdisk.c, iusb-scsi.c, iusb-hid.c) + демон `usbe` (SCSI/BOT: bot.c, descriptors.c). При mount «Fujitsu Virtual CD-ROM» читает ISO из выбранной шары и скармливает блоки в эмулированный USB-CDROM.
- В boot-меню сервера (F12) появляется «Fujitsu Virtual CD-ROM» — ставим галку загрузки.
- Это значит: **проброс ISO полностью серверный** — браузер пользователя и Java вообще не участвуют. Это главный вывод для модуля ISO.

---

## 8. Redfish/REST API iRMC S4 — шпаргалка

- Корень: `GET /redfish/v1` → в теле `Vendor` (`ts_fujitsu`), в HTTP-заголовке `Server: iRMC S4 Server ...` (парсится поколение).
- Система: `GET /redfish/v1/Systems/0` → `PowerState`, `Model`, OEM-расширения.
- Питание: `POST /redfish/v1/Systems/0/Actions/ComputerSystem.Reset` (`{"ResetType": "On"|"ForceOff"|"GracefulShutdown"|"ForceRestart"|...}`).
- **Скриншот консоли** (удобно для превью в ИнфраКонтрол, из официальных сэмплов Fujitsu):

```
POST /redfish/v1/Systems/0/Actions/Oem/FTSComputerSystem.Screenshot
     {"FTSScreenshotType": "Make"}        → 204
GET  /redfish/v1/Systems/0/Oem/ts_fujitsu/FTSComputerSystemScreenshotActionInfo
     → Parameters[0].AllowableValues; когда появится "Save":
POST {"FTSScreenshotType": "Save"}  и забрать JPG
```

- Спецификация Redfish API iRMC: «iRMC Redfish API Specification» (PDF на support.ts.fujitsu.com, SoftwareGuid CED64CAE-A20C-494E-91FE-66ADAD0DBFD2) + white paper (SoftwareGuid 85DBC785-B759-4CDE-A1D3-C335B5EC7C1D). Красная документация подтверждает: порт для iRMC-операций — 443, auth — basic/digest.
- OpenStack Ironic использует iRMC-драйвер в проде: питание через IPMI/SCCI, virtual media deploy через SCCI (`IRMCVirtualMediaIscsiDriver`) — живой пример того же набора API, что нужен вам.

---

## 9. SCCI — справочник команд (из python-scciclient, авторские комментарии Fujitsu)

Эндпоинты: `POST /config` (команды), `GET /iRMC_Settings.pre?P45=1&SAVE_DATA=1` (чтение конфига), `POST /irmcupdate?flashSelect=255` (прошивка iRMC), `POST /biosupdate` (BIOS). Всё на 443, basic/digest.

| OpCode | Команда | Действие |
|---|---|---|
| 0xE002 | ConfigSpace | запись конфига (см. таблицу OE §7.1; AVR-режим OE=1633: 0=Java/1=HTML5) |
| 0x0111 | PowerOnCabinet | включение |
| 0x0112 | PowerOffCabinet | выключение |
| 0x0113 | PowerOffOnCabinet | power cycle |
| 0x0204 | ResetServer | hard reset |
| 0x0205 | RequestShutdownAndOff | graceful off (нужен агент в ОС) |
| 0x0206 | RequestShutdownAndReset | graceful reboot |
| 0x0209 | ShutdownRequestCancelled | отмена shutdown |
| 0x020C | RaiseNMI | NMI-импульс |
| 0x0203 | ResetFirmware | перезагрузка BMC |
| 0x0251 | ConnectRemoteFdImage | виртуальный FD (deprecated с 9.62F) |
| 0x0252 | ConnectRemoteCdImage | виртуальный CD (1=connect, 0=disconnect) |
| 0x0253 | ConnectRemoteHdImage | виртуальный HD |

Шаблон XML команды: `<CMD Context="SCCI" OC="%s" OE="0" OI="0" Type="SET">` + `<DATA Type="xsd::integer">%d</DATA>` для команд с параметром. Для ConfigSpace — `OE="<код>"`.

---

## 10. GPL-исходники прошивки iRMC S4 (архитектура нижнего уровня)

Репозиторий **halmartin/fujitsu_irmc_bmc** (~47k файлов) — GPL-часть прошивки iRMC S4. Полезное для понимания физики процессов:

| Компонент | Файлы | Роль |
|---|---|---|
| `videocap-2.9.200.6.0-ARM-PILOT_III-src` | capture.c, cap90xx.c, dma90xx.c, iohndlr.c | захват фреймбуфера видеодвижка ASPEED (DMA) — источник видеопотока для KVM |
| `hid-6.6.0.0.0-src` | keybd.c, mouse.c, hid_mod.c | эмуляция/инжекция PS/2 клавиатуры и мыши в хост — приёмник KVM-событий |
| `iUSB-6.2.0.0.1-src` | iusb-cdrom.c, iusb-hdisk.c, iusb-scsi.c, iusb-hid.c | драйвер эмулируемых USB-устройств (CD/HD/HID) |
| `usbe-6.4.0.1.0-src` | bot.c, descriptors.c, coreusb.c, module.c | USB-эмуляция: SCSI/BOT-обвязка — данные виртуального носителя идут сюда |
| `stunnel4-6.1.0.0.0-ARM-src` | — | TLS-обёртка сервисов |
| `irmc_common-1.0.1001.6.0-src` | ring_buffer.c, filter.c, device.c | общая plumbing-библиотека |
| `Kernel_Pristine_ex-6.0.0.0.0-src` | linux-3.14.17 | ядро BMC |

**Чего в дампе нет** (проприетарное AMI/FTS): web-сервер, KVM-демон (RFB/HTML5-протокол), Redfish-стек, логика лицензий (`libfts_license.so` упоминается в watchmysys, но тоже не в дампе). Т.е. сетевые протоколы реверсим из JViewer_S4.jar/JS-вьюера, а не из этой репы — но физику данных она подтверждает.

---

## 11. Готовые инструменты и референс-код

| Инструмент | Что даёт | Лицензия/заметки |
|---|---|---|
| **python-scciclient** (`pip install python-scciclient`) | Готовый SCCI-клиент: power, virtual media (NFS/CIFS), чтение конфига, eLCM, SNMP. Самый ценный источник — файл `scciclient/irmc/scci.py` | Apache-2.0, автор Fujitsu (для OpenStack) |
| **OpenStack Ironic** (драйвер `irmc`) | Продакшн-пример: питание (IPMI/SCCI), virtual media deploy, user management. `ironic/drivers/irmc.py` | Apache-2.0 |
| **mmurayama/fujitsu-redfish-samples** | Redfish-скрипты: сессии, питание, скриншот консоли, boot device, SEL/IEL, лицензии, прошивки | Python, Fujitsu engineer |
| **fujitsu/ansible-irmc-integration** (`fsas.primergy`) | Модули `irmc_setvm/irmc_getvm/irmc_connectvm` (VirtualMedia), `irmc_scci` (raw SCCI), `irmc_session`, `irmc_license`, `irmc_user`, `irmc_facts` | GPL-3.0, официальный Fsas Technologies |
| **netinvent/ipmi-starter** | Бандл старых JRE + IcedTea-Web с ослабленной java.security — если JViewer всё же нужно запускать | MIT |
| **noVNC + websockify** | Браузерная сторона KVM (как у вас в S2-модуле) | MPL-2.0 |
| **FreeIPMI / ipmitool** | IPMI RMCP+ 623: питание, сенсоры, SEL, SOL | GNU |
| **watchmysys.com/blog** | Разбор формата лицензий iRMC S4/S5 (+скрипты PoC) | инфо-материал |

---

## 12. План реализации модуля iRMC S4 в ИнфраКонтрол

### 12.1 KVM-экран (без Java)

- **Путь A (рекомендуемый старт): HTML5 AVR + прокси.**
  1. Бэкенд: digest-логин → включить HTML5-режим (SCCI OE=1633=1, если выключен) → открыть сессию.
  2. Вскрыть DevTools-ом реальный WS-эндпоинт HTML5-вьюера (§5.3).
  3. Если это RFB-over-WS → проксировать на noVNC почти напрямую; иначе — адаптер фреймов на бэкенде (схема как в вашем S2).
  4. В UI ИнфраКонтрол пользователь жмёт «Консоль» — бэкенд сам создаёт сессию BMC и отдаёт WS-стрим (credentials пользователя BMC наружу не светим).
- **Путь B (запасной): свой RFB-клиент из JViewer_S4.jar.** Декомпиляция (§6.2), реализация RFB-over-TLS на бэкенде, мост в noVNC. Держать как план B, если HTML5-протокол окажется сильно проприетарным.
- Оба пути требуют **Advanced Pack лицензии** на AVR (§3.2).

### 12.2 Проброс ISO (серверный, без участия клиента)

1. В ИнфраКонтрол: репозиторий ISO → экспорт по NFS (и/или SMB) с IP бэкенда.
2. Подключение: Redfish `PATCH .../Oem/ts_fujitsu/VirtualMedia/` (Server/ShareName/ImageName/ShareType) → `POST .../Actions/Oem/FTSComputerSystem.VirtualMedia {"FTSVirtualMediaAction":"ConnectCD"}`. Fallback — SCCI XML (§7.1) на старых прошивках.
3. Опционально: выставить one-time boot на виртуальный CD (`irmc_setnextboot`-эквивалент: Redfish `Boot`/`BootSourceOverrideTarget=Cd` или SCCI ConfigSpace), затем `Reset`.
4. Проверить допустимость HTTPS-шары на вашей прошивке (если да — NFS-сервер не нужен вообще, бэкенд просто отдаёт ISO по HTTPS).

### 12.3 Остальное (для целостности модуля)

- Питание/сенсоры/SEL: Redfish (`Systems/0`, `Reset`, скриншот OEM) + SCCI `/config` + IPMI 623/UDP — что вам удобнее (для S2 вы уже использовали часть этого).
- Мониторинг доступности: `GET /redfish/v1` + парс `Server:`-заголовка (там поколение `S4`).
- Обработка ошибок: SCCI `Value!=0` → ошибка протокола; `AllowableValues` пустые → нет лицензии; digest-редиректы → менять только порт/схему.

---

## 13. Чек-лист снятия данных с живой железки (заполните и приложите к документу)

1. `GET /avr.jnlp` (digest) → **сохранить полностью**: имена/значения `<argument>`, `<jar href>` → добавить сюда.
2. Скачать `JViewer_S4.jar`, прогнать `cfr`, зафиксировать: класс main, ключи аргументов, механизм TLS (порт!), security types RFB, наличие VM-подпротокола.
3. С HTML5-вьюером: DevTools → WS → задокументировать endpoint, handshake-заголовки, первые 10 фреймов (hex).
4. `GET /redfish/v1/Systems/0/Oem/ts_fujitsu/VirtualMedia/` → допустимые `ShareType` (есть ли HTTPS), статус `RemoteMountEnabled`, `MaximumNumberOfDevices`.
5. Проверить `netstat`/Wireshark во время KVM-сессии: какие TCP-порты реально открываются к BMC (подтвердить, что всё в 443).
6. Прошивка iRMC S4 (версия из `Server:` заголовка или web-UI) — фиксируем; HTML5 появится только на 8.05F+.
7. Наличие лицензии Advanced Pack (web-UI → Information/License) — иначе консоли и VM не будет.

---

## 14. Источники

**Официальные (Fujitsu/Fsas):**
- Datasheet iRMC S4: https://sp.ts.fujitsu.com/dmsp/Publications/public/ds-irmc-s4-en.pdf (AVR via HTML5 Java-free; Advanced Pack; Virtual Media; video capturing; HTML5 с 8.05F)
- iRMC Redfish API Specification + White paper: support.ts.fujitsu.com, SoftwareGuid `CED64CAE-A20C-494E-91FE-66ADAD0DBFD2` и `85DBC785-B759-4CDE-A1D3-C335B5EC7C1D`
- fujitsu/ansible-irmc-integration: https://github.com/fujitsu/ansible-irmc-integration (модули VirtualMedia, SCCI, session, license)
- mmurayama/fujitsu-redfish-samples: https://github.com/mmurayama/fujitsu-redfish-samples (incl. take_console_screenshot.py)
- Редхат-доки по iRMC (порт 443, basic/digest): https://docs.redhat.com/en/documentation/red_hat_openstack_platform/8/html/director_installation_and_usage/sect-fujitsu_integrated_remote_management_controller_irmc

**Блог инженера Fujitsu (Masa Murayama) — критичные статьи:**
- Get iRMC AVR Console via CLI (avr.jnlp через digest/токен; S2/S3/S4 vs S5; «HTML5 Viewer is used»): http://mmurayama.blogspot.com/2020/08/fujitsu-primergy-get-irmc-advanced.html
- Fujitsu iRMC HTML5 Console (включение HTML5; SCCI OE=1633): http://mmurayama.blogspot.com/2018/05/fujitsu-irmc-html5-console.html
- Enabling Redfish in iRMC S4: http://mmurayama.blogspot.com/2018/04/enabling-redfish-in-fujitsu-irmc-s4.html

**OpenStack (референс-реализации протокола):**
- python-scciclient (SCCI, VirtualMedia, ConfigSpace): https://opendev.org/x/python-scciclient (PyPI: python-scciclient; код вырезан в §7, §9)
- Ironic iRMC driver: https://docs.openstack.org/ironic/zed/admin/drivers/irmc.html

**Сообщество:**
- halmartin/fujitsu_irmc_bmc (GPL-исходники прошивки iRMC S4): https://github.com/halmartin/fujitsu_irmc_bmc
- netinvent/ipmi-starter (JNLP с короткоживущим паролем; бандл Java): https://github.com/netinvent/ipmi-starter
- Alteeve Fujitsu Notes (firewall: только 80/443 для KVM; HTML5 в S4 с 8.01F): https://www.alteeve.com/w/Fujitsu_Notes
- watchmysys (реверс лицензий iRMC S4/S5, биты фич): https://watchmysys.com/blog/2023/01/fujitsu-irmc-s4-license
- Devolutions forum «Fujitsu iRMC Quick Connect» (автологин `/login?APPLY=99&P99=...`; общая картина BMC-консолей): https://forum.devolutions.net/topics/29863/fujitsu-irmc-quick-connect
- Worldstream KB (Start Video Redirection, HTML5 Viewer Enabled; ISO mount через виртуальный CD, F12): https://www.worldstream.com/en/article/start-console-redirection-of-an-out-of-band-management
- xorl «How to use Fujitsu-Siemens ServerView Remote Storage» (S2-эпоха client-side VM, для сравнения): https://xorl.wordpress.com/2011/08/28/how-to-use-fujitsu-siemens-serverview-remote-storage/

**Локальные артефакты этого исследования** (в `/home/z/my-project/research/`): разобранный `python_scciclient-0.17.0` (`pkgs/scciclient_src`), клон `irmc_bmc_src` (GPL-дамп, sparse), клон `ansible-irmc-integration`, клон `fujitsu-redfish-samples`, кэш страниц (`.txt`), даташиты (`.pdf`).
