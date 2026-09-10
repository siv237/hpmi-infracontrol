# Рабочее окружение разработчика (форк yuristwood)

Как поднято окружение для разработки форка `yuristwood/hpmi-infracontrol` на
машине `uuser-Standard-PC-Q35-ICH9-2009` (Ubuntu, пользователь `uuser`), и какой
обход потребовался из-за нестабильного доступа к registry.npmjs.org.

## Состав окружения

- git 2.53.0, gh CLI 2.46.0 (оба через apt), авторизация gh — аккаунт
  `yuristwood`, протокол https.
- Node.js 22.22.1, npm — из apt (в системе изначально НЕ было ни git, ни node).
- ipmitool, chromium — через apt (chromium нужен e2e-смоку как executable).
- Форк: `origin` = `yuristwood/hpmi-infracontrol`, `upstream` =
  `siv237/hpmi-infracontrol`. Синхронизация с Серёгой: `git fetch upstream &&
  git merge upstream/main`.
- git-идентичность: `yuristwood <18317601+yuristwood@users.noreply.github.com>`.

## Проблема: registry.npmjs.org из этой сети недоступен стабильно

Симптомы: npm виснет минутами на мёртвом half-open TCP-сокете (ESTAB без
передачи данных, кэш `_cacache` не растёт), затем `ERR_SOCKET_TIMEOUT`;
`fetch` до registry то отвечает за ~1 c, то не отвечает совсем. npm свои
зависшие сокеты не обрывает и не ретраит.

> ⚠ важно: `AbortSignal.timeout()` в node-fetch обрывает не только коннект,
> но и чтение тела ответа — `res.json()` больших packument-ов (puppeteer-core,
> better-sqlite3 — мегабайты) падает по таймауту даже при быстром коннекте.
> Чтение тела обязано быть внутри retry-обёртки.

## Обход: зеркало registry.npmmirror.com

- Установка зависимостей напрямую через зеркало (быстро, ~0.5 c/тарбол):
  `npm install --registry=https://registry.npmmirror.com --no-audit --no-fund`
  → 114 пакетов за 22 c, `better-sqlite3` взял пребилд, нативный модуль
  проверен (CREATE/INSERT/SELECT в :memory:).
- Резервный путь (если зеркало недоступно): посев кэша npm своим скриптом —
  рекурсивный обход deps из `package.json`, скачивание тарболов node-fetch
  с retry (npmmirror → npmjs фоллбэк), `npm cache add <tgz>`. Скрипт лежал в
  `/tmp/npm_seed2.mjs` (tmp не персистентен — при необходимости восстановить
  по этому описанию).

## Фиксы переносимости из апстрима (рабочая копия, НЕ закоммичены)

1. `test/web-split.test.js` — был захардкожен абсолютный путь автора
   (`/home/siv/proj/IPMI-Viewer/...`); заменён на вычисление корня от
   `import.meta.url`. Тест на чужой машине падал всегда.
2. `package.json` — `npm test` = `node --test test/` не работает на Node 22
   (каталожный аргумент не глоббится, child падает MODULE_NOT_FOUND); заменено
   на `node --test test/*.test.js`.

Итог: `npm test` — 23 теста: 22 pass, 1 skip (e2e ждёт запущенный `./start.sh`,
см. knowledge/testing.md), 0 fail.

## Связанные страницы

- knowledge/testing.md — стек тестирования.
- knowledge/project-status.md — статус проекта.
