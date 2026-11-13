// store.js の単体テスト（node --test tests/store.test.mjs）
// localStorage の代わりに Map を使った代役を setStorage で差し込む。データはすべて自作のダミー。

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setStorage,
  isAvailable,
  loadProgress,
  getRecord,
  saveRecord,
  loadSettings,
  saveSettings,
  logAnswer,
  dayLog,
  streak,
  exportAll,
  importAll,
} from '../js/store.js';

// Map を使った localStorage の代役
class MemoryStorage {
  constructor() {
    this.map = new Map();
  }
  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }
  setItem(k, v) {
    this.map.set(k, String(v));
  }
  removeItem(k) {
    this.map.delete(k);
  }
  keys() {
    return [...this.map.keys()];
  }
}

// setItem が必ず失敗する代役（容量不足のまね）
class QuotaStorage extends MemoryStorage {
  setItem() {
    const e = new Error('quota exceeded');
    e.name = 'QuotaExceededError';
    throw e;
  }
}

// 指定したキーの setItem だけ失敗する代役
class FailOnKeyStorage extends MemoryStorage {
  constructor(failKey) {
    super();
    this.failKey = failKey;
  }
  setItem(k, v) {
    if (k === this.failKey) throw new Error('write failed');
    super.setItem(k, v);
  }
}

const recA = { box: 2, due: '2026-11-16', correct: 3, wrong: 1, last: '2026-11-13', first: '2026-11-01', mastered: false };
const recB = { box: 0, due: '2026-11-13', correct: 0, wrong: 1, last: '2026-11-13' };

let mem;
beforeEach(() => {
  mem = new MemoryStorage();
  setStorage(mem);
});

// 指定日に answered 件ぶん答えたことにする
function study(dateStr, n = 1) {
  for (let i = 0; i < n; i++) logAnswer(dateStr, { correct: true, isNew: false });
}

// ---------------------------------------------------------------- 何もない状態

test('何もない状態：各関数が空・既定値を返す', () => {
  assert.deepEqual(loadProgress(), {});
  assert.equal(getRecord('w0001'), undefined);
  assert.deepEqual(loadSettings(), { newPerDay: 10, dailyGoal: 20 });
  assert.deepEqual(dayLog('2026-11-13'), { answered: 0, correct: 0, newWords: 0 });
  assert.equal(streak('2026-11-13'), 0);
  const exp = JSON.parse(exportAll());
  assert.equal(exp.app, 'kk');
  assert.equal(exp.version, 1);
  assert.equal(typeof exp.exportedAt, 'string');
  assert.deepEqual(exp.progress, {});
  assert.deepEqual(exp.settings, { newPerDay: 10, dailyGoal: 20 });
  assert.deepEqual(exp.log, {});
  // 読むだけでは何も書き込まない
  assert.deepEqual(mem.keys(), []);
});

test('isAvailable：使える代役では true、setItem が失敗する代役では false', () => {
  assert.equal(isAvailable(), true);
  assert.deepEqual(mem.keys(), [], '確認用のキーが残らない');
  setStorage(new QuotaStorage());
  assert.equal(isAvailable(), false);
});

// ---------------------------------------------------------------- 学習記録

test('saveRecord → getRecord / loadProgress', () => {
  saveRecord('w0001', recA);
  saveRecord('w0002', recB);
  assert.deepEqual(getRecord('w0001'), recA);
  assert.deepEqual(getRecord('w0002'), recB);
  assert.equal(getRecord('w9999'), undefined);
  assert.deepEqual(loadProgress(), { w0001: recA, w0002: recB });
  // 1 語ずつ即保存されている（localStorage の中身を直接確認）
  assert.deepEqual(JSON.parse(mem.getItem('kk.progress.v1')), { w0001: recA, w0002: recB });
});

test('saveRecord：同じ語を上書きできる', () => {
  saveRecord('w0001', recA);
  const updated = { ...recA, box: 3, correct: 4 };
  saveRecord('w0001', updated);
  assert.deepEqual(getRecord('w0001'), updated);
  assert.equal(Object.keys(loadProgress()).length, 1);
});

test('saveRecord：不正な引数は日本語の Error', () => {
  assert.throws(() => saveRecord('', recA), /単語の ID/);
  assert.throws(() => saveRecord('w0001', null), /記録の形/);
});

test('saveRecord：setItem が例外を投げると日本語の Error（元の例外は cause）', () => {
  setStorage(new QuotaStorage());
  assert.throws(
    () => saveRecord('w0001', recA),
    (e) => {
      assert.ok(e instanceof Error);
      assert.match(e.message, /学習記録を保存できませんでした/);
      assert.match(e.message, /容量/);
      assert.equal(e.cause?.name, 'QuotaExceededError');
      return true;
    },
  );
});

// ---------------------------------------------------------------- 設定

test('設定：既定値で補う', () => {
  mem.setItem('kk.settings.v1', JSON.stringify({ newPerDay: 15 }));
  assert.deepEqual(loadSettings(), { newPerDay: 15, dailyGoal: 20 });
  mem.setItem('kk.settings.v1', JSON.stringify({ dailyGoal: 30, extra: 'x' }));
  assert.deepEqual(loadSettings(), { newPerDay: 10, dailyGoal: 30 });
  mem.setItem('kk.settings.v1', JSON.stringify({ newPerDay: 'abc', dailyGoal: null }));
  assert.deepEqual(loadSettings(), { newPerDay: 10, dailyGoal: 20 });
});

test('設定：newPerDay を 5〜20 に収める', () => {
  saveSettings({ newPerDay: 3 });
  assert.equal(loadSettings().newPerDay, 5);
  saveSettings({ newPerDay: 50 });
  assert.equal(loadSettings().newPerDay, 20);
  saveSettings({ newPerDay: 12.4 });
  assert.equal(loadSettings().newPerDay, 12);
  // 保存した値そのものが補正済み
  assert.deepEqual(JSON.parse(mem.getItem('kk.settings.v1')), { newPerDay: 12, dailyGoal: 20 });
  // 直接書かれた範囲外の値も読み込み時に補正する
  mem.setItem('kk.settings.v1', JSON.stringify({ newPerDay: 0, dailyGoal: 20 }));
  assert.equal(loadSettings().newPerDay, 5);
});

test('設定：saveSettings は一部だけ書き換える', () => {
  saveSettings({ dailyGoal: 40 });
  saveSettings({ newPerDay: 8 });
  assert.deepEqual(loadSettings(), { newPerDay: 8, dailyGoal: 40 });
});

// ---------------------------------------------------------------- 1 日のログ

test('logAnswer と dayLog：answered / correct / newWords の数え方', () => {
  logAnswer('2026-11-13', { correct: true, isNew: true });
  logAnswer('2026-11-13', { correct: false, isNew: true });
  logAnswer('2026-11-13', { correct: true, isNew: false });
  logAnswer('2026-11-13', { correct: false, isNew: false });
  assert.deepEqual(dayLog('2026-11-13'), { answered: 4, correct: 2, newWords: 2 });
  // 別の日は別に数える
  logAnswer('2026-11-14', { correct: true, isNew: false });
  assert.deepEqual(dayLog('2026-11-14'), { answered: 1, correct: 1, newWords: 0 });
  assert.deepEqual(dayLog('2026-11-13'), { answered: 4, correct: 2, newWords: 2 });
  assert.deepEqual(dayLog('2026-11-15'), { answered: 0, correct: 0, newWords: 0 });
});

test('logAnswer：日付の形が不正なら日本語の Error', () => {
  assert.throws(() => logAnswer('2026/11/13', { correct: true, isNew: false }), /日付/);
  assert.throws(() => logAnswer('2026-02-30', { correct: true, isNew: false }), /日付/);
});

// ---------------------------------------------------------------- streak

test('streak：今日だけ', () => {
  study('2026-11-13');
  assert.equal(streak('2026-11-13'), 1);
});

test('streak：昨日まで連続で、今日はまだ', () => {
  study('2026-11-10');
  study('2026-11-11');
  study('2026-11-12');
  assert.equal(streak('2026-11-13'), 3);
  // 今日も答えると 1 つ増える
  study('2026-11-13');
  assert.equal(streak('2026-11-13'), 4);
});

test('streak：途中で途切れる', () => {
  study('2026-11-09');
  study('2026-11-10');
  // 11-11 は休み
  study('2026-11-12');
  study('2026-11-13');
  assert.equal(streak('2026-11-13'), 2);
  // answered 0 の日もログがあっても途切れとみなす
  mem.setItem(
    'kk.log.v1',
    JSON.stringify({
      '2026-11-11': { answered: 2, correct: 1, newWords: 0 },
      '2026-11-12': { answered: 0, correct: 0, newWords: 0 },
      '2026-11-13': { answered: 1, correct: 1, newWords: 0 },
    }),
  );
  assert.equal(streak('2026-11-13'), 1);
});

test('streak：昨日も今日も答えていなければ 0', () => {
  study('2026-11-11');
  assert.equal(streak('2026-11-13'), 0);
});

test('streak：月をまたぐ（30 日・31 日の月、2 月）', () => {
  study('2026-10-30');
  study('2026-10-31');
  study('2026-11-01');
  assert.equal(streak('2026-11-01'), 3);
  assert.equal(streak('2026-11-02'), 3, '今日まだ → 昨日（月初）から数える');

  study('2026-09-30');
  study('2026-10-01');
  assert.equal(streak('2026-10-01'), 2);

  study('2027-02-28');
  study('2027-03-01');
  assert.equal(streak('2027-03-01'), 2, '平年の 2 月末');

  study('2028-02-28');
  study('2028-02-29');
  study('2028-03-01');
  assert.equal(streak('2028-03-01'), 3, 'うるう年の 2 月末');
});

test('streak：年をまたぐ', () => {
  study('2026-12-30');
  study('2026-12-31');
  study('2027-01-01');
  assert.equal(streak('2027-01-01'), 3);
  assert.equal(streak('2027-01-02'), 3);
});

// ---------------------------------------------------------------- 壊れた JSON

function brokenKeys(key) {
  return mem.keys().filter((k) => k.startsWith(`kk.broken.${key}.`));
}

test('壊れた JSON：落ちずに空として扱い、元の値を退避する（progress）', () => {
  const raw = '{"w0001": {"box": 2,';
  mem.setItem('kk.progress.v1', raw);
  assert.deepEqual(loadProgress(), {});
  const bk = brokenKeys('kk.progress.v1');
  assert.equal(bk.length, 1);
  assert.equal(mem.getItem(bk[0]), raw, '元の文字列がそのまま残る');
  assert.match(bk[0], /^kk\.broken\.kk\.progress\.v1\.\d{4}-\d{2}-\d{2}T/);
  assert.equal(mem.getItem('kk.progress.v1'), null, '元のキーは消える');
  // その後は普通に保存できる
  saveRecord('w0001', recA);
  assert.deepEqual(getRecord('w0001'), recA);
  assert.equal(brokenKeys('kk.progress.v1').length, 1, '二重に退避しない');
});

test('壊れた JSON：settings と log も落ちない', () => {
  mem.setItem('kk.settings.v1', 'not json');
  mem.setItem('kk.log.v1', '[1,2,3]'); // JSON だが形が違う
  assert.deepEqual(loadSettings(), { newPerDay: 10, dailyGoal: 20 });
  assert.deepEqual(dayLog('2026-11-13'), { answered: 0, correct: 0, newWords: 0 });
  assert.equal(streak('2026-11-13'), 0);
  assert.equal(brokenKeys('kk.settings.v1').length, 1);
  assert.equal(brokenKeys('kk.log.v1').length, 1);
  assert.equal(mem.getItem(brokenKeys('kk.log.v1')[0]), '[1,2,3]');
  // 壊れた状態から書き込みも続けられる
  logAnswer('2026-11-13', { correct: true, isNew: true });
  assert.deepEqual(dayLog('2026-11-13'), { answered: 1, correct: 1, newWords: 1 });
});

test('壊れた JSON：progress が配列や null でも空として扱う', () => {
  mem.setItem('kk.progress.v1', 'null');
  assert.deepEqual(loadProgress(), {});
  mem.setItem('kk.progress.v1', '["w0001"]');
  assert.equal(getRecord('w0001'), undefined);
  assert.equal(brokenKeys('kk.progress.v1').length, 2);
});

test('壊れた JSON：退避できないときは元のキーを消さない', () => {
  const qs = new QuotaStorage();
  qs.map.set('kk.progress.v1', '{broken');
  setStorage(qs);
  assert.deepEqual(loadProgress(), {});
  assert.equal(qs.getItem('kk.progress.v1'), '{broken');
});

// ---------------------------------------------------------------- export / import

function seed() {
  saveRecord('w0001', recA);
  saveRecord('w0002', recB);
  saveSettings({ newPerDay: 7, dailyGoal: 25 });
  logAnswer('2026-11-12', { correct: true, isNew: true });
  logAnswer('2026-11-13', { correct: false, isNew: false });
}

function snapshot(storage) {
  return {
    progress: storage.getItem('kk.progress.v1'),
    settings: storage.getItem('kk.settings.v1'),
    log: storage.getItem('kk.log.v1'),
  };
}

test('exportAll → importAll で元に戻る', () => {
  seed();
  const json = exportAll();
  const before = { progress: loadProgress(), settings: loadSettings(), log: JSON.parse(json).log };

  // 別の空の端末に取り込む
  const other = new MemoryStorage();
  setStorage(other);
  importAll(json);
  assert.deepEqual(loadProgress(), before.progress);
  assert.deepEqual(loadSettings(), before.settings);
  assert.deepEqual(dayLog('2026-11-12'), { answered: 1, correct: 1, newWords: 1 });
  assert.deepEqual(dayLog('2026-11-13'), { answered: 1, correct: 0, newWords: 0 });
  assert.equal(streak('2026-11-13'), 2);

  // 同じ端末で、変更後に取り込むと置き換わる
  setStorage(mem);
  saveRecord('w0003', recB);
  importAll(json);
  assert.deepEqual(loadProgress(), before.progress);
});

test('importAll：不正な JSON は拒否し、既存データは変わらない', () => {
  seed();
  const before = snapshot(mem);
  const good = JSON.parse(exportAll());
  const bad = [
    ['JSON でない', '{oops'],
    ['配列', '[]'],
    ['app が違う', JSON.stringify({ ...good, app: 'other' })],
    ['version が違う', JSON.stringify({ ...good, version: 2 })],
    ['progress が無い', JSON.stringify({ ...good, progress: undefined })],
    ['progress が配列', JSON.stringify({ ...good, progress: [] })],
    ['box が範囲外', JSON.stringify({ ...good, progress: { w0001: { ...recA, box: 6 } } })],
    ['due が日付でない', JSON.stringify({ ...good, progress: { w0001: { ...recA, due: 'tomorrow' } } })],
    ['correct が負', JSON.stringify({ ...good, progress: { w0001: { ...recA, correct: -1 } } })],
    ['mastered が文字列', JSON.stringify({ ...good, progress: { w0001: { ...recA, mastered: 'yes' } } })],
    ['settings が無い', JSON.stringify({ ...good, settings: undefined })],
    ['settings の値が文字列', JSON.stringify({ ...good, settings: { newPerDay: '10' } })],
    ['log が無い', JSON.stringify({ ...good, log: undefined })],
    ['log の日付キーが不正', JSON.stringify({ ...good, log: { '11/13': { answered: 1, correct: 1, newWords: 0 } } })],
    ['log の数が不正', JSON.stringify({ ...good, log: { '2026-11-13': { answered: 1.5, correct: 1, newWords: 0 } } })],
  ];
  for (const [name, json] of bad) {
    assert.throws(
      () => importAll(json),
      (e) => e instanceof Error && /バックアップを読み込めませんでした/.test(e.message),
      name,
    );
    assert.deepEqual(snapshot(mem), before, `${name}：既存データが変わらない`);
  }
  assert.throws(() => importAll(undefined), /バックアップを読み込めませんでした/);
});

test('importAll：書き込みの途中で失敗したら元に戻す', () => {
  const fs = new FailOnKeyStorage('kk.log.v1');
  setStorage(fs);
  saveRecord('w0001', recA);
  saveSettings({ newPerDay: 6 });
  const before = snapshot(fs);

  const json = JSON.stringify({
    app: 'kk',
    version: 1,
    exportedAt: '2026-11-13T00:00:00.000Z',
    progress: { w0002: recB },
    settings: { newPerDay: 15, dailyGoal: 30 },
    log: { '2026-11-13': { answered: 1, correct: 1, newWords: 1 } },
  });
  assert.throws(() => importAll(json), /バックアップを読み込めませんでした/);
  assert.deepEqual(snapshot(fs), before);
});

test('importAll：settings の範囲外の値は補正して取り込む', () => {
  importAll(
    JSON.stringify({
      app: 'kk',
      version: 1,
      exportedAt: '2026-11-13T00:00:00.000Z',
      progress: {},
      settings: { newPerDay: 100 },
      log: {},
    }),
  );
  assert.deepEqual(loadSettings(), { newPerDay: 20, dailyGoal: 20 });
});
