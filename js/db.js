// IndexedDB（データパック）の読み書き
// 形式は tools/PACK_FORMAT.md を参照。
// - zip はストリーミングで展開し、mp3 は 1 ファイルずつ保存する（iPhone のメモリ対策）
// - meta の "pack" は最後に書く。これが無い状態＝取り込みが完了していない状態
// - 途中で失敗したら全ストアを空に戻す（中途半端なデータを残さない）

import { Unzip, UnzipInflate, strFromU8 } from '../vendor/fflate.js';

const DB_NAME = 'kk-data';
const DB_VERSION = 1;
const STORES = ['meta', 'sentences', 'words', 'audio'];
const PACK_FORMAT = 'kk-pack';
const SUPPORTED_VERSIONS = [1];
const AUDIO_BATCH = 20; // 何ファイルずつまとめて保存するか

let dbPromise = null;

/** 取り込み時のエラー（画面にそのまま出せる日本語メッセージを持つ） */
export class PackError extends Error {
  constructor(message, kind = 'invalid') {
    super(message);
    this.name = 'PackError';
    this.kind = kind; // invalid（形式違い）/ broken（壊れた zip）/ quota（容量不足）/ unknown
  }
}

/** データベースを開く（初回はストアを作る） */
export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('sentences')) db.createObjectStore('sentences', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('words')) db.createObjectStore('words', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

/** IDBRequest / IDBTransaction を Promise にする */
function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
}
function result(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getOne(store, key) {
  const db = await openDB();
  return result(db.transaction(store).objectStore(store).get(key));
}
async function getAll(store) {
  const db = await openDB();
  return result(db.transaction(store).objectStore(store).getAll());
}

/** 取り込み済みならパック情報、未取り込み（または途中で失敗）なら null */
export function getPackInfo() { return getOne('meta', 'pack').then((v) => v || null); }
export function getSentence(id) { return getOne('sentences', id); }
export function getAllSentences() { return getAll('sentences'); }
export function getAllWords() { return getAll('words'); }
export function getAudioBlob(fileName) { return getOne('audio', fileName); }

/** 全ストアを空にする */
export async function clearAll() {
  const db = await openDB();
  const tx = db.transaction(STORES, 'readwrite');
  for (const s of STORES) tx.objectStore(s).clear();
  await done(tx);
}

async function putMany(store, items, keyOf = null) {
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  const os = tx.objectStore(store);
  for (const it of items) {
    if (keyOf) os.put(it.value, keyOf(it)); else os.put(it);
  }
  await done(tx);
}

/** pack.json の検査。問題があれば PackError を投げる */
export function validatePackInfo(info) {
  if (!info || info.format !== PACK_FORMAT) {
    throw new PackError('このファイルは「英単語マスター」のデータパックではありません。');
  }
  if (!SUPPORTED_VERSIONS.includes(info.version)) {
    throw new PackError(`データパックの版（${info.version}）にこのアプリは対応していません。アプリを最新にしてください。`);
  }
  const c = info.counts || {};
  for (const k of ['sentences', 'words', 'audio']) {
    if (!Number.isInteger(c[k]) || c[k] <= 0) {
      throw new PackError('データパックの情報（件数）が正しくありません。PC で作り直してください。');
    }
  }
}

/** 取り込み後の件数の検査 */
export function validateCounts(info, actual) {
  const c = info.counts;
  const ng = ['sentences', 'words', 'audio'].filter((k) => c[k] !== actual[k]);
  if (ng.length) {
    const detail = ng.map((k) => `${k}: 予定 ${c[k]} 件／実際 ${actual[k]} 件`).join('、');
    throw new PackError(`データパックの中身が足りないか、壊れています（${detail}）。PC で作り直してください。`, 'broken');
  }
}

/** 空き容量の事前確認（使えない環境では何もしない） */
async function checkSpace(bytes) {
  try {
    if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
    if (navigator.storage && navigator.storage.estimate) {
      const { quota, usage } = await navigator.storage.estimate();
      if (quota && usage != null && quota - usage < bytes * 1.2) {
        const needMB = Math.ceil((bytes * 1.2) / 1e6);
        const freeMB = Math.floor((quota - usage) / 1e6);
        throw new PackError(`保存できる容量が足りません（必要 約${needMB}MB／空き 約${freeMB}MB）。端末の空き容量を増やしてから、もう一度試してください。`, 'quota');
      }
    }
  } catch (e) {
    if (e instanceof PackError) throw e;
    // 見積もりが取れない環境は、そのまま進める
  }
}

function isQuotaError(e) {
  return e && (e.name === 'QuotaExceededError' || /quota/i.test(String(e.message || e)));
}

/**
 * データパック（zip）を取り込む
 * @param {File|Blob} file 選ばれた zip
 * @param {(p:{phase:string,done:number,total:number,message:string})=>void} onProgress 進捗
 * @returns {Promise<object>} 保存したパック情報
 */
export async function importPack(file, onProgress = () => {}) {
  const report = (phase, done, total, message) => onProgress({ phase, done, total, message });
  report('check', 0, 1, 'ファイルを確認しています…');
  await checkSpace(file.size);

  let info = null;            // pack.json の中身
  let sentences = null;
  let words = null;
  let cleared = false;        // 既存データを消したか
  const ready = [];           // 展開が終わったファイル {name, chunks}
  const pendingAudio = [];    // まだ保存していない mp3 {key, value}
  let audioSaved = 0;
  let unzipError = null;

  const unzip = new Unzip((f) => {
    const chunks = [];
    f.ondata = (err, dat, final) => {
      if (err) { unzipError = err; return; }
      if (dat && dat.length) chunks.push(dat);
      if (final) ready.push({ name: f.name, chunks });
    };
    f.start();
  });
  unzip.register(UnzipInflate);

  const textOf = (chunks) => {
    let len = 0;
    for (const c of chunks) len += c.length;
    const all = new Uint8Array(len);
    let o = 0;
    for (const c of chunks) { all.set(c, o); o += c.length; }
    return strFromU8(all);
  };
  const parseJSON = (name, chunks) => {
    try { return JSON.parse(textOf(chunks)); } catch {
      throw new PackError(`データパックの中の ${name} が読めません。PC で作り直してください。`, 'broken');
    }
  };

  // pack.json を確認できたら、既存データを消して書き込みを始める
  const startWriting = async () => {
    if (cleared) return;
    await clearAll();
    cleared = true;
  };

  const flushAudio = async (force = false) => {
    if (!info || (!force && pendingAudio.length < AUDIO_BATCH) || !pendingAudio.length) return;
    await startWriting();
    const batch = pendingAudio.splice(0, pendingAudio.length);
    await putMany('audio', batch, (it) => it.key);
    audioSaved += batch.length;
    report('audio', audioSaved, info.counts.audio, `音声を保存しています… ${audioSaved} / ${info.counts.audio}`);
  };

  const handleReady = async () => {
    while (ready.length) {
      const { name, chunks } = ready.shift();
      if (name.endsWith('/')) continue; // フォルダ
      if (name === 'pack.json') {
        info = parseJSON(name, chunks);
        validatePackInfo(info);
        report('data', 0, 1, `「${info.title || 'データパック'}」を取り込んでいます…`);
      } else if (name === 'sentences.json') {
        sentences = parseJSON(name, chunks);
      } else if (name === 'words.json') {
        words = parseJSON(name, chunks);
      } else if (name.startsWith('audio/') && name.toLowerCase().endsWith('.mp3')) {
        pendingAudio.push({ key: name.slice('audio/'.length), value: new Blob(chunks, { type: 'audio/mpeg' }) });
      }
      // それ以外のファイルは無視する
    }
    await flushAudio(false);
  };

  try {
    const reader = file.stream().getReader();
    let readBytes = 0;
    for (;;) {
      const { value, done: end } = await reader.read();
      if (value) {
        readBytes += value.length;
        try { unzip.push(value, false); } catch (e) {
          throw new PackError('zip ファイルが壊れているようです。PC で作り直すか、もう一度コピーしてください。', 'broken');
        }
        if (unzipError) throw new PackError('zip ファイルの展開に失敗しました。PC で作り直してください。', 'broken');
        if (!info) report('read', readBytes, file.size, 'ファイルを読み込んでいます…');
        await handleReady();
      }
      if (end) {
        try { unzip.push(new Uint8Array(0), true); } catch (e) {
          throw new PackError('zip ファイルが途中で切れているようです。もう一度コピーしてください。', 'broken');
        }
        await handleReady();
        break;
      }
    }

    if (!info) throw new PackError('このファイルには pack.json がありません。「英単語マスター」のデータパックを選んでください。');
    if (!Array.isArray(sentences) || !Array.isArray(words)) {
      throw new PackError('データパックに例文または単語のデータがありません。PC で作り直してください。', 'broken');
    }
    await flushAudio(true);
    validateCounts(info, { sentences: sentences.length, words: words.length, audio: audioSaved });

    report('data', 0, 1, '例文と単語を保存しています…');
    await startWriting();
    await putMany('sentences', sentences);
    await putMany('words', words);
    const saved = { ...info, importedAt: new Date().toISOString() };
    // 最後に pack を書く（これで取り込み完了）
    const db = await openDB();
    const tx = db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put(saved, 'pack');
    await done(tx);
    report('done', 1, 1, '取り込みが終わりました。');
    return saved;
  } catch (e) {
    if (cleared) { try { await clearAll(); } catch { /* 片付けの失敗は無視 */ } }
    if (e instanceof PackError) throw e;
    if (isQuotaError(e)) {
      throw new PackError('端末の保存容量が足りなくなりました。空き容量を増やしてから、もう一度試してください。', 'quota');
    }
    throw new PackError(`取り込み中に問題が起きました（${e && e.message ? e.message : e}）。もう一度試してください。`, 'unknown');
  }
}
