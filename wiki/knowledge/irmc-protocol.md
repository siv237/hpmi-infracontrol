# Протокол iRMC AVR (Avocent / Mahogany)

Транспорт и формат сообщений вьювера Fujitsu iRMC Advanced Video Redirection.
Источник: `raw/avr_irmc_s2.jar` (дек­омпиляция `com.serverengines.*`).

## Транспорт

- TCP-сокет (или TLS, `SSLContext "SSL"`, trust-all) на порт веб-интерфейса
  (обычно 80/443), либо отдельные порты из applet-параметров
  (`NonSecure_KVMPort`, `SSL_VMPort`, ...).
- Пакеты без общего префикса длины: **1 байт = ID команды**, далее поля
  читаются последовательно. **Little-endian** (см. `LittleEndianBufferMgr`).
- Каждая команда самообрамлена: переменная часть (длина payload) лежит внутри
  фиксированного заголовка команды.

## Поток соединения (S2, подтверждено)

1. Клиент → `ClientNOP (210)` — **0xD2 + 7 нулевых байт (всего 8)**.
2. Сервер → `ServerHandshake (200)` — **32 байта** ASCII;
   `parseHandshake` берёт подстроку после первого пробела, ищет привилегии
   `k`(клавиатура)/`v`(видео)/`m`(мышь)/`s`(storage) и подпись `lbw`
   (`isCompatibleFirmware`). Пример: `MAHOGANY KVMS LBW`.
3. **Только после** `ServerHandshake` клиент → `ClientHandshake (221)` +
   `InformBSEMode (247,u32)` + `InformHLevelCompression (243,u8=1)` +
   `RequestPrimaryControl (211,u8=0)` + `Invalidate (242, left,top,right,bottom)`.
   ⚠ Не слать `RequestVesaMode (241)` — вызывает лишний сброс видеорежима.
4. Сервер → `FirmwareVersion (201)`, `MultiUserState (197)`,
   `StorageStatus (137, 1056 байт)`, затем видео
   (`InformVesaMode` + `BitBlt`/`EnhanceBitBlt`/`BSEBitBlt`).

## Рукопожатие клиента (221) — длины **u32le**, padding

```
cmd 0xdd
signature u32: 0x5A5A5A5A embedded | 0x12121212 standalone | 0x13131313 digest
userLen u32(=48), passLen u32(=48), configLen u32(=4), keyLen u32(=0)
username(48 байт, null-pad), password(48 байт, null-pad),
config u32(=0x1f=31), key(), passwordFull(228 байт, null-pad)
```
- `ClientHandshakeConfig` — бит.маска: 1=video, 2=mouse, 4=keyboard,
  8/16=storage0/1; полный доступ = **31**.
- embedded-режим (`0x5A5A5A5A`): `passwordFull` = `httpdata` (сессионный токен).
- standalone (`0x12121212`): обычный пароль; digest (`0x13131313`):
  MD5-hex от `user:key:pass`, `passwordFull` = digest.
- ⚠ Порядок: `ClientHandshake` слать **после** получения `ServerHandshake`.

## Команды сервер → клиент (в `MessageReceiverThread`)

| ID | Команда | Payload (после ID) |
|----|---------|--------------------|
| 200 | ServerHandshake | 32 байта ASCII |
| 201 | FirmwareVersion | len u32 + строка |
| 197 | MultiUserState | flags u32, sizes 2×u8, flags 2×u8, имена (size байт) |
| 198 | ServerDisconnect | reason u32, msglen u16, msg |
| 225 | InformVesaMode | mode u16, width u16, height u16, bpp u16 |
| 226 | BitBlt | bltType u16, fontH u8, fontW u8, src 4×u16, dst 4×u16, size u32, data |
| 227 | EnhanceBitBlt | bltType u16, tileW u8, tileH u8, triplet i32, repeat i32, raw u32, scrunch u32, snoop 2×64×u32, data(scrunch) |
| 231 | BSEBitBlt | bltType i32 (0/3/8/16/18), compLen u32, uncompLen u32, top/left/bottom/right u8, seq u32, data(compLen) |
| 237 | SSPBitBlt | compLen u32, uncompLen u32, top/left/bottom/right u8, seq u32, data(compLen) |
| 224 | LowBandwidthSSPBitBlt | как SSP (наследует `SSPBitBlt`) |
| 230 | SetPalette | attrSize u16 + attrSize×2Б (index,value), palSize u16 + palSize×4Б (offset,hi,mid,lo) |
| 234 | SetTextCursor | 4×u8 |
| 235 | SpecialGraphicsBit | u32 |
| 236 | MatroxGraphicsCursor | 256 + 64×48 байт |
| 228 | StandbyPower | — |
| 229 | InformCPUUtilization | 6×i32 |
| 213 | InformKeyIndicators | 3×bool |
| 239 | SequenceNumber | 3 резерв + u32 |
| 137 | StorageStatus | 16 IP + поля + 2×512Б пути |
| 222 | OemMsg | len u32 + data |
| 248 | NativeMessage | len u32 + data (aligned 4) |
| 199 | OemCurrentLocalMonitorState | 1 байт |
| 64 | OemLocalMonitorState | — |
| 238 | GraphicsRegisterValue | 15×i32 (5+8+2) |

## Команды клиент → сервер (в `MessageSender`)

| ID | Команда | Payload |
|----|---------|---------|
| 210 | ClientNOP | — |
| 221 | ClientHandshake | см. выше |
| 241 | RequestVesaMode | 0 (u8) |
| 242 | Invalidate | count u16 + n × (x,y,w,h u16) |
| 177 | ClientAbsoluteMode | bool |
| 178 | ClientRelativeMode | 2×bool |
| 179 | ButtonStateAtAbsolute | x i32, y i32, nbuttons u8, n×1Б (color state) |
| 180 | ButtonStateAtRelative | см. 179 |
| 181 | MouseMove | x i32, y i32 |
| 209 | KeyStateChange | scancode u16, down bool, preTranslated bool |
| 193 | RequestKeyIndicators | — |
| 211 | RequestPrimaryControl | — |
| 215 | RelinquishFullControl | — |
| 216 | ClientDisconnect | reason u32 |
| 65 | OemPowerControlAction | 1 байт: 1=on,0=off,2=cycle,3=reset,4=NMI,14=powerbtn,15=reboot,5=shutdown |
| 243 | InformHLevelCompression | bool |
| 247 | InformBSEMode | u8 (0=нет,1=3bpp,2=8bpp) |
| 244 | InformSleepMode | bool |
| 239 | SequenceNumber (ack) | u32 |

## Ключевые классы-источники

- Буферы/кодирование: `com.serverengines.buffer.LittleEndianBufferMgr`,
  `BufferMgr`.
- Диспетчер: `com.serverengines.mahogany.MessageReceiverThread` (сервер-команды),
  `MessageSender` (клиент-команды).
- Соединение: `com.serverengines.mahogany.CConn` (`init`/`onServerHandshake`),
  `CConnection`, разбор рукопожатия в `ServerHandshake.parseHandshake`.
- Видео: см. `irmc-video-decoding.md`.
