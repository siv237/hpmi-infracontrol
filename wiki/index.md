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

## Хронология

- [log.md](log.md) — записи операций (ingest/query/lint).

## Сырьё (не редактировать)

- `../raw/avr_irmc_s2.jar` — GPL-вьювер Fujitsu iRMC (бейн-код, источник
  протокола). Декомпилировано CFR-ом в `/tmp/kilo/all/` (специально, вне репо).
