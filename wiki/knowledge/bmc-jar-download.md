# Как скачать JAR-вьювер с BMC (методика)

Когда в парке появляется новый тип BMC, его Java-вьювер (KVM-консоль) —
главный источник протокола. Методика скачивания (отработана на iRMC S4):

## Шаги

1. **Войти в веб BMC программно** (см. bmc-modules.md — схема входа
   конкретной модели; S4: POST-триггер + Digest-POST → 302 с `sid`).
2. **Найти ссылку JNLP** на главной странице после входа
   (`href="avr.jnlp?...&sid=<sid>"` — у Fujitsu; у AMI-стека бывает
   `JViewer.jnlp`). Сид-сессии одноразовые: каждый заход — свежий вход.
3. **Скачать JNLP** и вытащить ресурсы:
   - `codebase` — базовый URL;
   - `<jar href="...">` — основные JAR-ы;
   - `<application-desc main-class>` (может отсутствовать — см. манифест);
   - `<argument>`-строки — параметры запуска (там токены: `-kvmtoken`,
     `-webcookie`, порты, полномочия).
4. **Скачать JAR-ы** с codebase по href из JNLP (обычно `/Java/release/...`).
   Сохранять в `raw/` с суффиксом модели: `JViewer_S4.jar`,
   `JViewer-SOC_S4.jar` и т.п. JNLP-образец тоже в `raw/` (`.jnlp.sample`).
5. **Декомпилировать**: `java -jar /tmp/kilo/cfr.jar raw/<имя>.jar
   --outputdir /tmp/kilo/<тег>all` (CFR 0.152; результат вне репо).
6. **Искать точку входа**: класс из main-class (или `Usage:` в выводе —
   у AMI JViewer.java:478 есть строка usage со всеми аргументами).

## Что искать в декомпиле (приоритет)

- Токены/куки: `kvmtoken`, `webcookie`, `session` — как авторизуется KVM.
- Класс подключения: `SinglePortKVM` / `KVMClient` / `CConn` — формат
  рукопожатия (CONNECT-туннель? сырой сокет? TLS?).
- Пакеты протокола: `*PktHdr`, `*Packet` — команды, заголовки, кодеки.
- USB-redirection (ISO): `iusb` — если нужен проброс носителей.

## Реальные примеры

### iRMC S2 (Mahogany/Avocent) — `raw/avr_irmc_s2.jar`
Веб: Digest 401 на GET «/»; ссылка avr.jnlp на главной после Digest-входа.
Аргументы: `-httpdata=<...>` (embedded-подпись 0x5A5A5A5A), `-digest`.
Протокол: Mahogany AVR (ClientHandshake, signature 0x12121212 standalone).

### iRMC S4 (AMI-стек) — `raw/JViewer_S4.jar` (+ SOC/AVIStream)
Веб (Fw 7.69F): `/` 302→`/login`→форма-триггер `APPLY=99`→POST даёт 401
Digest (nonce одноразовый!) → **один** Digest-POST → 302 на
`/systeminfo?...&sid=<sid>` — sid и есть сессия. Далее страницы/JNLP
ходят с sid. JAR-ы: `/Java/release/JViewer{,-SOC,-AVIStream}.jar`.
Аргументы JNLP: `-kvmtoken`, `-kvmport 80`, `-kvmsecure 0`, `-webcookie`,
`-singleportenabled 1` — консоль через **HTTP CONNECT-туннель на web-порт**
(`SinglePortKVM.doTunnelHandshake`:
`CONNECT<host>:<port> HTTP/1.1 cookie <webSessionToken>`, затем
`JVIEWER <service> cookie <token>`, внутри — IVTP-пакеты `KVMClient`).
Протокол: AMI IVTP — НЕ Mahogany; нужен отдельный движок в проекте.

## Правила

- `raw/` — только исходники (бейн-код), туда не пишем ничего своего.
- Имена с суфиксом модели/поколения, чтобы не путать стеки.
- После скачивания: записать в log.md ingest + страницу модели в
  bmc-modules.md (сигнатуры, аргументы JNLP, классы подключения).
- Вьювер GPL/свободно распространяемый поставщиком — качаем легально.
