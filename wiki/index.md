# Каталог wiki

LLM Wiki проекта iRMC Viewer (этап 1). Страницы в `wiki/`, исходники в `raw/`,
схема — `AGENTS.md`.

## Знания (knowledge)

- [knowledge/irmc-protocol.md](knowledge/irmc-protocol.md) — протокол iRMC AVR
  (Avocent/Mahogany): транспорт, рукопожатие, таблицы команд, авторизация.
- [knowledge/irmc-video-decoding.md](knowledge/irmc-video-decoding.md) —
  декодирование видео: фреймбуфер, bpp, палитра, таильный кодек, RLE, BSE/SSP.
- [knowledge/project-status.md](knowledge/project-status.md) — проект: решения,
  модули, этап 1, проверено/открыто, следующие шаги.
- [knowledge/console-performance.md](knowledge/console-performance.md) —
  производительность bridge→noVNC: backpressure, incremental, коалесцинг,
  избежание лага ввода (диагноз + фикс 2026-09-04).
- [knowledge/irmc-mouse.md](knowledge/irmc-mouse.md) — мышь: легаси
  (MouseMgr, режимы 0/1/2, 177/178/179/180/181, trackwheel, курсор 236)
  и дефекты моста (не шлётся ClientAbsoluteMode — курсор скачет).
- [knowledge/test-accounts.md](knowledge/test-accounts.md) — тестовые
  учётки (логины/пароли для headless-проверок и curl).
- [knowledge/irmc-storage.md](knowledge/irmc-storage.md) — проброс ISO:
  нативный движок M2 (локальный протокол Java↔M2, последовательность
  M2↔iRMC, формат URSStorage), почему 153 без M2 не доставляет данные.
- [knowledge/irmc-research-conclusion.md](knowledge/irmc-research-conclusion.md) —
  заключение по исследованию монтирования ISO: архитектура (M2-движок),
  локальный и проводной протоколы, эмуляция на сервере, контроль целостности.
- [knowledge/irmc-ipmi.md](knowledge/irmc-ipmi.md) — метрики по IPMI-over-LAN
  (RMCP+/UDP 623/664): чтение темп./кулеров, интервальный опрос, не трогает KVM.
- [knowledge/db-schema.md](knowledge/db-schema.md) — схема SQLite-базы сбора
  (data/db/): таблицы, транзакция на опрос, дедуп SEL в БД, история только
  изменений, инвариант rm -rf data/db/, миграция со старой схемы.
- [knowledge/testing.md](knowledge/testing.md) — стек и best practices
  тестирования фронтенда (node:test + puppeteer e2e-смок), правила ведения.
- [knowledge/tree-groups.md](knowledge/tree-groups.md) — редактор дерева
  серверов (п.8): group/root у серверов, ui.json (roots/groups/паспорт),
  контекстное меню, drag&drop, вкладка «Группы».
- [knowledge/bmc-modules.md](knowledge/bmc-modules.md) — модульный стек BMC:
  реестр-плагины (S2/S4/S3/generic), сигнатуры, инструкция добавления
  модулей, быстрая проверка /api/check, учёт проверенного.
- [knowledge/bmc-jar-download.md](knowledge/bmc-jar-download.md) — как
  скачать JAR-вьювер с BMC (S2/S4 примеры), декомпиляция, что искать.
- [knowledge/irmc-s4-ivtp.md](knowledge/irmc-s4-ivtp.md) — iRMC S4:
  веб-вход (Digest за формой, sid), KVM-консоль IVTP/AMI (CONNECT-
  туннель 443, kvmtoken, кадры RLE, HID-ввод), интеграция, грабли.
- [knowledge/platform-module-manifesto.md](knowledge/platform-module-manifesto.md) —
  манифест модульной архитектуры: как добавить платформу одной папкой
  (`server/platforms/<id>/`), контракты ядра, канон пикселей, границы
  «ядро ↔ модуль», чеклист. Каркас: `server/platforms/README.md`,
  `server/sdk/` (contracts + registry).
- [knowledge/hp-lo100-kvm.md](knowledge/hp-lo100-kvm.md) — HP Lights-Out 100/
  LO100i (ProLiant G5/G6): KVM по протоколу Mahogany (тот же AVR, что iRMC S2),
  httpdata-токен из kvms.html, паддинги 16/20/128, view-only quirk; модуль
  `platforms/hp-lo100/`.
- [knowledge/hp-lo100i-m2.md](knowledge/hp-lo100i-m2.md) — разбор raw/M2.JAR
  (HP LO100i, DL180 G6): MahoganyViewer, рукопожатие, паддинги, нативный
  движок LIBM2 (проброс ISO).
- [knowledge/hp-ilo-redfish.md](knowledge/hp-ilo-redfish.md) — HPE iLO 4/5:
  опрос по Redfish (`server/redfish.js`), когда RMCP+ выключен (живой baspx03);
  capability-driven фолбэк в `pollSensors`, квёрки iLO 4 fw 2.80.
- [knowledge/ibm-imm.md](knowledge/ibm-imm.md) — IBM System x IMM/IMM2
  (10.67.17.17): веб HTTPS/Dojo-IMM, IPMI 2.0/fw 8.41, консоль — IBM Custom
  Avocent KVM (JNLP `viewer(…).jnlp`, порт 3900, JAR avctIBMViewer), план
  KVM-моста; модуль `platforms/ibm-imm/` (probe-only).
- [knowledge/backlog.md](knowledge/backlog.md) — отложенные задачи
  (ретенция данных к «Параметрам сервера», растворение bmc-registry и пр.).
- [knowledge/server-deploy.md](knowledge/server-deploy.md) — ⚙ служебная
  (вне git): спецификация сервера деплоя (OS, сеть, репозитории, установленный
  софт, что ставит deploy.sh).

## Баги

- [bugs.md](bugs.md) — известные дефекты/неверное поведение (не фичи): F5
  сбрасывает вкладку на «Серверы», курсор консоли, диагнозы.

## Хронология

- [log.md](log.md) — записи операций (ingest/query/lint).

## Сырьё (не редактировать)

- `../raw/avr_irmc_s2.jar` — GPL-вьювер Fujitsu iRMC (бейн-код, источник
  протокола). Декомпилировано CFR-ом в `/tmp/kilo/all/` (специально, вне репо).
