# Проект iRMC Viewer — статус и архитектура

Веб-вьювер консоли Fujitsu iRMC (KVM) на Node.js + браузер. Цель этапа 1 —
простая форма (адрес/логин/пароль) и **проверка подключения / рукопожатия**,
прежде чем строить видео.

## Решения

- Стек: **Node.js** бэкенд + статический фронт. Пока без Vue/noVNC (отложено).
- Порт: **1845** (нетривиальный), настраивается `PORT`.
- Подход: мост iRMC ↔ VNC (RFB по WebSocket) для noVNC — но видео откладывается
  до успешного медленного step-теста соединения.
- Зависимости: минимально, только `ws` (для будущего шага к VNC).

## Модули

| Файл | Роль | Java-аналог |
|------|------|-------------|
| `server/irmc-decode.js` | фреймбуфер + декодер видео | `PixelBufferImage`, `GraphicsMgr` |
| `server/irmc.js` | клиент протокола (сокет, рукопожатие, парсер, ввод) | `CConn`, `MessageReceiverThread`, `MessageSender`, `ServerHandshake` |
| `server/store.js` | хранилище серверов, creds шифр. AES-256-GCM | `SettingsResMgr`/`ServerDialog` |
| `server/db.js` | SQLite-база сбора IPMI (data/db/): транзакция на опрос, дедуп SEL, история изменений | — |
| `server/index.js` | HTTP-сервер + `/api/test`, `/api/servers` + статика | `MahoganyViewer` (запуск) |
| `web/index.html` | каркас: разметка всех страниц/модалок + подключение модулей | `ServerDialog` |
| `web/css/*` | 7 CSS-модулей (base, components, dashboard, servers, console, events, ui) | — |
| `web/js/*` | 15 JS-модулей (core, events, tree, detail, ipmi, inventory, tabs, iso, users, tree-controls, console, layout, overview, auth, init) | — |

## Хранилище и шифрование

- `data/servers.json` с `enc`-блобом (AES-256-GCM, ключ `data/key.bin`, режим 600).
- Мета (id/name/host/port/secure) — в открытом виде для списка; пароль/httpdata —
  зашифрованы.
- API: `GET/POST /api/servers`, `DELETE /api/servers/:id`, `POST /api/test`
  принимает `{serverId}` (расшифровка с диска) или инлайн-конфиг.
- Примечание: ключ лежит рядом с данными — защита «от постороннего глаза» на диске,
  не от администратора машины.
- Весь собранный IPMI-материал — в SQLite `data/db/` (см.
  `knowledge/db-schema.md`): инвариант `rm -rf data/db/` очищает сбор, но не
  настройки; конфиги серверов/пользователи/ISO/monuts — в JSON вне БД.

## TLS для старых прошивок

- По умолчанию Node предлагает TLSv1.2 + security level 2 → старый iRMC даёт
  `ssl_choose_client_version: unsupported protocol`.
- `permissiveTls()`: `minVersion:'TLSv1'`, `maxVersion:'TLSv1.2'`,
  `ciphers:'ALL:...:@SECLEVEL=0'`, широкий `sigalgs` (вкл. SHA1),
  `rejectUnauthorized:false`.
- Фоллбэк в `start()`: стадия 1 → стадия 2 (ещё более мягко) → plaintext
  (если сервер не шифрованный на том же порту).

## Тема

- Веб-страница адаптивна: по умолчанию светлая, тёмная только когда
  `prefers-color-scheme: dark` (не навязываем тёмную при светлой системе).

## Этап 1 — проверка подключения

- `POST /api/test {host, username, password, port=80, secure, httpdata}` →
  `testIrmc()` в `server/irmc.js`.
- `testIrmc` подключается (TCP/TLS), шлёт `ClientNOP(210)`, ждёт
  `ServerHandshake(200)`, шлёт `ClientHandshake(221)`, пытается довести до
  `InformVesaMode(225)`/`MultiUserState(197)`/видеокадра.
- Возвращает: прошивку, привилегии, режим экрана, список событий.
- Сигнатура рукопожатия по умолчанию — standalone `0x12121212`; при наличии
  `httpdata` — embedded `0x5A5A5A5A`.

## Проверено / открыто

- ✅ Декомпиляция всех 216 классов (`cfr`), формат протокола и кодека описан в
  `irmc-protocol.md` и `irmc-video-decoding.md`.
- ✅ Декодер: `bitBlt`, `enhanceBitBlt` (496/498/499/501), `BSEBitBlt` 3/8bpp,
  `setPalette`, `setVesaMode`, текст-режим — частично.
- ⏳ SSP-кодек (237/224) — не реализован (кадр снимается для синхронии).
- ⏳ VNC-мост (RFB 3.8 + noVNC) — следующий этап после успешного теста
  соединения.
- ⚠ Требует проверки на реальном железе: декод 16bpp-путей, standalone-аутентификация,
  порядок байт `0x00RRGGBB` для 16bpp.

## Этап 1b — данные сервера (без экрана)

Подключено к реальному серверу с ServerView iRMC S2 (Web Server).
Модель/серийный/realm — фактические значения храним локально, в git
не публикуем.

- Веб-интерфейс — **только по HTTP (порт 80)**; HTTPS (443) вешает iRMC
  (legacy-renegotiation → зависание). Работаем исключительно по HTTP.
- Аутентификация веб — **HTTP Digest**, `realm="iRMC S2@...", qop="auth"`.
- Упрощение сценария: основной вызов — `/api/info` (один GET, быстрый), он
  возвращает title/realm/model и доступность. `discover` (полный digest-логин)
  и `test` (рукопожатие KVM) — отложены.
- ⚠ Проблема: **Digest-логин извне (не браузер) виснет** — и мой код, и
  `curl --digest` получают timeout (0 байт). Браузер логинится ОК. Похоже,
  iRMC использует не классический Digest-on-GET, а сессию/одноразовый nonce
  или form-login куки-вариант. Требует отдельного разбора.
- ⚠ Пароль содержит не-ASCII (кириллица/символы) — при реализации логина
  учёт UTF-8 для HA1 в digest.

## Экран / VNC (этап 2, в работе)

- ✅ Сессия + рукопожатие работают: `/api/test` по serverId → digest-логин →
  свежий `httpdata` → `:80` → `ClientNOP(8 байт)` → `ServerHandshake` →
  `ClientHandshake` → видео. Получено `InformVesaMode 1024x768@32`.
- Декодер (`irmc-decode.js`) реализован (BitBlt/Enhance 496/498/BSE 3,8bpp,
  палитра, RLE); текст-режим и SSP/499/501 — частично.
- ✅ Консоль в браузере (noVNC в iframe, `resize=remote`, `autoconnect`):
  RFB-мост `server/vnc.js`, ввод (клавиатура/мышь) через RFB. Клавиатура:
  keysym→HID-карта; мышь — RFB PointerEvent.
- ⚠ **Односессионная консоль iRMC S2** — критично: без чистого
  `ClientDisconnect (0xd8)` предыдущая сессия держит primary control, и новое
  подключение виснет `starting` без `InformVesaMode` → чёрный экран. Фикс:
  `close()` шлёт `0xd8`+u32; `/api/connect` форсит свежую консоль при
  залипшей `starting`-сессии. Видео отдаётся с задержкой (~20-30с).

## Следующие шаги

1. Реализовать RFB-сервер по ws + noVNC (или canvas) поверх `emitFrame`.
2. Передача ввода: клавиатура (`0xd1`), мышь абсолют (`0xb1`/`0xb3`/`0xb5`).
3. Список серверов и их данные (инвентарь) на главной.
4. Учесть «одна активная консоль» и истечение сессии/httpdata.

## Интерфейс (этап 3, в работе)

Макет — `reference_design/` (InfraControl), фронт — `web/index.html`
(единая страница, без сборки). Состояние UI в localStorage: сворачивание
сайдбара, раскрытые узлы дерева, действующий пользователь.

- Дерево: корень организации (имя — локальная настройка) → филиалы по
  первым двум октетам IPv4 (обезличенные
  имена, реальные данные), не-IP хосты — «Филиал прочие».
- Пользователи: `server/users-store.js`, `data/users.json` (scrypt, сид
  admin). Роли: `admin` / `user` (общие права: админ управляет всем,
  пользователь — только просмотр). Мутации серверов и пользователей — только
  с `X-Acting-User` роли admin (403 иначе). Аутентификации нет — личность
  выбирается в шапке; см. log 2026-09-07.
- KVM-ввод кнопками тулбара — `POST /api/keys`; освобождение консоли —
  `POST /api/disconnect`.
