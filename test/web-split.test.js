import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { execSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = '/home/siv/proj/IPMI-Viewer';
const web = join(ROOT, 'web');

const CSS_FILES = ['base.css','components.css','dashboard.css','servers.css','console.css','events.css','logs.css','ui.css'];
const JS_FILES = ['core.js','events.js','tree.js','detail.js','ipmi.js','inventory.js','tabs.js','iso.js','users.js','tree-controls.js','console.js','layout.js','overview.js','logs.js','auth.js','init.js'];

const idx = readFileSync(join(web, 'index.html'), 'utf8');
const html = idx.slice(idx.indexOf('<body>'), idx.indexOf('</body>') + '</body>'.length);

test('Монолит разбит: в index.html нет inline <style> и inline <script> без src', () => {
  assert.ok(!/<style[\s>]/.test(idx), 'index.html не должен содержать <style>');
  const scripts = [...idx.matchAll(/<script\b[^>]*>/g)].map(m => m[0]);
  assert.ok(scripts.length >= 2, 'должны быть хотя бы подключения модулей');
  assert.ok(scripts.every(s => /src=/.test(s)), 'все <script> должны иметь src (ни одного inline-блока)');
});

test('Каждый css/js модуль из index.html существует; лишних файлов в web/css и web/js нет', () => {
  const links = [...idx.matchAll(/<link[^>]+href="\/css\/([\w-]+\.css)"/g)].map(m => m[1]);
  const srcs = [...idx.matchAll(/<script[^>]+src="\/js\/([\w-]+\.js)"/g)].map(m => m[1]);
  assert.deepEqual(links, CSS_FILES, 'CSS утерян/дублирован');
  assert.deepEqual(srcs, JS_FILES, 'JS утерян/дублирован');
  for (const f of CSS_FILES) assert.ok(existsSync(join(web, 'css', f)), 'есть файл css/' + f);
  for (const f of JS_FILES) assert.ok(existsSync(join(web, 'js', f)), 'есть файл js/' + f);
  const orphanCss = readdirSync(join(web, 'css')).filter(f => !CSS_FILES.includes(f));
  const orphanJs = readdirSync(join(web, 'js')).filter(f => !JS_FILES.includes(f));
  assert.equal(orphanCss.length, 0, 'сироты в css/: ' + orphanCss);
  assert.equal(orphanJs.length, 0, 'сироты в js/: ' + orphanJs);
});

for (const f of JS_FILES) {
  test('синтаксис js/' + f, () => {
    const r = spawnSync('node', ['--check', join(web, 'js', f)], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  });
}

test('Все JS-модули вместе (в порядке подключения) — синтаксически корректный файл', () => {
  const concat = JS_FILES.map(f => readFileSync(join(web, 'js', f), 'utf8')).join('\n');
  const tmp = '/tmp/_concatenated.mjs';
  writeFileSync(tmp, concat);
  const r = execSync('node --check ' + tmp).toString(); // execSync throws on failure
  try { unlinkSync(tmp); } catch {}
  assert.equal(typeof r, 'string');
});

// --- срез: функции, обязанные присутствовать (из исходного монолита) ---
const EXPECTED_FUNCTIONS = [
  // core
  'snack','esc','sessionHeaders','api','setStatus',
  // events
  'addEvent','renderEvents',
  // tree
  'load','treeFilter','branchKey','loadUiConfig','loadExpanded','saveExpanded','renderTree','delServer','restoreDetail',
  // detail
  'select','hideDetail','showDetail','renderDetail','trustKeys','valFrom','renderSI','renderHWTable',
  // ipmi
  'hotCls','resetMetrics','loadSensors','loadMetrics','setMetric','setMetricSub','drawSpark','clearChart','tempChart','fanChart','respChart','avChart',
  // inventory
  'loadInv','fmtDump','showVersionHistory',
  // overview
  'stChip','chCell','drawAvailabilityChart','loadOverview','renderOverviewRows','buildGroupFilter','startOverview',
  // tabs
  'switchTab',
  // iso
  'loadIso','isoDelete','isoRename','isoUpload','fmtMB','loadMounts','renderMount','unmountISO','openMountPicker','fmtDur','fmtB','startStorageMetrics','stopStorageMetrics','renderStorage',
  // users
  'loadUsers','renderUserBox','renderUsers','openUserDlg','delUser','applyPerms','renderProfile',
  // tree-controls
  'openDlg',
  // console
  'showMsg','conOf','curCon','curToken','showConsole','startSnapshotLoop','connectConsole','disconnectConsole','sendKeys','tapKey',
  // layout
  'setFold','showPage',
  // overview
  'stChip','drawAvailabilityChart','loadOverview','renderOverviewRows','buildGroupFilter','startOverview',
  // logs
  'logTs','logSevChip','loadLogs','filteredLogs','renderLogs','buildLogServerFilter','selectLog','initLogsUI',
  // auth
  'showLogin','hideLogin','enterApp',
];

function topLevelFunctions(code) {
  const re = /^(?:\(?(?:async\s+)?function\s+)([A-Za-z_$][\w$]*)/gm;
  const out = [];
  for (const m of code.matchAll(re)) out.push(m[1]);
  return out;
}

test('Все нужные функции из монолита на месте, ровно по одному разу', () => {
  const seen = new Map();
  for (const f of JS_FILES) {
    const names = topLevelFunctions(readFileSync(join(web, 'js', f), 'utf8'));
    for (const n of names) seen.set(n, (seen.get(n) || 0) + 1);
  }
  for (const name of EXPECTED_FUNCTIONS) {
    assert.equal(seen.get(name), 1, 'функция ' + name + ' должна быть ровно один раз, есть ' + seen.get(name));
  }
  for (const [name, cnt] of seen) {
    if (!EXPECTED_FUNCTIONS.includes(name)) {
      // boot — допустимая top-level IIFE-функция
      if (name === 'boot') continue;
      assert.fail('лишняя/неизвестная top-level функция: ' + name);
    }
  }
});

// --- одиночные top-level объявления (нет дублей имён между классическими скриптами) ---
function topLevelDecls(code) {
  const re = /^(?:(?:const|let|var)\s+([A-Za-z_$][\w$]*)|(?:\(?(?:async\s+)?function\s+)([A-Za-z_$][\w$]*))/gm;
  const out = [];
  for (const m of code.matchAll(re)) out.push(m[1] || m[2]);
  return out;
}
test('Нет дублей top-level имён между модулями (общий global scope)', () => {
  const where = new Map();
  for (const f of JS_FILES) {
    for (const n of topLevelDecls(readFileSync(join(web, 'js', f), 'utf8'))) {
      if (where.has(n)) assert.fail('имя ' + n + ' объявлено и в ' + where.get(n) + ', и в ' + f);
      where.set(n, f);
    }
  }
  // isAdmin — это const-стрелка в core.js (а не function-декларация)
  assert.equal(topLevelDecls(readFileSync(join(web, 'js', 'core.js'), 'utf8')).includes('isAdmin'), true, 'isAdmin должен быть объявлен в core.js');
});

test('Каждый $("id")/document-ид, на который ссылается JS, существует в HTML', () => {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  const refs = new Set();
  for (const f of JS_FILES) {
    const code = readFileSync(join(web, 'js', f), 'utf8');
    for (const m of code.matchAll(/\$\s*\(\s*'([^']+)'\s*\)/g)) refs.add(m[1]);
  }
  const missing = [...refs].filter(id => !ids.has(id));
  assert.deepEqual(missing, [], 'JS ссылается на отсутствующие id в HTML');
});

test('Сервер раздаёт /css/* и /js/* (роут добавлен после разреза)', () => {
  const srv = readFileSync(join(ROOT, 'server', 'index.js'), 'utf8');
  assert.match(srv, /css\|js/, 'server/index.js должен отдавать статические модули');
  assert.match(srv, /mimeFor\(fpath\)/);
});
