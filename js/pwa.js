// PWA の準備：Service Worker の登録と、新しい版が入ったときの知らせ
//
// 使い方（画面側）:
//   import { onUpdate } from './pwa.js';
//   onUpdate((reload) => {
//     // 例：「新しい版があります。再読み込み」のバーを出し、ボタンが押されたら reload() を呼ぶ
//     showBanner('新しい版があります。', '再読み込み', reload);
//   });
//
// - このファイルを読み込むだけで、ページの読み込み完了後に ./sw.js を登録する（登録は 1 回だけ）。
// - Service Worker に対応していない環境（古いブラウザ、node でのテストなど）では何もしない。
// - 新しい版の Service Worker は「待機」の状態で止まる。reload() を呼ぶと切り替えて、ページを読み直す。
//   （勉強の途中で勝手に画面が読み直されないよう、切り替えは利用者の操作を待つ）

const SW_URL = './sw.js';

/** @type {Array<(reload: () => void) => void>} */
const listeners = [];
/** @type {ServiceWorker | null} 待機中の新しい版 */
let waitingWorker = null;
/** @type {Promise<ServiceWorkerRegistration | null> | null} */
let registering = null;
let reloading = false;

/** この環境で Service Worker が使えるか */
export function isSupported() {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof window !== 'undefined';
}

/**
 * 新しい版が使えるようになったときに呼ぶ関数を登録する。
 * すでに新しい版が待機中なら、すぐに呼ぶ。
 * @param {(reload: () => void) => void} callback 引数の reload() を呼ぶと、新しい版に切り替えて読み直す
 * @returns {() => void} 登録を外す関数
 */
export function onUpdate(callback) {
  listeners.push(callback);
  if (waitingWorker) callback(applyUpdate);
  return () => {
    const i = listeners.indexOf(callback);
    if (i >= 0) listeners.splice(i, 1);
  };
}

/** 待機中の新しい版に切り替えて、ページを読み直す（待機中の版が無ければ、ただ読み直す） */
export function applyUpdate() {
  if (!isSupported()) return;
  reloading = true;
  if (waitingWorker) {
    waitingWorker.postMessage({ type: 'SKIP_WAITING' });
    // 切り替わると controllerchange が起き、そこで読み直す
  } else {
    window.location.reload();
  }
}

/**
 * Service Worker を登録する（何度呼んでも登録は 1 回）。
 * @returns {Promise<ServiceWorkerRegistration | null>} 対応していない・失敗したときは null
 */
export function registerServiceWorker() {
  if (!isSupported()) return Promise.resolve(null);
  if (registering) return registering;

  registering = (async () => {
    try {
      const reg = await navigator.serviceWorker.register(SW_URL, { scope: './' });

      // すでに待機中の新しい版がある（前回開いたときに届いていた）
      if (reg.waiting && navigator.serviceWorker.controller) notify(reg.waiting);

      // 新しい版が届き始めたら、インストールが終わるのを見届ける
      reg.addEventListener('updatefound', () => {
        const worker = reg.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          // controller がある＝以前の版で動いている。そのときだけ「新しい版」と知らせる（初回は知らせない）
          if (worker.state === 'installed' && navigator.serviceWorker.controller) notify(worker);
        });
      });

      // 新しい版に切り替わったら読み直す（利用者が reload() を押したときだけ）
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!reloading) return;
        window.location.reload();
      });

      // アプリに戻ってきたとき（ホーム画面から開き直したときなど）に、更新がないか確かめる
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });

      return reg;
    } catch (err) {
      // 登録に失敗しても、アプリ自体は（オンラインなら）動くので、記録だけ残す
      console.warn('Service Worker を登録できませんでした', err);
      return null;
    }
  })();
  return registering;
}

/** 新しい版の知らせを、登録された関数に渡す */
function notify(worker) {
  waitingWorker = worker;
  for (const fn of listeners.slice()) {
    try {
      fn(applyUpdate);
    } catch (err) {
      console.warn('onUpdate の関数でエラーが起きました', err);
    }
  }
}

// 読み込まれたら登録する（ページの表示を優先し、load の後に行う）
if (isSupported()) {
  if (document.readyState === 'complete') {
    registerServiceWorker();
  } else {
    window.addEventListener('load', () => registerServiceWorker(), { once: true });
  }
}
