// compose.js（瞬間英作文）の DOM を使わない部分のテスト（node --test tests/compose.test.mjs）
// データはすべて自作のダミー（教材の文章は使わない）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPOSE_KEY,
  DEFAULT_COMPOSE_SETTINGS,
  normalizeComposeSettings,
  normalizeRecords,
  applyGrade,
  loadComposeData,
  saveComposeData,
  isComposable,
  orderSentences,
  isLastMissed,
  buildQuestionList,
  wordsForSentence,
  boldRanges,
  splitByRanges,
  orderWordsBySentence,
  summarizeResults,
  formatElapsed,
} from '../js/modes/compose.js';

function dummy(id, seg = undefined, extra = {}) {
  return {
    id,
    file: `dummy_${String(id).padStart(4, '0')}.mp3`,
    en: `Dummy sentence ${id}.`,
    ja: `ダミー文 ${id}`,
    seg: seg === undefined ? { en1: [0.5, 2.5], ja: [3, 5], en2: [5.5, 7.5], en3: [8, 10] } : seg,
    ...extra,
  };
}
const SENTENCES = Array.from({ length: 120 }, (_, i) => dummy(i + 1));

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

// 決まった順の乱数
function seq(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

// ---------- 設定 ----------

test('normalizeComposeSettings：空・壊れた値は既定値（和訳は見せる）', () => {
  assert.deepEqual(normalizeComposeSettings(null), { ...DEFAULT_COMPOSE_SETTINGS });
  assert.equal(DEFAULT_COMPOSE_SETTINGS.showJa, true);
  const s = normalizeComposeSettings({ rangeKind: 'x', stage: -1, from: 'a', order: 'zzz', showJa: 'no', onlyMissed: 1 });
  assert.equal(s.rangeKind, 'stage');
  assert.equal(s.stage, 1);
  assert.equal(s.from, 1);
  assert.equal(s.order, 'number');
  assert.equal(s.showJa, true);
  assert.equal(s.onlyMissed, false);
});

test('normalizeComposeSettings：正しい値は残す。から〜までが逆なら入れ替え、例文に合わせて寄せる', () => {
  const s = normalizeComposeSettings({ rangeKind: 'ids', from: 200, to: 30, order: 'random', showJa: false, onlyMissed: true }, SENTENCES);
  assert.equal(s.rangeKind, 'ids');
  assert.equal(s.from, 30);
  assert.equal(s.to, 120);
  assert.equal(s.order, 'random');
  assert.equal(s.showJa, false);
  assert.equal(s.onlyMissed, true);
  // ないステージは最初のステージに
  assert.equal(normalizeComposeSettings({ stage: 9 }, SENTENCES).stage, 1);
});

// ---------- 記録 ----------

test('applyGrade：初めての文は count 1、同じ文は count が増え last と date が変わる。元は変えない', () => {
  const r0 = {};
  const r1 = applyGrade(r0, 5, 'ng', '2026-11-13');
  assert.deepEqual(r0, {});
  assert.deepEqual(r1, { 5: { last: 'ng', date: '2026-11-13', count: 1 } });
  const r2 = applyGrade(r1, 5, 'ok', '2026-11-14');
  assert.deepEqual(r2['5'], { last: 'ok', date: '2026-11-14', count: 2 });
  assert.deepEqual(r1['5'], { last: 'ng', date: '2026-11-13', count: 1 });
});

test('applyGrade：不正な採点・番号は無視する', () => {
  const r = applyGrade({}, 3, 'good', '2026-11-13');
  assert.deepEqual(r, {});
  assert.deepEqual(applyGrade({}, 0, 'ok', '2026-11-13'), {});
  assert.deepEqual(applyGrade({}, 1.5, 'ok', '2026-11-13'), {});
});

test('normalizeRecords：壊れた記録・不正な番号は捨て、count の欠けは 1 で補う', () => {
  const r = normalizeRecords({
    1: { last: 'ok', date: '2026-11-13', count: 3 },
    2: { last: 'bad', date: '2026-11-13', count: 1 },
    x: { last: 'ok', date: '2026-11-13', count: 1 },
    3: { last: 'partial' },
    4: 'ng',
  });
  assert.deepEqual(r, {
    1: { last: 'ok', date: '2026-11-13', count: 3 },
    3: { last: 'partial', date: '', count: 1 },
  });
  assert.deepEqual(normalizeRecords([1, 2]), {});
});

test('loadComposeData / saveComposeData：保存したものを読み戻せる。キーは kk.compose.v1', () => {
  const st = new MemoryStorage();
  const records = applyGrade({}, 7, 'partial', '2026-11-13');
  const settings = { ...DEFAULT_COMPOSE_SETTINGS, order: 'random', showJa: false };
  assert.equal(saveComposeData({ settings, records }, st), true);
  assert.ok(st.getItem(COMPOSE_KEY));
  assert.equal(COMPOSE_KEY, 'kk.compose.v1');
  const back = loadComposeData(st);
  assert.deepEqual(back.records, records);
  assert.equal(back.settings.order, 'random');
  assert.equal(back.settings.showJa, false);
});

test('loadComposeData：無い・壊れた JSON・使えない環境では既定値と空の記録', () => {
  const empty = { settings: { ...DEFAULT_COMPOSE_SETTINGS }, records: {} };
  assert.deepEqual(loadComposeData(new MemoryStorage()), empty);
  const broken = new MemoryStorage();
  broken.setItem(COMPOSE_KEY, '{oops');
  assert.deepEqual(loadComposeData(broken), empty);
  assert.deepEqual(loadComposeData(null), empty);
  const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.deepEqual(loadComposeData(throwing), empty);
  assert.equal(saveComposeData({ settings: {}, records: {} }, throwing), false);
  assert.equal(saveComposeData({ settings: {}, records: {} }, null), false);
});

// ---------- 範囲・出題順 ----------

test('isComposable：ファイルと seg.ja・seg.en1 の両方が正しい文だけ', () => {
  assert.equal(isComposable(dummy(1)), true);
  assert.equal(isComposable(dummy(2, { en1: [0.5, 2.5] })), false);
  assert.equal(isComposable(dummy(3, { ja: [3, 5] })), false);
  assert.equal(isComposable(dummy(4, { en1: [2, 1], ja: [3, 5] })), false);
  assert.equal(isComposable({ ...dummy(5), file: '' }), false);
  assert.equal(isComposable(dummy(6, null)), false);
  assert.equal(isComposable(null), false);
});

test('orderSentences：番号順は id の小さい順。ランダムは並べ替えるが同じ文がそろう。元は変えない', () => {
  const list = [dummy(3), dummy(1), dummy(2)];
  assert.deepEqual(orderSentences(list, 'number').map((s) => s.id), [1, 2, 3]);
  assert.deepEqual(list.map((s) => s.id), [3, 1, 2]);
  const r = orderSentences(SENTENCES.slice(0, 10), 'random', seq([0.1, 0.9, 0.5, 0.3, 0.7]));
  assert.deepEqual([...r.map((s) => s.id)].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.notDeepEqual(r.map((s) => s.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  // 1 以上を返す乱数でも範囲を超えない
  const r2 = orderSentences(SENTENCES.slice(0, 5), 'random', () => 1);
  assert.equal(r2.length, 5);
  assert.ok(r2.every(Boolean));
});

test('buildQuestionList：ステージの範囲、区切りのない文は飛ばして数える', () => {
  const sents = [...SENTENCES];
  sents[9] = dummy(10, { en1: [0.5, 2.5] }); // seg.ja なし
  const b = buildQuestionList(sents, { rangeKind: 'stage', stage: 1 }, {});
  assert.equal(b.inRange, 50);
  assert.equal(b.skipped, 1);
  assert.equal(b.list.length, 49);
  assert.equal(b.list[0].id, 1);
  assert.ok(!b.list.some((s) => s.id === 10));
});

test('buildQuestionList：番号で選ぶ、ランダム順', () => {
  const b = buildQuestionList(SENTENCES, { rangeKind: 'ids', from: 61, to: 65, order: 'random' }, {}, seq([0.0]));
  assert.deepEqual([...b.list.map((s) => s.id)].sort((x, y) => x - y), [61, 62, 63, 64, 65]);
  assert.equal(b.inRange, 5);
});

test('buildQuestionList：前回 × だった文だけ', () => {
  let rec = {};
  rec = applyGrade(rec, 2, 'ng', '2026-11-12');
  rec = applyGrade(rec, 3, 'partial', '2026-11-12');
  rec = applyGrade(rec, 4, 'ng', '2026-11-12');
  rec = applyGrade(rec, 4, 'ok', '2026-11-13'); // 最後は ○
  rec = applyGrade(rec, 70, 'ng', '2026-11-13'); // 範囲外
  assert.equal(isLastMissed(rec, 2), true);
  assert.equal(isLastMissed(rec, 4), false);
  const all = buildQuestionList(SENTENCES, { rangeKind: 'stage', stage: 1 }, rec);
  assert.equal(all.list.length, 50);
  assert.equal(all.missedInRange, 1);
  const only = buildQuestionList(SENTENCES, { rangeKind: 'stage', stage: 1, onlyMissed: true }, rec);
  assert.deepEqual(only.list.map((s) => s.id), [2]);
});

// ---------- 見出し語の太字 ----------

const WORDS = [
  { id: 'w1', word: 'apple', form: 'apples', meaning: 'りんご', sentenceIds: [1], verified: true },
  { id: 'w2', word: 'eat', form: 'eat', meaning: '食べる', sentenceIds: [1, 5], verified: false },
  { id: 'w3', word: 'red', form: 'red', meaning: '赤い', sentenceIds: [5, 1] },        // 1 は代表でない
  { id: 'w4', word: 'look for ...', form: 'look for', meaning: '～を探す', sentenceIds: [2] },
  { id: 'w5', word: 'look', form: 'look', meaning: '見る', sentenceIds: [2] },
  { id: 'w6', word: 'zebra', form: 'zebras', meaning: 'しまうま', sentenceIds: [1] }, // 文に出てこない
];

test('wordsForSentence：その文が代表の例文（sentenceIds[0]）になっている語だけ', () => {
  assert.deepEqual(wordsForSentence(WORDS, 1).map((w) => w.id), ['w1', 'w2', 'w6']);
  assert.deepEqual(wordsForSentence(WORDS, 5).map((w) => w.id), ['w3']);
  assert.deepEqual(wordsForSentence(null, 1), []);
});

test('boldRanges：見出し語の位置。見つからない語は含めない', () => {
  const en = 'We eat red apples every day.';
  const r = boldRanges(en, wordsForSentence(WORDS, 1));
  assert.deepEqual(r.map(({ start, end }) => en.slice(start, end)), ['eat', 'apples']);
  assert.deepEqual(r[0].wordIds, ['w2']);
});

test('boldRanges：重なる範囲（熟語とその中の語）は 1 つにまとめる。文頭の大文字も見つける', () => {
  const en = 'Look for the dummy key.';
  const r = boldRanges(en, wordsForSentence(WORDS, 2));
  assert.equal(r.length, 1);
  assert.equal(en.slice(r[0].start, r[0].end), 'Look for');
  assert.deepEqual(r[0].wordIds.sort(), ['w4', 'w5']);
});

test('boldRanges：form が空なら word で探す。英文が空なら空', () => {
  const en = 'A small dummy test.';
  const r = boldRanges(en, [{ id: 'x', word: 'small', form: '' }]);
  assert.equal(en.slice(r[0].start, r[0].end), 'small');
  assert.deepEqual(boldRanges('', WORDS), []);
  assert.deepEqual(boldRanges(null, WORDS), []);
});

test('splitByRanges：太字の部分とそれ以外に分ける（つなげると元の文）', () => {
  const en = 'We eat red apples every day.';
  const parts = splitByRanges(en, boldRanges(en, wordsForSentence(WORDS, 1)));
  assert.deepEqual(parts, [
    { text: 'We ', bold: false },
    { text: 'eat', bold: true },
    { text: ' red ', bold: false },
    { text: 'apples', bold: true },
    { text: ' every day.', bold: false },
  ]);
  assert.equal(parts.map((p) => p.text).join(''), en);
  assert.deepEqual(splitByRanges('abc', []), [{ text: 'abc', bold: false }]);
  assert.deepEqual(splitByRanges('abc', [{ start: 0, end: 3 }]), [{ text: 'abc', bold: true }]);
});

test('orderWordsBySentence：英文に出てくる順、見つからない語は最後', () => {
  const en = 'We eat red apples every day.';
  const list = [WORDS[5], WORDS[0], WORDS[1]];
  assert.deepEqual(orderWordsBySentence(en, list).map((w) => w.id), ['w2', 'w1', 'w6']);
});

// ---------- 結果 ----------

test('summarizeResults：○△× の数と、× と △ の文（出した順）', () => {
  const sum = summarizeResults([
    { id: 3, grade: 'ok' },
    { id: 1, grade: 'ng' },
    { id: 7, grade: 'partial' },
    { id: 2, grade: 'ok' },
    { id: 9, grade: 'bad' },
  ]);
  assert.equal(sum.ok, 2);
  assert.equal(sum.partial, 1);
  assert.equal(sum.ng, 1);
  assert.equal(sum.total, 4);
  assert.deepEqual(sum.retryIds, [1, 7]);
  assert.deepEqual(summarizeResults(null), { ok: 0, partial: 0, ng: 0, total: 0, retryIds: [] });
});

test('formatElapsed：秒と分', () => {
  assert.equal(formatElapsed(0), '0 秒');
  assert.equal(formatElapsed(12.7), '12 秒');
  assert.equal(formatElapsed(65), '1 分 05 秒');
  assert.equal(formatElapsed(NaN), '0 秒');
});
