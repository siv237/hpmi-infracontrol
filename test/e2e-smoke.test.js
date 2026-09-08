import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

// E2E-смок: страница грузится в реальном браузере, все css/js-модули разреза
// отдают 200, приложение инициализируется без JS-ошибок.
//
// Требует запущенного сервера (./start.sh, порт 1845) и executable-браузера.
// Тест САМ НЕ поднимает сервер (правило проекта): без запущенного сервера
// или без найденного браузера — аккуратно пропускается.
//   CHROME=/path/to/chrome E2E_BASE_URL=http://127.0.0.1:1845 npm run test:e2e
const BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:1845';
const CANDIDATES = [
  process.env.CHROME,
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean);
const EXE = CANDIDATES.find(existsSync);

async function serverUp() {
  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 1500);
    const r = await fetch(BASE + '/', { signal: ctl.signal });
    clearTimeout(to);
    return r.status === 200;
  } catch { return false; }
}

test('E2E: приложение грузится, модули отдают 200, инициализация без JS-ошибок', async (t) => {
  if (!(await serverUp())) {
    t.skip(`сервер не отвечает на ${BASE} — выполните ./start.sh, затем npm run test:e2e`);
    return;
  }
  if (!EXE) {
    t.skip('не найден executuable браузера — задайте CHROME=/path/to/chrome');
    return;
  }
  const browser = await puppeteer.launch({ executablePath: EXE, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    const jsErrConsole = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    // Сетевой шум вида «Failed to load resource … 401» — штатный флоу: при
    // просроченном токене boot вызывает /api/me → 401 → api() показывает вход.
    // Критичны только незакрытые исключения и явные JS-ошибки консоли.
    page.on('console', (m) => {
      if (m.type() === 'error' && !/Failed to load resource/i.test(m.text())) jsErrConsole.push(m.text());
    });

    const res = await page.goto(BASE + '/', { waitUntil: 'networkidle0', timeout: 20000 });
    assert.equal(res.status(), 200, 'GET / должен отдавать 200');

    // каждый css/js-модуль разреза отдаётся с 200
    for (const f of ['/css/base.css', '/css/dashboard.css', '/js/core.js', '/js/overview.js', '/js/init.js']) {
      const status = await page.evaluate(async (u) => (await fetch(u)).status, f);
      assert.equal(status, 200, 'модуль доложен отдаваться: ' + f);
    }

    // без auth-токена должен показаться экран входа (приложение инициализировалось)
    const loginShown = await page.$eval('#loginView', (el) => el.classList.contains('show')).catch(() => false);
    assert.equal(loginShown, true, 'должен показаться экран входа');

    // разметка не должна содержать inline <script>/<style> монолита
    const inlineMonolith = await page.evaluate(() => ({
      styles: [...document.querySelectorAll('style')].length,
      inlineScripts: [...document.querySelectorAll('script:not([src])')].length,
    }));
    assert.equal(inlineMonolith.styles, 0, 'не должно быть inline <style>');
    assert.equal(inlineMonolith.inlineScripts, 0, 'не должно быть inline <script>');
    const scriptCount = await page.evaluate(() => document.querySelectorAll('script[src^="/js/"]').length);
    assert.ok(scriptCount >= 10, 'подключено достаточно js-модулей');

    assert.deepEqual(pageErrors, [], 'Не должно быть незакрытых JS-ошибок при инициализации');
    assert.deepEqual(jsErrConsole, [], 'Не должно быть JS-ошибок в консоли');
  } finally {
    await browser.close();
  }
});
