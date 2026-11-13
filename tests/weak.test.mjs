// weak.js の DOM を使わない部分のテスト（node --test tests/weak.test.mjs）
// データはすべて自作のダミー（教材の文章は使わない）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WEAK_KEY,
  OVERCOME_STREAK,
  isWeakRecord,
  pickWeakWords,
  countWeakWords,
  boxForFormat,
  buildWeakQueue,
  pushRetry,
  normalizeWeakSettings,
  loadWeakData,
  saveWeakData,
  applyWeakAnswer,
  isOvercome,
} from '../js/modes/weak.js';

function word(id, sid, extra = {}) {
  return { id, word: `dummy${id}`, pos: '名詞', meaning: `ダミー${id}`, form: `dummy${id}`, sentenceIds: [sid], verified: false, ...extra };
}

function rec(box, correct, wrong, extra = {}) {
  return { box, due: '2026-11-13', correct, wrong, last: '2026-11-12', first: '2026-11-01', mastered: false, ...extra };
}

function memoryStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    map: m,
  };
}

test('isWeakRecord：箱 0・wrong 2 以上・wrong > correct のどれかで苦手', () => {
  assert.equal(isWeakRecord(rec(0, 3, 0)), true);       // 箱 0
  assert.equal(isWeakRecord(rec(3, 5, 2)), true);       // wrong 2 以上
  assert.equal(isWeakRecord(rec(2, 0, 1)), true);       // wrong > correct
  assert.equal(isWeakRecord(rec(2, 1, 1)), false);      // どれにも当たらない
  assert.equal(isWeakRecord(rec(3, 4, 0)), false);
  assert.equal(isWeakRecord(rec(5, 1, 3, { mastered: true })), false); // mastered は除く
  assert.equal(isWeakRecord(undefined), false);
  assert.equal(isWeakRecord(null), false);
});

test('pickWeakWords：記録の無い語・mastered・苦手でない語は除く', () => {
  const words = [word('w1', 1), word('w2', 2), word('w3', 3), word('w4', 4)];
  const progress = {
    w1: rec(0, 0, 1),
    w2: rec(4, 6, 0),                         // 苦手でない
    w4: rec(5, 2, 4, { mastered: true }),     // mastered
  };                                          // w3 は記録なし
  assert.deepEqual(pickWeakWords(words, progress).map((w) => w.id), ['w1']);
});

test('pickWeakWords：wrong の多い順 → 箱の小さい順 → 代表の例文番号順', () => {
  const words = [
    word('a', 30), word('b', 10), word('c', 20, { sentenceIds: [5, 1] }),
    word('d', 40), word('e', 1), word('f', 2, { sentenceIds: [] }),
  ];
  const progress = {
    a: rec(0, 0, 1),
    b: rec(0, 0, 1),
    c: rec(1, 1, 2),
    d: rec(0, 2, 5),
    e: rec(3, 3, 2),
    f: rec(0, 0, 1),
  };
  // d(wrong5) → c(wrong2, 箱1) → e(wrong2, 箱3) → b(wrong1,箱0,例文10) → a(例文30) → f(例文なし)
  assert.deepEqual(pickWeakWords(words, progress).map((w) => w.id), ['d', 'c', 'e', 'b', 'a', 'f']);
  assert.deepEqual(pickWeakWords(words, progress, { limit: 2 }).map((w) => w.id), ['d', 'c']);
  assert.equal(countWeakWords(words, progress), 6);
});

test('pickWeakWords：入力が空・不正でも落ちない', () => {
  assert.deepEqual(pickWeakWords(null, null), []);
  assert.deepEqual(pickWeakWords([word('w1', 1)], {}), []);
  assert.equal(countWeakWords([], {}), 0);
});

test('boxForFormat：形式を選んだらその形式の箱、auto は記録の箱', () => {
  assert.equal(boxForFormat('choice', rec(4, 0, 0)), 0);
  assert.equal(boxForFormat('cloze', rec(0, 0, 0)), 2);
  assert.equal(boxForFormat('spell', rec(0, 0, 0)), 4);
  assert.equal(boxForFormat('auto', rec(3, 0, 0)), 3);
  assert.equal(boxForFormat('auto', undefined), 0);
});

test('buildWeakQueue：出題数 10 / 20 / すべて', () => {
  const weak = Array.from({ length: 25 }, (_, i) => word(`w${i}`, i + 1));
  assert.equal(buildWeakQueue(weak, 10).length, 10);
  assert.equal(buildWeakQueue(weak, 20).length, 20);
  assert.equal(buildWeakQueue(weak, 'all').length, 25);
  assert.deepEqual(buildWeakQueue(weak, 10)[0], { id: 'w0', retry: false });
  assert.equal(buildWeakQueue(weak.slice(0, 3), 10).length, 3); // 苦手が少なければある分だけ
});

test('pushRetry：不正解の語は最後に 1 回だけ足す', () => {
  const queue = [{ id: 'a', retry: false }, { id: 'b', retry: false }];
  assert.equal(pushRetry(queue, queue[0], true), false);
  assert.equal(pushRetry(queue, queue[0], false), true);
  assert.deepEqual(queue[2], { id: 'a', retry: true });
  assert.equal(pushRetry(queue, queue[2], false), false); // もう一度の分では足さない
  assert.equal(queue.length, 3);
});

test('normalizeWeakSettings：不正な値は既定値', () => {
  assert.deepEqual(normalizeWeakSettings({ count: 20, format: 'spell' }), { count: 20, format: 'spell' });
  assert.deepEqual(normalizeWeakSettings({ count: 15, format: 'xxx' }), { count: 10, format: 'auto' });
  assert.deepEqual(normalizeWeakSettings(null), { count: 10, format: 'auto' });
});

test('kk.weak.v1：保存して読み直せる', () => {
  const st = memoryStorage();
  let data = loadWeakData(st);
  assert.deepEqual(data.words, {});
  data = applyWeakAnswer(data, 'w1', true, '2026-11-13');
  data.settings = { count: 'all', format: 'cloze' };
  assert.equal(saveWeakData(data, st), true);
  assert.ok(st.map.has(WEAK_KEY));
  const back = loadWeakData(st);
  assert.deepEqual(back.words.w1, { correct: 1, wrong: 0, streak: 1, last: '2026-11-13' });
  assert.deepEqual(back.settings, { count: 'all', format: 'cloze' });
});

test('kk.weak.v1：壊れたデータ・使えない環境でも落ちない', () => {
  assert.deepEqual(loadWeakData(memoryStorage({ [WEAK_KEY]: '{壊れた' })).words, {});
  assert.deepEqual(loadWeakData(null).words, {});
  const throwing = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); } };
  assert.deepEqual(loadWeakData(throwing).words, {});
  assert.equal(saveWeakData({}, throwing), false);
  assert.equal(saveWeakData({}, null), false);
  // 一部の項目だけ壊れていても、読める項目は残す
  const st = memoryStorage({ [WEAK_KEY]: JSON.stringify({ words: { ok: { correct: 2, wrong: 1, streak: 2 }, bad: 5 } }) });
  const d = loadWeakData(st);
  assert.deepEqual(Object.keys(d.words), ['ok']);
  assert.equal(d.words.ok.streak, 2);
});

test('applyWeakAnswer：元のデータを変えずに回数と連続正解を数える', () => {
  const d0 = loadWeakData(memoryStorage());
  const d1 = applyWeakAnswer(d0, 'w1', false, '2026-11-13');
  assert.deepEqual(d0.words, {});
  assert.deepEqual(d1.words.w1, { correct: 0, wrong: 1, streak: 0, last: '2026-11-13' });
  const d2 = applyWeakAnswer(applyWeakAnswer(d1, 'w1', true, '2026-11-13'), 'w1', true, '2026-11-14');
  assert.equal(d2.words.w1.streak, 2);
  const d3 = applyWeakAnswer(d2, 'w1', false, '2026-11-14');
  assert.equal(d3.words.w1.streak, 0);
  assert.equal(d3.words.w1.wrong, 2);
  assert.equal(d3.words.w1.correct, 2);
});

test('isOvercome：3 回続けて正解で「克服」、途中でまちがえたらやり直し', () => {
  assert.equal(OVERCOME_STREAK, 3);
  let d = loadWeakData(memoryStorage());
  for (const c of [true, true, false, true, true]) d = applyWeakAnswer(d, 'w1', c, '2026-11-13');
  assert.equal(isOvercome(d.words.w1), false);
  d = applyWeakAnswer(d, 'w1', true, '2026-11-13');
  assert.equal(isOvercome(d.words.w1), true);
  assert.equal(isOvercome(undefined), false);
});
