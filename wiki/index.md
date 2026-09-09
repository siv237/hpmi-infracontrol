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
