// 英単語マスターの Service Worker
//
// 役割：アプリ本体（HTML / CSS / JS / アイコン / manifest）をキャッシュし、電波がなくても起動できるようにする。
//
// ★ 教材データは扱わない ★
//   - データパック（zip）は、利用者が端末のファイルを選んで取り込む（ネットワークから取得しない）。
//   - 取り込んだ例文・音声は IndexedDB に入る（js/db.js）。音声の再生は blob: URL で、ここを通らない。
//   - この Service Worker が応答するのは「下の APP_FILES / PLANNED_FILES にあるファイル」と「画面の読み込み」だけ。
//     それ以外（別のオリジン、zip・mp3・json など一覧にないもの）には respondWith しない＝何もしない。
//
// ■ 取得の方針：ネットワーク優先＋失敗時はキャッシュ（タイムアウトつき）
//   理由：
//   1) 更新がすぐ届く：電波があれば毎回サーバーの最新版を使う。版の番号を上げ忘れても、古い画面が残り続けない。
//   2) JS の版がそろう：このアプリは ES モジュールを複数読み込む。「キャッシュ優先＋裏で更新」だと、
//      main.js は古い・db.js は新しい、のように版が混ざった状態で起動することがあり、関数の食い違いで壊れやすい。
//   3) オフラインで動く：取得に失敗した（圏外・機内モード）か、NETWORK_TIMEOUT_MS 以内に返事がないときは、
//      キャッシュの版を使う。取得できたものはキャッシュに入れ直すので、キャッシュも最新に近づく。
//   欠点：電波が弱いと、最大 NETWORK_TIMEOUT_MS だけ表示が遅れる。アプリ本体は小さいので、許容範囲と考える。
//
// ■ ファイルを足したとき・中身を変えたときの手順
//   1) 新しいファイル（例：js/modes/listening.js）を APP_FILES に足す。
//      まだ作っていないが近く足す予定のファイルは PLANNED_FILES に書いてよい（無くてもインストールは失敗しない）。
//   2) CACHE_VERSION の数字を 1 つ上げる（'kk-app-v1' → 'kk-app-v2'）。
//      画面に出す版 js/version.js の APP_VERSION と日付も同じ値に直す（tests/pwa.test.mjs で確かめている）。
//      これで新しい Service Worker が入り、画面に「新しい版があります」が出る（js/pwa.js の onUpdate）。
//      activate のときに古い版のキャッシュ（kk-app- で始まる別の名前）は消える。
//   3) node --test tests/pwa.test.mjs で、一覧のファイルが実在するか、js の入れ忘れがないかを確かめる。

const CACHE_PREFIX = 'kk-app-';
const CACHE_VERSION = 'v5';
const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;

// 電波が弱いとき、ネットワークの返事を待つ最大の時間（ミリ秒）。過ぎたらキャッシュで表示する。
const NETWORK_TIMEOUT_MS = 4000;

// インストール時にキャッシュするアプリ本体（sw.js から見た相対パス）。1 つでも取れなければインストールをやり直す。
const APP_FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/main.js',
  './js/version.js',
  './js/pwa.js',
  './js/db.js',
  './js/store.js',
  './js/audio.js',
  './js/srs.js',
  './js/quiz.js',
  './js/modes/today.js',
  './js/modes/listening.js',
  './js/modes/compose.js',
  './js/modes/dictation.js',
  './js/modes/weak.js',
  './js/modes/wordlist.js',
  './js/player.js',
  './js/modes/mylisten.js',
  './js/modes/mylisten-list.js',
  './css/compose.css',
  './css/dictation.css',
  './css/weak.css',
  './css/wordlist.css',
  './css/mylisten.css',
  './vendor/fflate.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

// 今後追加する予定のファイル。あればキャッシュし、無ければ飛ばす（インストールは失敗させない）。
// ファイルができたら APP_FILES に移す。
const PLANNED_FILES = [];

// 応答してよい URL（絶対 URL）の一覧。これ以外は素通しにする。
const scopeUrl = new URL('./', self.location.href);
const toUrl = (path) => new URL(path, scopeUrl).href;
const APP_URLS = new Set([...APP_FILES, ...PLANNED_FILES].map(toUrl));
const INDEX_URL = toUrl('./index.html');

// ---- インストール：アプリ本体をまとめてキャッシュ ----
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // cache: 'reload' … ブラウザの HTTP キャッシュを使わず、サーバーから取り直す（古い版を入れないため）
    await cache.addAll(APP_FILES.map((p) => new Request(toUrl(p), { cache: 'reload' })));
    await Promise.all(PLANNED_FILES.map(async (p) => {
      try {
        const res = await fetch(new Request(toUrl(p), { cache: 'reload' }));
        if (res.ok) await cache.put(toUrl(p), res);
      } catch {
        // 予定のファイルはまだ無くてよい
      }
    }));
    // 初めて入るときはすぐ有効にする。更新のときは待機し、利用者が「再読み込み」を押したら切り替える（下の message）。
    if (!self.registration.active) await self.skipWaiting();
  })());
});

// ---- 有効化：古い版のキャッシュを消す ----
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
        .map((name) => caches.delete(name)),
    );
    await self.clients.claim();
  })());
});

// ---- 画面からの合図：「再読み込み」が押されたら、待機中の新しい版をすぐ有効にする ----
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// ---- 取得 ----
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // 別のオリジンには触らない
  url.search = '';                                   // ?v=… などの付け足しは無視して照合する
  url.hash = '';

  const isNavigate = req.mode === 'navigate';
  if (!isNavigate && !APP_URLS.has(url.href)) return; // 一覧にないもの（教材データなど）は素通し

  event.respondWith(networkFirst(req, url.href, isNavigate));
});

/**
 * ネットワーク優先で取得し、失敗・時間切れのときはキャッシュを返す。
 * @param {Request} req 元のリクエスト
 * @param {string} key キャッシュのキー（検索文字列を除いた URL）
 * @param {boolean} isNavigate 画面の読み込みか（キャッシュに無いときは index.html を返す）
 */
async function networkFirst(req, key, isNavigate) {
  const cache = await caches.open(CACHE_NAME);

  // ネットワークから取得し、成功したらキャッシュを更新する
  const fromNetwork = fetch(req, { cache: 'no-cache' }).then(async (res) => {
    // 一覧にある本体ファイルだけをキャッシュに入れる。
    // リダイレクトされた応答は入れない（Safari は、Service Worker が返したリダイレクト済みの画面を表示できないため）
    if (res.ok && res.type === 'basic' && !res.redirected && APP_URLS.has(key)) {
      await cache.put(key, res.clone());
    }
    return res;
  });

  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), NETWORK_TIMEOUT_MS);
  });

  try {
    const res = await Promise.race([fromNetwork, timeout]);
    if (res) return res;
    // 時間切れ：キャッシュがあればそれを返す（ネットワークは裏で続け、取れたらキャッシュを更新する）
    const cached = await matchCache(cache, key, isNavigate);
    if (cached) {
      fromNetwork.catch(() => {});
      return cached;
    }
    return await fromNetwork;  // キャッシュも無ければ、ネットワークを待つしかない
  } catch (err) {
    // 圏外など：キャッシュを返す
    const cached = await matchCache(cache, key, isNavigate);
    if (cached) return cached;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** キャッシュから探す。画面の読み込みで見つからなければ index.html を返す。 */
async function matchCache(cache, key, isNavigate) {
  const hit = await cache.match(key);
  if (hit || !isNavigate) return hit;
  return cache.match(INDEX_URL);
}
