# Мышь: легаси-реализация и мост

Как реализован ввод мыши в легаси-вьювере (`com.serverengines.mouse.*`,
`mahoganyprotocol`), чем это отличается от нашего моста noVNC→iRMC и почему
курсор «скачет». Источник: декомпиляция `raw/avr_irmc_s2.jar` (CFR, `/tmp/kilo/all/`).

## Легаси: архитектура (com.serverengines.mouse)

- `MouseMgr` — синглтон, три режима (настройка `mouse.mode`):
  0 = HIDE (относительный + локальный курсор спрятан/центрируется),
  1 = ABSOLUTE, 2 = RELATIVE.
- Делегаты: `MouseAbsoluteDelegate`, `MouseRelativeDelegate`,
  `MouseHideDelegate` (оборачивает relative + trap). Общий базовый
  `MouseDelegate` хранит предыдущую позицию `m_point` (после каждого события).
- `MouseMgr.sendMouseState()` — синхронизация режима с сервером:
  - `ClientAbsoluteMode (177, bool absolute=true)` — только при режиме 1;
  - `ClientRelativeMode (178, bool relative, bool hide)` — для режимов 2/0.
- **Когда шлётся**: при получении полного контроля (`CConn` ~строка 2231:
  `desktop.sendMouseState()` + `requestKeyIndicators()` + `onMouseSync()`)
  и при переключении режима (`toggleMouseEscape`).

## Легаси: абсолютный режим (наш эквивалент)

- `mouseMoved/mouseDragged` → `MouseMove (181)`: x,y — **абсолютные** координаты
  события относительно canvas (`MouseEvent.getX()/getY()`); у апплета видео
  1:1, т.е. координаты фреймбуфера.
- `mousePressed/Released/mouseWheelMoved` → `ButtonStateAtAbsolute (179)`:
  те же координаты + массив из 3 `ButtonState`.
- Т.е. на простое движение шлётся **только 181**, а 179 — лишь на
  нажатие/отпускание/колесо.

### Формат ButtonState (1 байт на кнопку)

- bit0 = pressed; bits1–7 = trackwheelPosition << 1.
- `0x80` = TRACKWHEEL_CENTERED (позиция 64 << 1).
- Колесо: `getButtonsForTrackWheel(button, (byte)wheelRotation)` ставит
  `buttonStateArray[2].setTrackWheelPosition((byte)(64 + rotation))` →
  байт = `(64 + rotation) << 1 | pressedBit`: вниз (rotation=+1) → `0x82`,
  вверх (rotation=-1) → `0x7E`.
- Маппинг кнопок Java: button1→индекс 0 (левая), button3→индекс 1 (правая),
  button2→индекс 2 (средняя). Итоговый маска-порядок как в нашем мосте:
  bit0 левая, bit1 правая, bit2 средняя.

## Легаси: относительный/hide режим

- `MouseRelativeDelegate`: посылает **дельту** = `event.pos − m_point.prev`
  (`MouseMove (181, dx, dy)` — та же команда!), кнопки — `ButtonStateAtRelative (180)`.
- Первый event после ресинка подавляется: `m_canSendMouseMessages=false` →
  одно событие пропускается, затем флаг сбрасывается (`cleanupMouseMessage`).
  Это защита от гигантского скачка при ресете позиции.
- `MouseHideDelegate`: после каждого move/drag → `trapMouse()` → `centerMouse()`:
  `CConn.centerMouse()` варпает **локальный** курсор `java.awt.Robot` в центр
  вьюпорта (с поправкой на границы экранов). Локальный указатель всегда в
  центре — рассинхронизации «аппаратная vs программная» нет по построению.
- Отсюда важный вывод: в относительном режиме легаси-клиент никогда не
  позволяет аппаратному курсору «гулять» по экрану — он спрятан/заякорен.

## Легаси: форма курсора с сервера

- `MatroxGraphicsCursor (236)`: payload 256 байт control + 64×48 байт data;
  режим курсора = `control[6]`. Режимы 1..4 декодируются
  (`DecodedMouseCursor`) в кастомный курсор 64×64, палитра 17 цветов
  (индекс 16 = прозрачный), hotspot жёстко (10,10), имя "custom0".
- Режим 0 → `toggleMouse()` (hide-режим). `SetTextCursor (234)` — 4 байта,
  текстовый курсор (GraphicsMgr).
- Сервер сам управляет отрисовкой: клиент лишь подменяет **локальную** иконку
  курсора; позиция всегда следует за реальными событиями.

## Наш мост (server/irmc.js, server/vnc.js) — найденные дефекты

1. **КРИТИЧНО**: `ClientAbsoluteMode (177, true)` нигде не отправляется
   (ID объявлен в `irmc.js:28`, использования нет). Комментарий в
   `irmc.js:388` («absolute mode enabled lazily») — кода за ним нет.
   Сервер остаётся в дефолтном **относительном** режиме → абсолютные
   координаты noVNC трактуются как дельты → курсор «скачет как сумасшедшая»,
   а `ButtonStateAtAbsolute (179)` при клике телепортирует его в точку клика
   → «аппаратная не совпадает с программной».
2. `vnc.js onPointerEvent` шлёт и 181, и 179 на **каждое** движение
   (легаси: 179 только на press/release/wheel).
3. Биты колеса VNC (8/16) отбрасываются в маппинге маски → скролл не работает.
   Легаси кодирует колесо через trackwheel-байт (см. выше).
4. `MatroxGraphicsCursor (236)` прочитывается и выбрасывается
   (`irmc.js:365`) — форма курсора не передаётся в noVNC (косметический
   вариант расхождения курсоров).

## Рекомендованный фикс (минимальный, по образцу легаси)

- После `MultiUserState` (получение контроля) послать `177 (true)` +
  `178 (false, false)` — аналог `MouseMgr.sendMouseState()`.
- В `onPointerEvent`: слать 181 на каждое движение; 179 — только при смене
  маски кнопок; биты 8/16 колеса → trackwheel-байт кнопки[2] = `(64±1)<<1`.
- Опционально: декодировать 236 и отдавать в noVNC через pseudo-encoding
  CursorShape (-239) — hotspot (10,10), 64×64, палитра 17 цветов.

> Применено 2026-09-06: пункты 1–2 реализованы в `server/irmc.js`
> (`afterHandshake` шлёт 177/178 при `privileges.mouse`; `buttonState`
> принял параметр `wheel`) и `server/vnc.js` (`onPointerEvent` шлёт 179
> только по смене состояния кнопок/колеса). Пункт 3 (форма курсора) —
> не сделан. Smoke-тест байтов: `b1 01`, `b2 00`, `b5 x_i32le y_i32le`,
> `b3 x y 03 81 80 82` (колесо вниз = (65)<<1=0x82, вверх = (63)<<1=0x7E).
> Требует живой проверки на iRMC.

## Ссылки

- Протокол/команды: `knowledge/irmc-protocol.md`
- Классы: `com/serverengines/mouse/*`, `mahoganyprotocol/{MouseMove,ButtonState,
  ButtonStateAtAbsolute,ClientAbsoluteMode,ClientRelativeMode,MatroxGraphicsCursor}`,
  `mahogany/{MessageSender,CConn,DesktopWindow,MessageReceiverThread}`,
  `graphics/DecodedMouseCursor`
