# iRMC Viewer / InfraControl

Веб-консоль и управление инфраструктурой для серверов **Fujitsu iRMC** —
**без Java**. KVM-консоль отдаётся в браузер через VNC/RFB (noVNC), плюс
инвентарь, мониторинг и виртуальные носители.

Проект **модульный**: поддержка каждой серверной платформы — отдельный
плагин-модуль. Новая платформа добавляется папкой, без правок ядра.

## Возможности

- **KVM-консоль в браузере** (noVNC/RFB): видео, клавиатура, мышь.
- **Виртуальные носители**: монтирование ISO/CD как USB-CDROM серверу.
- **IPMI-инвентарь и мониторинг**: сенсоры, SEL, FRU, LAN.
- **Группы серверов, пользователи, права, аудит, снапшоты.**
- **Плагинные платформы**: ядро не знает конкретных моделей — только контракты.

## Поддерживаемые платформы

| Модуль | Платформа | KVM | VirtualMedia | Статус |
|--------|-----------|-----|--------------|--------|
| `mahogany-avr` | Fujitsu iRMC S2/S3 (Avocent/Mahogany AVR) | ✔ | ✔ (M2/URS) | verified (S2) |
| `ami-soc` | Fujitsu iRMC S4 (AMI/SOC, IVTP) | ✔ | ✔ (CDMEDIA/IUSB) | verified (S4) |

Модули живут в `server/platforms/<id>/`. Список и детали — `server/platforms/README.md`.

## Архитектура (кратко)

```
┌──────────────────────────── ЯДРО ────────────────────────────┐
│  web/ (UI)   server/index.js (HTTP/WS, сессии)               │
│  vnc.js (RFB-мост, канон 0x00RRGGBB)   png.js   store/iso/ipmi│
│  sdk/contracts.js (интерфейсы)   sdk/registry.js (скан папок) │
└───────────────▲───────────────────────────▲──────────────────┘
                │ контракты                 │
     ┌──────────┴─────────┐      ┌──────────┴─────────┐
     │ platforms/mahogany-avr │  │ platforms/ami-soc  │
     │  (S2/S3: irmc, m2)     │  │  (S4: ivtp, cdmedia)│
     └───────────────────────┘  └────────────────────┘
```

- Ядро **объявляет контракты** (`probe / login / createConsole / createMedia`)
  и **сканирует папки** модулей (`server/sdk/registry.js`).
- **Всё платформенное — в папке модуля**: пробы, порты/доступ, схема входа,
  консоль, виртуальные носители, декодеры, quirks.
- **Канон пикселей `fb.pix = 0x00RRGGBB`** (R — старший байт). Приведение
  каналов — обязанность модуля; общий RFB/PNG-мост работает только с каноном.
- **Ошибка модуля не роняет ядро**: реестр изолирует и логирует.

Подробно: `wiki/knowledge/platform-module-manifesto.md`.

## Быстрый старт

```bash
./start.sh            # порт 1845, ставит node_modules при первом запуске
./start.sh -d         # debug-режим (диагностика протоколов)
```

Открыть `http://localhost:1845`, войти, добавить сервер iRMC (адрес + креды),
запустить консоль. Сервер слушает только `./start.sh` (сам грузит `.env`,
освобождает порт, пишет лог в `logs/`).

Требования: Node.js ≥ 18.

## Как добавить платформу

1. `cp -r server/platforms/_template server/platforms/<id>`
2. Заполнить `manifest.js`: **список поддержки** (`supported`: модель +
   прошивка + статус), `access` (порты/способы), `capabilities`, `probes`.
3. Реализовать нужные контракты в `index.js` (`probe`/`login`/`createConsole`/
   `createMedia`) — только то, что объявили; остальное ядро отключит.
4. Описать проверку железа в `README.md` модуля; при желании — `test.js`.
5. Ядро не трогать: `node server/sdk/registry.js` покажет найденный модуль.

Полная инструкция: `server/platforms/README.md`.

## Структура репозитория

```
server/
  index.js            # ядро: HTTP/WS, сессии, API
  vnc.js png.js       # RFB-мост и PNG (канон пикселей)
  store.js iso.js ipmi.js discover.js ...  # ядро
  sdk/                # контракты + реестр модулей
  platforms/          # ПЛАГИНЫ ПЛАТФОРМ (весь платформенный код)
    _template/        # скелетон нового модуля
    mahogany-avr/     # S2/S3
    ami-soc/          # S4
web/                  # фронтенд (UI + noVNC)
wiki/                 # знания проекта (LLM Wiki)
raw/                  # исходники (бэкапы jar, не редактируется)
start.sh              # единственная точка запуска сервера
```

## Разработка

```bash
npm test              # unit-тесты (node:test)
npm run test:e2e      # e2e-смок (puppeteer)
```

Знания и грабли проекта ведутся в `wiki/` (см. `wiki/index.md`,
`wiki/log.md`); схема ведения — `AGENTS.md`.

## Лицензия

**GNU General Public License v3.0 or later** (GPL-3.0-or-later), см. `LICENSE`.

Проект создан в том числе путём анализа GPL-исходников Fujitsu iRMC viewer
(Avocent/Mahogany, AMI), поэтому распространяется под GNU GPL.
