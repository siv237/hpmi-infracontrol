# Модуль платформы: ami-soc (Fujitsu iRMC S4, AMI/SOC)

Статус: **реализован** (контракты probe/login/createConsole/createMedia).
Код перенесён из ядра; ядро использует модуль через реестр.

## Файлы модуля

| Файл | Роль |
|------|------|
| `manifest.js` | supported/access/capabilities/probes |
| `probe.js` | проба `web-signature` (Server: iRMC S4) |
| `login.js` | схема входа S4 (переиспользует `s4Session` из ядра) |
| `console-ivtp.js` | консоль IVTP (ConsoleClient) |
| `s4cmdir.js` | VirtualMedia CDMEDIA/IUSB (MediaRedirector) |
| `index.js` | сборка контрактов для ядра |

## Проверено на живом железе

| Модель | Прошивка | Что проверено | Дата |
|--------|----------|---------------|------|
| iRMC S4 (dgk51srv042) | 7.69F | консоль, ввод, цвета, ISO (CDMEDIA) | 2026-09-11 |

## Грабли / quirks

- вход: Digest за формой POST /login APPLY=99 → 302 sid; kvmtoken/webcookie из avr.jnlp;
- KVM и CDMEDIA — HTTP-Connect туннель `CONNECT host:443` + cookie;
- media auth: SendAuth_SessionToken, токен с offset 63 (иначе status=3);
- ответный IUSB-кадр зеркалит заголовок запроса;
- IVTP [24] MediaRedirectionState — подключение/отключение устройств;
- BMC объявляет фиксированные слоты (cdnum=2, hdnum=1) — это норма;
- канон пикселей 0x00RRGGBB.
