# Декодирование видео iRMC (фреймбуфер и кодек)

Как вьювер превращает команды `BitBlt`/`EnhanceBitBlt`/`BSEBitBlt` в картинку.
Источник: `com.serverengines.graphics.GraphicsMgr`,
`com.serverengines.mahogany.PixelBufferImage`.

## Фреймбуфер

- Внутренний буфер — `int[]` размером width×height, значение `0x00RRGGBB`.
- Эффективный bpp: `bpp<8 → 8`, `bpp==15 → 16`, иначе как есть (16/24/32).
- Для 8bpp — индексный буфер (`m_paletteScreen`) + палитра; для text/4bpp —
  буфер нибблов (`m_attributeScreen`) + атрибуты.

## Режимы и палитра

- `InformVesaMode (225)` задаёт mode/width/height/bpp.
- `SetPalette (230)`: каждый элемент палитры = 4 байта `offset,hi,mid,lo`
  (offset = индекс; hi/mid/lo = RGB). Собрать: `palette[offset] = (hi<<16)|(mid<<8)|lo`.

## BitBlt (226)

- `bltType` выбирает ветку: `256` copy, `257..264` text-режимы (font),
  `499` special 4bpp.
- Для `bpp>8`: данные = сырые пиксели, порядок BGR: `data[o+2]<<16 | data[o+1]<<8 | data[o]`,
  шаг `bpp>>3`.
- Для `bpp==8` (не text): индексы палитры по 1 байту.
- Позиция — `destinationRectangle` (x,y,w,h), размер ячейки text — fontW/fontH.

## EnhanceBitBlt (227) — блочно-таильный кодек

- Таилы (tiles) выбранного размера (обычно 32×32); включённые таилы помечены в
  snoop-map (2×64×u32: low/high). `bits = (j<32) ? low[i] : high[i]`, проверка `(bits>>j)&1`.
- Смещения таила: `tileY = i<<shiftH`, `tileX = j<<shiftW` (`shift = log2(tileSize)`).
- `bltType` (маскируется `& 0x7FFF`, т.к. new-frame = `0x8000|type`):
  - `496` — сырые пиксели (как BitBlt), курсор `o` движется на `bpp>>3` на пиксель.
  - `498` — **HLC**: отдельные triplet/repeat-потоки на канал. Заголовок:
    размеры каналов u32 (R, затем G, затем B при bpp>16); каждый канал —
    независимый RLE-поток.
  - `499` — 4bpp: нибблы в `attr`, затем конвертация в палитру.
  - `501` — Force8bpp HLC: 8bpp (2-2-4) раскладывается в 16/24bpp с учётом
    интенсивности (полный канал при значении-максимуме).
- `raw/scrunch`: `scrunch` = длина данных, `raw` = несжатый размер (для счётчиков).

## RLE (triplet/repeat) — единый кодек

Числа в потоке: `0x55` = triplet, `0xAA` = repeat.
- `0x55 → repeat=3, значение = следующий байт`.
- `0xAA, count`:
  - `count==1` → нарисовать 1 пиксель значения `0x55`;
  - `count==0` → нарисовать 1 пиксель значения `0xAA`;
  - `count>=2` → `count+1` пикселей следующего байта.
- Счётчик и значение **сохраняются между пикселями** (повторы), поэтому
  декодер обязан быть stateful (`Rle` в `server/irmc-decode.js`).
- В BSE счётчик уменьшается на **группу из 8 пикселей**; в HLC — на пиксель.

## BSE (231)

- `bltType`: `3` = 3bpp (3 канала), `8` = 8bpp (8 каналов), `16/18` — 16bpp /
  true-8bpp (не реализованы).
- Координаты top/left/bottom/right — индексы таилов 32: `y = top<<5` и т.д.
- Каждый канал — свой RLE-поток; биты 8 пикселей пишутся по каналу в
  `0x00RRGGBB` со сдвигами каналов (для 16/24bpp из SHIFT_3BPP_* / SHIFT_8BPP_*).
- Логика интенсивности: если маска канала равна маске-максимуму → канал в полный
  (см. `BSE_COLOR_*_MASK_*` и `INTENSE_*` в PixelBufferImage).

## SSP (237) / LowBandwidthSSP (224)

- Формат как BSE (compLen, uncompLen, top/left/bottom/right, seq, data), но без
  `bltType`. Это отдельный (LZ-подобный) кодек — в текущем декодере **не
  реализован**, кадр потребляется для снятия (для сохранения синхронизации).

## Производительность / кадры

- `m_SSPTicks`, `m_armTicks`, `m_networkTicks`, `m_cycleTicks` — из
  `InformCPUUtilization (229)` для метрик.
- `SequenceNumber (239)` — подтверждение кадров; клиент отвечает
  `SequenceNumber` (см. `MessageSender.sequenceNumber`).

## Классы-источники

- Декодер фреймбуфера: `PixelBufferImage`, `GraphicsMgr`.
- Битовые маски/сдвиги: `BSE_COLOR_*`, `SHIFT_AMT_*`, `INTENSE_*`,
  `BiltType` (константы типов), `Palette`, `Attribute`.
