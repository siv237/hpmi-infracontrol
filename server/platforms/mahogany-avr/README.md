# Модуль платформы: mahogany-avr (Fujitsu iRMC S2/S3, Avocent/Mahogany)

Статус: **реализован** (контракты probe/login/createConsole/createMedia).
Весь платформенный код S2 перенесён из ядра; ядро использует модуль через реестр.

## Файлы модуля

| Файл | Роль |
|------|------|
| `manifest.js` | supported/access/capabilities/probes |
| `probe.js` | проба `web-signature` (Digest realm `iRMC S2@…` / `<title>…iRMC S2…`) |
| `login.js` | схема входа S2 (переиспользует `s2Session` из ядра) |
| `irmc.js` | консоль AVR (ConsoleClient) |
| `irmc-decode.js` | декодер видео (канон 0x00RRGGBB) |
| `m2.js` + `m2host.py` | виртуальный носитель Avocent URS (MediaRedirector) |
| `stor.js` | (эксперим.) чистый Node-URS |
| `index.js` | сборка контрактов для ядра |

Общий TLS-хелпер `permissiveTlsOptions` вынесен в ядро — `server/sdk/net.js`.

## Проверено на живом железе

| Модель | Прошивка | Что проверено | Дата |
|--------|----------|---------------|------|
| iRMC S2 (10.67.17.101) | — | консоль, ввод, ISO через M2 | 2026-09-08 |

## Грабли / quirks

- одна активная KVM-сессия; обязателен чистый ClientDisconnect;
- ISO только через M2 (Avocent URS); чистый Node-URS — в разработке;
- канон пикселей 0x00RRGGBB (drle-путь приводить к канону!).
