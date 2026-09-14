# hp-lo100 — HP Lights-Out 100 / LO100i (ProLiant G5/G6)

KVM-консоль через Avocent/Mahogany AVR (тот же стек, что у Fujitsu iRMC):
общий движок — `server/sdk/avr/irmc.js`.

- **login** — Digest-вход + одноразовый `httpdata`-токен из `kvms.html`
  (ретраи с паузой: BMC рвёт подряд идущие HTTP-запросы).
- **createConsole** — `IrmcClient` с паддингами **16/20/128**, сигнатурой
  embedded `0x5A5A5A5A`, портом `NonSecure_KVMPort`; вместо пароля идёт токен.
- **probe** — 1 GET на «/» (title `BMC HTTP Server`) + запасной на `/kvms.html`.

Веб только HTTP:80. Проверено вживую: DL180 G6 fw 4.22 — `/api/connect` даёт
`state=live, 1024×768`. Паддинги и разбор kvms.html — `wiki/knowledge/hp-lo100-kvm.md`,
устройство M2.JAR — `wiki/knowledge/hp-lo100i-m2.md`.

# Файлы
- `manifest.js` — метаданные (priority 90, capabilities)
- `probe.js` — пробы (+ чистые матч-функции для тестов)
- `login.js` — вход (`fetchKvmApplet` + sessionCfg)
- `index.js` — фасад для реестра (sdk/registry.js)
