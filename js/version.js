// アプリの版（画面に表示する）。
// 更新して公開するときは、sw.js の CACHE_VERSION と同じ値に上げ、日付も直す。
// 2 つがそろっているかは tests/pwa.test.mjs で確かめている。
export const APP_VERSION = 'v6';
export const APP_DATE = '2026-11-14';
export const APP_VERSION_LABEL = `${APP_VERSION}（${APP_DATE}）`;
