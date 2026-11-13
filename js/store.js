// store.js — localStorage の学習記録（js/API.md「js/store.js」の取り決めどおり）
//
// 保存するキー
//   'kk.progress.v1' { "<wordId>": { box, due, correct, wrong, last, first, mastered } }
//   'kk.settings.v1' { newPerDay, dailyGoal }
//   'kk.log.v1'      { "YYYY-MM-DD": { answered, correct, newWords } }
//
// 取り決めで決まっていなかった点の決め方
//  1. 保存先：既定は globalThis.localStorage。参照は使うときに毎回行う（読み込み時には触らない）。
//     setStorage(null) で既定（globalThis.localStorage）に戻す。
//  2. キャッシュは持たない。毎回 localStorage から読み直す（別タブや importAll の変更をすぐ反映するため）。
//  3. 読み込みの失敗：保存先が無い・getItem が例外を投げるときは「空」として扱う（ホーム画面を出せるように）。
//     書き込みの失敗：握りつぶさず、日本語メッセージ付きの Error を投げる（cause に元の例外）。
//     どちらの環境かは isAvailable() で事前に判定できる。
//  4. 壊れたデータ：JSON として読めない、または形が違う（progress / log / settings がオブジェクトでない、
//     log の日付キーや数値が不正など）ときは、元の文字列を 'kk.broken.<キー>.<日時>' に退避し、
//     元のキーを消してから空として続ける。<日時> は ISO 8601（UTC、例 2026-11-13T09:30:00.000Z）。
//     同じ名前があるときは末尾に .2, .3 … を付ける。退避に失敗したときは元のキーを消さない（データを失わないため）。
//     progress の個々の記録の中身は検査しない（記録は srs.js が作るため）。
//  5. loadSettings：newPerDay は整数に丸めて 5〜20 に収める。dailyGoal は整数に丸めて 1〜200 に収める。
//     数値でない値は既定値（newPerDay 10 / dailyGoal 20）にする。未知のキーは捨てる。
//     saveSettings(partial) は現在の設定に partial を重ね、同じ補正をしてから保存する。
//  6. logAnswer：answered は毎回 +1、correct は正解のとき +1、newWords は isNew のとき +1。
//     日付が "YYYY-MM-DD" でなければ Error。古い日のログは削除しない（1 日 1 件で小さいため）。
//  7. streak：日付の計算はローカル日付の正午を基準に行う（夏時間の切り替えでも日付がずれないように）。
//     dateStr が不正なら 0。answered が 0 の日、またはログの無い日で途切れる。
//  8. exportAll：{ app: 'kk', version: 1, exportedAt, progress, settings, log } を改行なしの JSON で返す。
//     settings は補正後の値。退避したキー（kk.broken.*）は含めない。
//  9. importAll：既存データを「置き換え」る（マージしない）。progress / settings / log の 3 つとも必須。
//     progress の各記録は box（0〜5 の整数）、due・last（日付）、correct・wrong（0 以上の整数）が必須、
//     first（日付）・mastered（真偽値）は任意。log は日付キーで、answered / correct / newWords が 0 以上の整数。
//     settings はオブジェクトで、newPerDay / dailyGoal があれば数値（範囲は保存時に補正）。
//     検査に通らなければ何も書き込まずに Error。書き込みの途中で失敗したら元の値に戻してから Error。
//  10. 戻り値が決まっていない関数（setStorage / saveRecord / saveSettings / logAnswer / importAll）は何も返さない。

const KEY_PROGRESS = 'kk.progress.v1';
const KEY_SETTINGS = 'kk.settings.v1';
const KEY_LOG = 'kk.log.v1';
const KEY_TEST = 'kk.__test__';

const DEFAULT_SETTINGS = Object.freeze({ newPerDay: 10, dailyGoal: 20 });
const NEW_PER_DAY_MIN = 5;
const NEW_PER_DAY_MAX = 20;
const DAILY_GOAL_MIN = 1;
const DAILY_GOAL_MAX = 200;

// キーごとの日本語の名前（エラーメッセージ用）
const LABELS = {
  [KEY_PROGRESS]: '学習記録',
  [KEY_SETTINGS]: '設定',
  [KEY_LOG]: '学習ログ',
};

let customStorage = null;

// ---------------------------------------------------------------- 保存先

/** テスト用に localStorage の代わり（getItem / setItem / removeItem を持つもの）を差し込む。null で既定に戻す。 */
export function setStorage(storageLike) {
  customStorage = storageLike ?? null;
}

// 現在の保存先。使えなければ null（globalThis.localStorage の参照自体が例外を投げる環境もある）
function getStorage() {
  if (customStorage) return customStorage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** localStorage が読み書きできるか（プライベートブラウズなどで使えないと false） */
export function isAvailable() {
  const s = getStorage();
  if (!s) return false;
  try {
    s.setItem(KEY_TEST, '1');
    const ok = s.getItem(KEY_TEST) === '1';
    s.removeItem(KEY_TEST);
    return ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- 小さな道具

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isNonNegInt(v) {
  return Number.isInteger(v) && v >= 0;
}

// "YYYY-MM-DD" で、実在する日付か
function isDateStr(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = parseLocalDate(s);
  return formatLocalDate(d) === s;
}

// "YYYY-MM-DD" → ローカル日付の正午の Date（夏時間の切り替えで日付がずれないように正午にする）
function parseLocalDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0, 0);
}

function formatLocalDate(date) {
  const y = String(date.getFullYear()).padStart(4, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// n 日後（負なら前）のローカル日付。月末・年末・うるう年は Date の繰り上がりに任せる
function shiftDays(dateStr, n) {
  const d = parseLocalDate(dateStr);
  d.setDate(d.getDate() + n);
  return formatLocalDate(d);
}

function clampInt(v, min, max, fallback) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.round(v)));
}

function normalizeSettings(obj) {
  const src = isPlainObject(obj) ? obj : {};
  return {
    newPerDay: clampInt(src.newPerDay, NEW_PER_DAY_MIN, NEW_PER_DAY_MAX, DEFAULT_SETTINGS.newPerDay),
    dailyGoal: clampInt(src.dailyGoal, DAILY_GOAL_MIN, DAILY_GOAL_MAX, DEFAULT_SETTINGS.dailyGoal),
  };
}

// ---------------------------------------------------------------- 形の検査

function isValidRecord(rec) {
  if (!isPlainObject(rec)) return false;
  if (!(Number.isInteger(rec.box) && rec.box >= 0 && rec.box <= 5)) return false;
  if (!isDateStr(rec.due) || !isDateStr(rec.last)) return false;
  if (!isNonNegInt(rec.correct) || !isNonNegInt(rec.wrong)) return false;
  if (rec.first !== undefined && !isDateStr(rec.first)) return false;
  if (rec.mastered !== undefined && typeof rec.mastered !== 'boolean') return false;
  return true;
}

function isValidDayEntry(e) {
  return isPlainObject(e) && isNonNegInt(e.answered) && isNonNegInt(e.correct) && isNonNegInt(e.newWords);
}

function isValidLog(log) {
  if (!isPlainObject(log)) return false;
  return Object.entries(log).every(([k, v]) => isDateStr(k) && isValidDayEntry(v));
}

function isValidSettingsShape(s) {
  if (!isPlainObject(s)) return false;
  for (const k of ['newPerDay', 'dailyGoal']) {
    if (s[k] !== undefined && !(typeof s[k] === 'number' && Number.isFinite(s[k]))) return false;
  }
  return true;
}

// 読み込み時の検査（壊れていれば退避する基準）。progress は外側の形だけ見る
const READ_VALIDATORS = {
  [KEY_PROGRESS]: isPlainObject,
  [KEY_SETTINGS]: isPlainObject,
  [KEY_LOG]: isValidLog,
};

// ---------------------------------------------------------------- 読み書き

// 壊れた値を 'kk.broken.<キー>.<日時>' に退避し、元のキーを消す。退避できなければ元のキーは残す
function quarantine(s, key, raw) {
  const base = `kk.broken.${key}.${new Date().toISOString()}`;
  try {
    let name = base;
    for (let i = 2; s.getItem(name) !== null; i++) name = `${base}.${i}`;
    s.setItem(name, raw);
    s.removeItem(key);
  } catch {
    // 退避できない（容量不足など）。元の値を消さずにおき、今回は空として扱う
  }
}

// JSON を読む。無い・読めない・壊れている → null
function readJson(key) {
  const s = getStorage();
  if (!s) return null;
  let raw;
  try {
    raw = s.getItem(key);
  } catch {
    return null;
  }
  if (raw === null || raw === undefined) return null;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    quarantine(s, key, String(raw));
    return null;
  }
  if (!READ_VALIDATORS[key](value)) {
    quarantine(s, key, String(raw));
    return null;
  }
  return value;
}

function saveError(key, cause) {
  const label = LABELS[key] ?? 'データ';
  const isQuota =
    cause && (cause.name === 'QuotaExceededError' || cause.name === 'NS_ERROR_DOM_QUOTA_REACHED' || cause.code === 22);
  const reason = isQuota
    ? '端末の保存容量が足りません。不要なデータを消してから、もう一度ためしてください。'
    : 'ブラウザの設定（プライベートブラウズなど）で保存が止められている可能性があります。';
  return new Error(`${label}を保存できませんでした。${reason}`, { cause });
}

// JSON を書く。失敗したら日本語の Error を投げる
function writeJson(key, value) {
  const s = getStorage();
  if (!s) {
    throw new Error(
      `${LABELS[key] ?? 'データ'}を保存できませんでした。この端末（ブラウザ）では記録を保存できません。` +
        'プライベートブラウズを使っていないか確認してください。',
    );
  }
  try {
    s.setItem(key, JSON.stringify(value));
  } catch (e) {
    throw saveError(key, e);
  }
}

// ---------------------------------------------------------------- 学習記録

/** 全語の学習記録。無ければ {} */
export function loadProgress() {
  return readJson(KEY_PROGRESS) ?? {};
}

/** 1 語の学習記録。無ければ undefined */
export function getRecord(wordId) {
  const p = loadProgress();
  return Object.prototype.hasOwnProperty.call(p, wordId) ? p[wordId] : undefined;
}

/** 1 語ずつ即保存する。保存に失敗したら日本語メッセージ付きの Error */
export function saveRecord(wordId, rec) {
  if (typeof wordId !== 'string' || wordId === '') {
    throw new Error('学習記録を保存できませんでした。単語の ID が正しくありません。');
  }
  if (!isPlainObject(rec)) {
    throw new Error(`学習記録を保存できませんでした。単語 ${wordId} の記録の形が正しくありません。`);
  }
  const p = loadProgress();
  p[wordId] = { ...rec };
  writeJson(KEY_PROGRESS, p);
}

// ---------------------------------------------------------------- 設定

/** 設定。既定値で補い、範囲に収める */
export function loadSettings() {
  return normalizeSettings(readJson(KEY_SETTINGS));
}

/** 設定の一部を書き換えて保存する（補正してから保存） */
export function saveSettings(partial) {
  const merged = { ...loadSettings(), ...(isPlainObject(partial) ? partial : {}) };
  writeJson(KEY_SETTINGS, normalizeSettings(merged));
}

// ---------------------------------------------------------------- 1 日のログ

function loadLog() {
  return readJson(KEY_LOG) ?? {};
}

/** 1 問答えるごとに呼ぶ */
export function logAnswer(dateStr, { correct, isNew } = {}) {
  if (!isDateStr(dateStr)) {
    throw new Error(`学習ログを保存できませんでした。日付 "${dateStr}" の形が正しくありません（YYYY-MM-DD）。`);
  }
  const log = loadLog();
  const day = log[dateStr] ?? { answered: 0, correct: 0, newWords: 0 };
  log[dateStr] = {
    answered: day.answered + 1,
    correct: day.correct + (correct ? 1 : 0),
    newWords: day.newWords + (isNew ? 1 : 0),
  };
  writeJson(KEY_LOG, log);
}

/** その日の集計。無ければすべて 0 */
export function dayLog(dateStr) {
  const day = loadLog()[dateStr];
  if (!day) return { answered: 0, correct: 0, newWords: 0 };
  return { answered: day.answered, correct: day.correct, newWords: day.newWords };
}

/** 連続学習日数。今日 answered > 0 なら今日から、まだなら昨日から数える */
export function streak(dateStr) {
  if (!isDateStr(dateStr)) return 0;
  const log = loadLog();
  const studied = (d) => (log[d]?.answered ?? 0) > 0;
  let d = studied(dateStr) ? dateStr : shiftDays(dateStr, -1);
  let count = 0;
  while (studied(d)) {
    count++;
    d = shiftDays(d, -1);
  }
  return count;
}

// ---------------------------------------------------------------- バックアップ

/** 3 キーをまとめた JSON 文字列 */
export function exportAll() {
  return JSON.stringify({
    app: 'kk',
    version: 1,
    exportedAt: new Date().toISOString(),
    progress: loadProgress(),
    settings: loadSettings(),
    log: loadLog(),
  });
}

/** exportAll の JSON を検査してから書き戻す（置き換え）。不正なら何も書かずに Error */
export function importAll(jsonString) {
  const fail = (why) => new Error(`バックアップを読み込めませんでした。${why}`);

  if (typeof jsonString !== 'string') throw fail('文字列ではありません。');
  let data;
  try {
    data = JSON.parse(jsonString);
  } catch (e) {
    throw new Error('バックアップを読み込めませんでした。JSON として読めません（ファイルが壊れている可能性があります）。', {
      cause: e,
    });
  }
  if (!isPlainObject(data)) throw fail('形が正しくありません。');
  if (data.app !== 'kk') throw fail('このアプリのバックアップではありません。');
  if (data.version !== 1) throw fail(`対応していない版です（version: ${JSON.stringify(data.version)}）。`);

  if (!isPlainObject(data.progress)) throw fail('学習記録（progress）がありません。');
  for (const [id, rec] of Object.entries(data.progress)) {
    if (!isValidRecord(rec)) throw fail(`単語 ${id} の学習記録の形が正しくありません。`);
  }
  if (!isValidSettingsShape(data.settings)) throw fail('設定（settings）の形が正しくありません。');
  if (!isPlainObject(data.log)) throw fail('学習ログ（log）がありません。');
  for (const [day, entry] of Object.entries(data.log)) {
    if (!isDateStr(day)) throw fail(`学習ログの日付 "${day}" の形が正しくありません。`);
    if (!isValidDayEntry(entry)) throw fail(`${day} の学習ログの形が正しくありません。`);
  }

  // 書き込む前の値を覚えておき、途中で失敗したら戻す
  const s = getStorage();
  if (!s) throw fail('この端末（ブラウザ）では記録を保存できません。');
  const keys = [KEY_PROGRESS, KEY_SETTINGS, KEY_LOG];
  const before = {};
  try {
    for (const k of keys) before[k] = s.getItem(k);
  } catch (e) {
    throw new Error('バックアップを読み込めませんでした。今の記録を読み出せません。', { cause: e });
  }
  const values = {
    [KEY_PROGRESS]: data.progress,
    [KEY_SETTINGS]: normalizeSettings(data.settings),
    [KEY_LOG]: data.log,
  };
  try {
    for (const k of keys) writeJson(k, values[k]);
  } catch (e) {
    for (const k of keys) {
      try {
        if (before[k] === null) s.removeItem(k);
        else s.setItem(k, before[k]);
      } catch {
        // 戻せないときはこれ以上できることがない
      }
    }
    throw new Error(`バックアップを読み込めませんでした。${e.message}`, { cause: e });
  }
}
