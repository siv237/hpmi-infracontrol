# iRMC S4: веб-вход и KVM-консоль (IVTP/AMI)

S4 = Fujitsu-обвязка над AMI-стеком. Всё проверено на живом
dgk51srv042 (iRMC S4, Fw 7.69F).

## Веб-вход (discover.js)

- GET `/` → 302 → `/login` → 200 «Login required» (форма `APPLY=99`,
  action="#login").
- POST `/login` (тело `APPLY=99&P99=Login`) → **401 Digest**. НОНCE
  одноразовый: повторный POST с тем же nonce отвергается — поэтому
  curl `--digest` НЕ работает (повторяет POST).
- Работает: **один** Digest-POST с nc=00000001 (s4Login) → **302** на
  `/systeminfo?...&sid=<sid>`. sid и есть веб-сессия; все страницы/JNLP
  ходят с sid в query.
- Токены JNLP (`-kvmtoken`, `-webcookie`) одноразовые — берутся свежие
  при каждом подключении (аналог httpdata у S2).

## KVM-консоль (console-ivtp.js, IVTP-протокол AMI)

Транспорт — HTTP CONNECT-туннель (singleportenabled=1):
- TCP к web-порту (80); ЦЕЛЬ CONNECT — `host:443` (**websecureport** из
  JNLP, НЕ 80 — с целью :80 BMC отвечает 200, но поток молчит!);
- `CONNECT host:443 HTTP/1.1\n cookie <webcookie>\r\n\r\n`
  + `JVIEWER VIDEO cookie <webcookie>\r\n\r\n` → `HTTP/1.1 200 OK\r\n`
  сразу бинарный поток (двойного CRLF нет — парсить по первой строке).

Рукопожатие:
1. `[21 GET_WEB_TOKEN]` hdr(21,len) + webcookie-байты
2. `[18 VALIDATE_VIDEO_SESSION]` hdr(18,373) + body: `\x00` +
   kvmtoken (pad 130) + clientIP (pad 65) + username (pad 129) + pad →
3. `[6 RESUME_REDIRECTION]`
4. ← `[19 VALIDATE_VIDEO_SESSION_RESPONSE]` status 0 = ok → **обязательно
   `[11 GET_FULL_SCREEN]`** — без него BMC молчит (кадры только при
   изменениях; статика/blank вообще ничего не шлёт)
5. ← `[25 VIDEO_FRAGMENT]*` — кадр фрагментами; ← `[9 BLANK_SCREEN]`,
   `[37] ConfPkt`, `[4096/4097]` палитра/атрибуты (текстовый режим),
   `[4098]` аппаратный курсор.

Кадр [25]: body = fragNum(2 LE) + payload. Первый фрагмент
`fragNum&0x7fff==0`, финальный `&0x8000`. Пропущено начало — дроп до
следующего полного. Кадр = SOCFrameHdr 34 б LE:
`flags(4) comp(1) frameSize(4) resX(2) resY(2) width(2) height(2)
syncLoss(1) modeChange(1) tileCol(1) tileRow(1) textOff(1)
bytesPP(1)[offset 22] videoFlags(1) charH(1) l/r/t/b(4) textFlags(1)
act_bpp(1) tileCap(2) bw(1)` + пиксели.

Кодеки (compressionType): 0/10 = raw; **8** = DrleBuffer (байтовый
RLE: `0x55 cnt val` → cnt+1 повторов; cnt 0 → литерал 0x55; cnt 1 →
0xAA; `0xAA val` → 3×val); 6 = пары u16/u32 (16/24bpp); 4/7 = QLZW
(не реализовано). Мусор (resX<300||>1920) — отбрасывать (как JViewer).

Ввод IUSB-HID (полный буфер, checksum [19] = -(сумма байт [8..39])):
- клава `[1,41]`: IUSB-заголовок 34 б (sig «IUSB    », dev 0x30, proto
  0x10, ifnum 0, dataLen 9, [38]=8) + USB-отчёт [mods,0,k1..k6];
- мышь ABS `[1,39]`: dev 0x31, proto 0x20, ifnum 1, dataLen 7, [38]=6 +
  `btn(1) x-i16 y-i16 wheel(1)` (координаты ×32767/screenW).

ГРАБЛИ (все уже наступлены):
- **Одна KVM-сессия на BMC**: новое подключение (в т.ч. чужой JViewer
  или второй наш клиент-тест) вытесняет прежнее → onExit → reconnect
  (как у S2).
- Цель CONNECT именно websecureport (443 у 042), сокет при этом на 80.
- Без [11] после [19] — тишина; мышиные движения генерируют кадры.
- ServerInit в RFB-мосте берёт fb на момент подключения: если сессия
  переподнята (reconnect), первый ws-клиент может увидеть 0×0 —
  keyframe-интервал (10 с, [11]+forceFull) выравнивает.

## Интеграция

- `getSession()` (discover.js): S2-путь → если «Login required» →
  s4Login → JNLP → возвращает `{s4Sid, kvmPort, kvmSecure, webSecurePort,
  kvmtoken, webcookie}`.
- `startSession()` (index.js): `cfg.s4Sid` → IvtpClient; `sess.engine
  ='ivtp'`; fb()/key/mouseMove/buttonState разветвлены по engine.
- vnc.js (RFB → noVNC) — общий, без изменений.

## Ограничения / TODO

- QLZW-кадры (comp 4/7) не декодируются (на 042 не встречались).
- Текстовый режим (4096 атрибуты + палитра) пока не рендерится: на 042
  поток — пиксельные кадры. Если встретится текст-only BMC — добавить
  рендер как в irmc-decode.js (isText).
- Виртуальные носители S4: SCCI/Redfish VirtualMedia (NFS/CIFS, без
  клиента) — см. raw/InfraControl_iRMC_S4_JViewer_Research.md §7;
  отдельная задача (ROADMAP).
- HTML5-вьюер (Java-free) на S4 — только с прошивки 8.05F; у 042
  7.69F. SCCI OE=1633 переключает Java/HTML5.
- KVM/VirtualMedia — лицензия iRMC Advanced Pack (bits: 1=KVM,
  2=media, 3=eLCM); пустые AllowableValues у Redfish VirtualMedia =
  нет лицензии.
