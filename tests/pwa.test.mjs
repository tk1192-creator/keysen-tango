// PWA の設定（manifest.webmanifest / sw.js / js/pwa.js）を確かめるテスト
//
// 使い方:
//   node --test tests/pwa.test.mjs
//
// 確かめること:
//   - manifest.webmanifest が JSON として正しく、必要な項目があり、アイコンのファイルが実在する
//   - アイコンが PNG で、manifest に書いた大きさと一致する
//   - sw.js のキャッシュ一覧（APP_FILES）のファイルが実在する（PLANNED_FILES は無くてもよい）
//   - js/ と js/modes/ の .js がキャッシュ一覧から漏れていない（モードを足したときの入れ忘れ防止）
//   - js/pwa.js が node（Service Worker の無い環境）で読み込んでもエラーにならない
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => path.join(ROOT, p.replace(/^\.\//, ''));

/** PNG の幅と高さを読む（IHDR） */
function pngSize(file) {
  const buf = readFileSync(file);
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${file} が PNG ではありません`);
  assert.equal(buf.subarray(12, 16).toString('latin1'), 'IHDR');
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

/** sw.js を、Service Worker の代わりの簡易な環境で実行し、定数を取り出す */
function loadSw() {
  const code = readFileSync(rel('sw.js'), 'utf8');
  const handlers = {};
  const self = {
    location: { href: 'https://example.github.io/repo/sw.js', origin: 'https://example.github.io' },
    addEventListener: (type, fn) => { handlers[type] = fn; },
    registration: {},
    clients: {},
  };
  const context = vm.createContext({ self, URL, Set, Request: class {}, caches: {}, fetch: () => {}, setTimeout, clearTimeout });
  vm.runInContext(
    `${code}\n;globalThis.__sw = { CACHE_NAME, APP_FILES, PLANNED_FILES, APP_URLS };`,
    context,
    { filename: 'sw.js' },
  );
  return { ...context.__sw, handlers };
}

test('manifest.webmanifest：JSON として正しく、必要な項目がある', () => {
  const m = JSON.parse(readFileSync(rel('manifest.webmanifest'), 'utf8'));
  assert.equal(m.name, 'キーセン単語');
  assert.equal(m.short_name, 'キーセン単語');
  // GitHub Pages のサブパスで動くよう、相対で書く
  assert.equal(m.start_url, './');
  assert.equal(m.scope, './');
  assert.equal(m.display, 'standalone');
  assert.equal(m.orientation, 'portrait');
  assert.equal(m.lang, 'ja');
  assert.match(m.theme_color, /^#[0-9a-f]{6}$/i);
  assert.match(m.background_color, /^#[0-9a-f]{6}$/i);

  // 色が css/style.css の --primary / --bg（明るい表示のほう＝最初に出てくる定義）と一致する
  const css = readFileSync(rel('css/style.css'), 'utf8');
  const primary = css.match(/--primary:\s*(#[0-9a-fA-F]{6})/)[1];
  const bg = css.match(/--bg:\s*(#[0-9a-fA-F]{6})/)[1];
  assert.equal(m.theme_color.toLowerCase(), primary.toLowerCase());
  assert.equal(m.background_color.toLowerCase(), bg.toLowerCase());
});

test('manifest.webmanifest：アイコンが実在し、大きさが合っている', () => {
  const m = JSON.parse(readFileSync(rel('manifest.webmanifest'), 'utf8'));
  assert.ok(Array.isArray(m.icons) && m.icons.length >= 3);
  for (const icon of m.icons) {
    assert.ok(!icon.src.startsWith('/'), `アイコンのパスは相対で書く：${icon.src}`);
    const file = rel(icon.src);
    assert.ok(existsSync(file), `アイコンがありません：${icon.src}`);
    const [w, h] = pngSize(file);
    assert.equal(`${w}x${h}`, icon.sizes, `${icon.src} の大きさ`);
  }
  const sizes = (purpose) => m.icons.filter((i) => (i.purpose || 'any').split(' ').includes(purpose)).map((i) => i.sizes);
  assert.ok(sizes('any').includes('192x192'));
  assert.ok(sizes('any').includes('512x512'));
  assert.ok(sizes('maskable').includes('512x512'));
  assert.deepEqual(pngSize(rel('icons/apple-touch-icon.png')), [180, 180]);
});

test('sw.js：キャッシュ一覧のファイルが実在する', () => {
  const sw = loadSw();
  assert.match(sw.CACHE_NAME, /^kk-app-v\d+$/);
  assert.ok(sw.APP_FILES.includes('./'));
  assert.ok(sw.APP_FILES.includes('./index.html'));
  for (const p of sw.APP_FILES) {
    assert.ok(p.startsWith('./'), `相対パス（./ で始まる）で書く：${p}`);
    if (p === './') continue;
    assert.ok(existsSync(rel(p)), `キャッシュ一覧にあるのに、ファイルがありません：${p}`);
  }
  // 予定のファイル（PLANNED_FILES）は、無くてもよい。重複だけ確かめる
  for (const p of sw.PLANNED_FILES) {
    assert.ok(!sw.APP_FILES.includes(p), `APP_FILES と PLANNED_FILES の両方にあります：${p}`);
  }
  assert.equal(new Set(sw.APP_FILES).size, sw.APP_FILES.length, 'APP_FILES に重複があります');
});

test('sw.js：js/ と js/modes/ の .js、manifest のアイコンが一覧から漏れていない', () => {
  const sw = loadSw();
  const listed = new Set([...sw.APP_FILES, ...sw.PLANNED_FILES]);
  const jsFiles = [
    ...readdirSync(rel('js')).filter((f) => f.endsWith('.js')).map((f) => `./js/${f}`),
    ...readdirSync(rel('js/modes')).filter((f) => f.endsWith('.js')).map((f) => `./js/modes/${f}`),
  ];
  for (const f of jsFiles) {
    assert.ok(listed.has(f), `sw.js の APP_FILES に足してください：${f}`);
  }
  const m = JSON.parse(readFileSync(rel('manifest.webmanifest'), 'utf8'));
  for (const icon of m.icons) assert.ok(listed.has(`./${icon.src}`), `sw.js の APP_FILES に足してください：./${icon.src}`);
  for (const f of ['./manifest.webmanifest', './css/style.css', './vendor/fflate.js', './icons/apple-touch-icon.png']) {
    assert.ok(listed.has(f), `sw.js の APP_FILES に足してください：${f}`);
  }
});

test('sw.js：教材データ（zip・mp3・json）や別のオリジンには応答しない', () => {
  const sw = loadSw();
  for (const p of [...sw.APP_FILES, ...sw.PLANNED_FILES]) {
    assert.doesNotMatch(p, /\.(zip|mp3|json)$|data\//i, `教材データをキャッシュ一覧に入れない：${p}`);
  }
  const fetchHandler = sw.handlers.fetch;
  assert.equal(typeof fetchHandler, 'function');
  const tryFetch = (url, mode = 'cors', method = 'GET') => {
    let responded = false;
    fetchHandler({ request: { url, mode, method }, respondWith: (p) => { responded = true; Promise.resolve(p).catch(() => {}); } });
    return responded;
  };
  const base = 'https://example.github.io/repo/';
  assert.equal(tryFetch(base + 'syswords-pack.zip'), false);
  assert.equal(tryFetch(base + 'data/private/sentences.json'), false);
  assert.equal(tryFetch(base + 'audio/C0000_0001.mp3'), false);
  assert.equal(tryFetch('https://cdn.example.com/repo/js/main.js'), false);
  assert.equal(tryFetch(base + 'js/main.js', 'cors', 'POST'), false);
  // アプリ本体と画面の読み込みには応答する
  assert.equal(tryFetch(base + 'js/main.js'), true);
  assert.equal(tryFetch(base + 'js/main.js?v=2'), true);
  assert.equal(tryFetch(base, 'navigate'), true);
});

test('js/pwa.js：Service Worker の無い環境で読み込んでもエラーにならない', async () => {
  const mod = await import(pathToFileURL(rel('js/pwa.js')).href);
  assert.equal(mod.isSupported(), false);
  assert.equal(await mod.registerServiceWorker(), null);
  const off = mod.onUpdate(() => { throw new Error('呼ばれないはず'); });
  assert.equal(typeof off, 'function');
  off();
  mod.applyUpdate(); // 何もしない
});
