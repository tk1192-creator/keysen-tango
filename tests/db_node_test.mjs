// js/db.js の取り込み処理を node で確かめるテスト（IndexedDB はメモリ上の簡易な代役を使う）
//
// 使い方:
//   node tests/db_node_test.mjs                       … ダミーのパックで正常系と異常系を確かめる
//   node tests/db_node_test.mjs <zip のパス>           … 指定したパックを取り込めるか確かめる（件数だけ表示）
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ---- IndexedDB の簡易な代役（db.js が使う範囲だけ） ----
function makeFakeIndexedDB() {
  const dbs = new Map();
  const later = (fn) => setTimeout(fn, 0);
  const request = (fn, tx) => {
    const req = { onsuccess: null, onerror: null, result: undefined, error: null };
    tx._pending++;
    later(() => {
      try { req.result = fn(); req.onsuccess && req.onsuccess(); } catch (e) { req.error = e; req.onerror && req.onerror(); tx._fail(e); }
      tx._pending--; tx._maybeDone();
    });
    return req;
  };
  class Tx {
    constructor(db) { this.db = db; this._pending = 0; this._done = false; this.oncomplete = null; this.onerror = null; this.onabort = null; later(() => this._maybeDone()); }
    _maybeDone() { if (!this._done && this._pending === 0) { this._done = true; later(() => this.oncomplete && this.oncomplete()); } }
    _fail(e) { if (!this._done) { this._done = true; this.error = e; later(() => this.onerror && this.onerror()); } }
    objectStore(name) {
      const st = this.db._stores.get(name);
      const tx = this;
      return {
        put(v, k) { return request(() => { st.data.set(st.keyPath ? v[st.keyPath] : k, v); }, tx); },
        get(k) { return request(() => st.data.get(k), tx); },
        getAll() { return request(() => [...st.data.values()], tx); },
        clear() { return request(() => st.data.clear(), tx); },
      };
    }
  }
  return {
    open(name) {
      const req = { onupgradeneeded: null, onsuccess: null, onerror: null, result: null };
      later(() => {
        let db = dbs.get(name);
        const fresh = !db;
        if (fresh) {
          db = { _stores: new Map() };
          db.objectStoreNames = { contains: (n) => db._stores.has(n) };
          db.createObjectStore = (n, opt = {}) => db._stores.set(n, { keyPath: opt.keyPath, data: new Map() });
          db.transaction = () => new Tx(db);
          dbs.set(name, db);
        }
        req.result = db;
        if (fresh && req.onupgradeneeded) req.onupgradeneeded();
        req.onsuccess && req.onsuccess();
      });
      return req;
    },
    _dbs: dbs,
  };
}
globalThis.indexedDB = makeFakeIndexedDB();

const here = path.dirname(fileURLToPath(import.meta.url));
const db = await import(path.join(here, '..', 'js', 'db.js').replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));

const fileFrom = (bytes, name = 'pack.zip') => new File([bytes], name, { type: 'application/zip' });
let failures = 0;
const check = (cond, label) => { console.log(`${cond ? 'OK ' : 'NG '} ${label}`); if (!cond) failures++; };

const arg = process.argv[2];
if (arg) {
  // 指定したパックを取り込む
  const t0 = Date.now();
  let last = '';
  const info = await db.importPack(fileFrom(readFileSync(arg)), (p) => { if (p.phase !== last) { last = p.phase; console.log(`  …${p.message}`); } });
  const s = await db.getAllSentences(); const w = await db.getAllWords();
  const a = await db.getAudioBlob(s[0].file);
  console.log(`取り込み完了 ${((Date.now() - t0) / 1000).toFixed(1)} 秒：例文 ${s.length}・単語 ${w.length}・音声（1件目）${a ? a.size + ' バイト' : 'なし'}・title「${info.title}」`);
  check(s.length === info.counts.sentences && w.length === info.counts.words && a && a.type === 'audio/mpeg', '件数と音声の形式');
} else {
  const dummy = readFileSync(path.join(here, 'fixtures', 'dummy-pack.zip'));
  // 1) 正常系
  check((await db.getPackInfo()) === null, '取り込み前は pack 情報が null');
  const info = await db.importPack(fileFrom(dummy));
  check(info && info.format === 'kk-pack' && info.importedAt, '取り込み後に pack 情報が返る');
  const sents = await db.getAllSentences();
  check(sents.length === info.counts.sentences, `例文の件数（${sents.length}）`);
  check((await db.getAllWords()).length === info.counts.words, '単語の件数');
  const blob = await db.getAudioBlob(sents[0].file);
  check(blob && blob.size > 0 && blob.type === 'audio/mpeg', '音声が Blob（audio/mpeg）で取り出せる');
  // 2) 壊れた zip：前半だけ
  try { await db.importPack(fileFrom(dummy.subarray(0, Math.floor(dummy.length / 2)))); check(false, '途中で切れた zip はエラー'); }
  catch (e) { check(e instanceof db.PackError, `途中で切れた zip はエラー（${e.message}）`); }
  {
    // 失敗後は「空」か「前のデータのまま」のどちらか（中途半端な状態にならない）
    const p = await db.getPackInfo();
    const n = (await db.getAllSentences()).length;
    const ok = p === null ? n === 0 : n === p.counts.sentences;
    check(ok, `失敗後は中途半端なデータが残らない（${p === null ? '空' : '前のデータのまま'}）`);
  }
  // 3) zip ではないファイル
  try { await db.importPack(fileFrom(new TextEncoder().encode('これは zip ではありません'))); check(false, 'zip でないファイルはエラー'); }
  catch (e) { check(e instanceof db.PackError, `zip でないファイルはエラー（${e.message}）`); }
  // 4) pack.json の検査
  try { db.validatePackInfo({ format: 'other', version: 1, counts: { sentences: 1, words: 1, audio: 1 } }); check(false, '形式違い'); }
  catch (e) { check(e instanceof db.PackError, '形式違いの pack.json はエラー'); }
  try { db.validatePackInfo({ format: 'kk-pack', version: 99, counts: { sentences: 1, words: 1, audio: 1 } }); check(false, '版違い'); }
  catch (e) { check(e instanceof db.PackError, '対応していない版はエラー'); }
  try { db.validateCounts({ counts: { sentences: 2, words: 1, audio: 1 } }, { sentences: 1, words: 1, audio: 1 }); check(false, '件数違い'); }
  catch (e) { check(e instanceof db.PackError, '件数が合わないときはエラー'); }
  // 5) 入れ直し
  await db.importPack(fileFrom(dummy));
  check((await db.getAllSentences()).length === info.counts.sentences, '入れ直し後も件数が正しい（重複しない）');
}
console.log(failures ? `\n失敗 ${failures} 件` : '\nすべて OK');
process.exit(failures ? 1 : 0);
