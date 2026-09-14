# hp-ilo — HPE iLO 4/5 (ProLiant Gen8+)

Распознавание + опрос по Redfish. Консоль iLO — протокол **IRC/RC.go**
(не Avocent AVR), мост не реализован → платформа **probe-only** (`kvm: false`).

- **probe** — 1 GET на «/» (маркеры `EOV-GUI`/`RpPageHeader`/HPE),
  запасной GET `/redfish/v1/` (`Oem.Hp`, отдаётся без логина).
- **Опрос** — сердце ядра: при отказе IPMI (`RMCP+` может быть выключен)
  `pollSensors` пробует `server/redfish.js` (`capabilities.redfish`).
  Сенсоры Thermal, журнал IML, инвентарь Systems/Managers — по Basic-auth.

Приоритет 94 (выше hp-lo100 90, но ниже Fujitsu-платформ) — на iLO матчимся
первыми среди HP, но не раньше фуджитсовых проб. Проверено вживую:
iLO 4 fw 2.80 (DL380p Gen8). Детали и квёрки — `wiki/knowledge/hp-ilo-redfish.md`.

# Файлы
- `manifest.js` — метаданные (priority 94, capabilities.redfish)
- `probe.js` — пробы (+ чистые матч-функции для тестов)
- `index.js` — фасад для реестра (только probe)
