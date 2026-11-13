// dictation.js の DOM を使わない部分のテスト（node --test tests/dictation.test.mjs）
// データはすべて自作のダミー（教材の文章は使わない）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DICTATION_KEY,
  DEFAULT_DICTATION_SETTINGS,
  tokenize,
  expandContraction,
  similarity,
  scoreDictation,
  hintPattern,
  normalizeDictationSettings,
  isDictatable,
  selectDictationRange,
  shuffle,
  buildQuestionList,
  summarizeResults,
  loadDictation,
  saveDictation,
  addResult,
} from '../js/modes/dictation.js';

// ---- ダミーデータ ----
function dummy(id, extra = {}) {
  return {
    id,
    file: `dummy_${String(id).padStart(4, '0')}.mp3`,
    en: `My cat number ${id} likes blue boxes.`,
    ja: `ダミー文 ${id}`,
    seg: { en1: [0.5, 2.5], ja: [3, 5], en2: [5.5, 7.5], en3: [8, 10] },
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
class BrokenStorage {
  getItem() { throw new Error('使えない'); }
  setItem() { throw new Error('使えない'); }
  removeItem() {}
}

const kinds = (r) => r.items.map((it) => it.kind);

// ======================================================
// 語に分ける・短縮形
// ======================================================

test('tokenize：句読点・引用符・ハイフンを区切りにし、語の中の \' は残す', () => {
  assert.deepEqual(tokenize('"Hello," she said. Well-known dogs!').map((t) => t.norm),
    ['hello', 'she', 'said', 'well', 'known', 'dogs']);
  assert.deepEqual(tokenize('I’m at Tom‘s house.').map((t) => t.norm), ["i'm", 'at', "tom's", 'house']);
  assert.deepEqual(tokenize('ＡＢＣ　ｄｅｆ').map((t) => t.norm), ['abc', 'def']); // 全角 → 半角
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize(null), []);
  assert.equal(tokenize('Hello')[0].text, 'Hello'); // 元の書き方を残す
});

test('expandContraction：よくある短縮形を展開する', () => {
  assert.deepEqual(expandContraction("i'm"), ['i', 'am']);
  assert.deepEqual(expandContraction("don't"), ['do', 'not']);
  assert.deepEqual(expandContraction("doesn't"), ['does', 'not']);
  assert.deepEqual(expandContraction("can't"), ['can', 'not']);
  assert.deepEqual(expandContraction('cannot'), ['can', 'not']);
  assert.deepEqual(expandContraction("won't"), ['will', 'not']);
  assert.deepEqual(expandContraction("you're"), ['you', 'are']);
  assert.deepEqual(expandContraction("we've"), ['we', 'have']);
  assert.deepEqual(expandContraction("they'll"), ['they', 'will']);
  assert.deepEqual(expandContraction("she'd"), ['she', 'would']);
  assert.deepEqual(expandContraction("it's"), ['it', 'is']);
  assert.deepEqual(expandContraction("let's"), ['let', 'us']);
  assert.deepEqual(expandContraction("tom's"), ["tom's"]); // 所有格はそのまま
  assert.deepEqual(expandContraction('dog'), ['dog']);
});

test('similarity：同じなら 1、まったく違えば小さい', () => {
  assert.equal(similarity('cat', 'cat'), 1);
  assert.ok(similarity('blue', 'blew') > similarity('blue', 'xyz'));
  assert.equal(similarity('', 'a'), 0);
});

// ======================================================
// 採点
// ======================================================

test('採点：全部合っていれば 100%', () => {
  const r = scoreDictation('My cat likes blue boxes.', 'my cat likes blue boxes');
  assert.equal(r.percent, 100);
  assert.equal(r.ok, 5);
  assert.equal(r.total, 5);
  assert.deepEqual(kinds(r), ['ok', 'ok', 'ok', 'ok', 'ok']);
});

test('採点：大文字小文字・句読点・’ と \' の違いは無視する', () => {
  const r = scoreDictation('"Oh, Ken\'s pen is red!"', 'OH KEN’S PEN IS RED');
  assert.equal(r.percent, 100);
  const r2 = scoreDictation('Yes, it is.', 'yes . it , is ?');
  assert.equal(r2.percent, 100);
});

test('採点：抜けた語は missing', () => {
  const r = scoreDictation('My cat likes blue boxes', 'my cat likes boxes');
  assert.equal(r.ok, 4);
  assert.equal(r.missing, 1);
  assert.equal(r.percent, 80);
  const miss = r.items.find((it) => it.kind === 'missing');
  assert.equal(miss.expected, 'blue');
  assert.equal(miss.got, undefined);
  assert.deepEqual(kinds(r), ['ok', 'ok', 'ok', 'missing', 'ok']); // 文の順
});

test('採点：余分な語は extra（点数は下げない）', () => {
  const r = scoreDictation('My cat likes boxes', 'my big cat likes boxes');
  assert.equal(r.percent, 100);
  assert.equal(r.extra, 1);
  assert.deepEqual(kinds(r), ['ok', 'extra', 'ok', 'ok', 'ok']);
  assert.equal(r.items[1].got, 'big');
});

test('採点：違う語は wrong（入力した語 → 正しい語）', () => {
  const r = scoreDictation('My cat likes blue boxes', 'my cat likes blew boxes');
  assert.equal(r.wrong, 1);
  assert.equal(r.percent, 80);
  const w = r.items.find((it) => it.kind === 'wrong');
  assert.equal(w.got, 'blew');
  assert.equal(w.expected, 'blue');
});

test('採点：すき間では、つづりの近い語同士を組にする', () => {
  // 正解 2 語のすき間に入力 1 語 → 近いほうが ×、もう片方は ―
  const r = scoreDictation('I saw red apples today', 'I saw apple today');
  assert.deepEqual(kinds(r), ['ok', 'ok', 'missing', 'wrong', 'ok']);
  assert.equal(r.items[3].got, 'apple');
  assert.equal(r.items[3].expected, 'apples');
});

test('採点：語順の入れ替えは、片方だけ合っている扱い', () => {
  const r = scoreDictation('We play tennis after school', 'We play after tennis school');
  assert.equal(r.total, 5);
  assert.equal(r.ok, 4); // LCS は 4 語
  assert.equal(r.percent, 80);
  assert.equal(r.missing + r.wrong, 1);
  assert.equal(r.extra + r.wrong, 1);
});

test('採点：短縮形と展開した形は同じとみなす', () => {
  assert.equal(scoreDictation("I'm a student.", 'I am a student').percent, 100);
  assert.equal(scoreDictation('I am a student.', "i'm a student").percent, 100);
  assert.equal(scoreDictation("He doesn't know.", 'he does not know').percent, 100);
  assert.equal(scoreDictation("You can't swim.", 'you cannot swim').percent, 100);
  assert.equal(scoreDictation("It's sunny.", 'it is sunny').percent, 100);
  // 正解が短縮形のとき、語数は短縮形を 1 語として数える
  const r = scoreDictation("I'm happy", 'I am happy');
  assert.equal(r.total, 2);
  assert.equal(r.items[0].expected, "I'm");
  assert.equal(r.items[0].got, 'I am');
});

test('採点：短縮形の半分だけ合っていれば、その語は ×', () => {
  const r = scoreDictation("I'm happy", 'I happy');
  assert.equal(r.items[0].kind, 'wrong');
  assert.equal(r.percent, 50);
});

test('採点：所有格の \'s は展開しない（Tom\'s と Tom is は違う）', () => {
  const r = scoreDictation("Tom's bag", 'Tom is bag');
  assert.notEqual(r.percent, 100);
});

test('採点：数字と数の単語は別の語として扱う', () => {
  const r = scoreDictation('I have 2 dogs', 'I have two dogs');
  assert.equal(r.wrong, 1);
  assert.equal(r.percent, 75);
});

test('採点：空の入力は全部 missing で 0%', () => {
  for (const input of ['', '   ', '\n\n', '...', null, undefined]) {
    const r = scoreDictation('My cat likes boxes', input);
    assert.equal(r.percent, 0);
    assert.equal(r.missing, 4);
    assert.equal(r.extra, 0);
  }
});

test('採点：正解の英文が空なら 0 語・0%（落ちない）', () => {
  const r = scoreDictation('', 'something');
  assert.equal(r.total, 0);
  assert.equal(r.percent, 0);
  assert.equal(r.extra, 1);
});

test('採点：複数行の入力と、同じ語のくり返しも扱える', () => {
  const r = scoreDictation('the dog and the cat', 'the dog\nand the the cat');
  assert.equal(r.percent, 100);
  assert.equal(r.extra, 1);
});

// ======================================================
// ヒント・範囲・出題
// ======================================================

test('hintPattern：語数ぶんの _ を空白でつなぐ', () => {
  assert.deepEqual(hintPattern('My cat likes boxes.'), { pattern: '_ _ _ _', count: 4 });
  assert.deepEqual(hintPattern("I'm fine."), { pattern: '_ _', count: 2 });
  assert.deepEqual(hintPattern(''), { pattern: '', count: 0 });
});

test('normalizeDictationSettings：壊れた値は既定値、範囲は例文に合わせる', () => {
  assert.deepEqual(normalizeDictationSettings(null), { ...DEFAULT_DICTATION_SETTINGS });
  const s = normalizeDictationSettings({ rangeKind: 'ids', from: 90, to: 10, order: 'x', count: 7, hint: 'yes' });
  assert.equal(s.rangeKind, 'ids');
  assert.equal(s.from, 10);
  assert.equal(s.to, 90);
  assert.equal(s.order, 'id');
  assert.equal(s.count, 10);
  assert.equal(s.hint, true);
  assert.equal(normalizeDictationSettings({ count: 'all' }).count, 'all');
  assert.equal(normalizeDictationSettings({ count: '20' }).count, 20);
  assert.equal(normalizeDictationSettings({ hint: false }).hint, false);
  const c = normalizeDictationSettings({ rangeKind: 'ids', from: 0, to: 999, stage: 9 }, SENTENCES);
  assert.equal(c.from, 1);
  assert.equal(c.to, 120);
  assert.equal(c.stage, 1); // ステージ 9 は無いので最初のステージ
});

test('isDictatable：英文・英語区間・ファイル名がそろった例文だけ', () => {
  assert.equal(isDictatable(dummy(1)), true);
  assert.equal(isDictatable(dummy(1, { en: '' })), false);
  assert.equal(isDictatable(dummy(1, { en: '...' })), false);
  assert.equal(isDictatable(dummy(1, { seg: null })), false);
  assert.equal(isDictatable(dummy(1, { seg: { en1: [3, 1] } })), false);
  assert.equal(isDictatable(dummy(1, { file: '' })), false);
  assert.equal(isDictatable({ id: 0 }), false);
});

test('selectDictationRange：ステージと番号で選び、使えない例文は外す', () => {
  const list = [...SENTENCES, dummy(121, { en: '' })];
  const st2 = selectDictationRange(list, { rangeKind: 'stage', stage: 2 });
  assert.equal(st2.length, 50);
  assert.equal(st2[0].id, 51);
  assert.equal(st2[49].id, 100);
  const st3 = selectDictationRange(list, { rangeKind: 'stage', stage: 3 });
  assert.deepEqual(st3.map((s) => s.id), Array.from({ length: 20 }, (_, i) => 101 + i)); // 121 は外れる
  const ids = selectDictationRange(list, { rangeKind: 'ids', from: 12, to: 10 });
  assert.deepEqual(ids.map((s) => s.id), [10, 11, 12]);
  assert.deepEqual(selectDictationRange(list, { rangeKind: 'ids', from: 'a', to: 3 }), []);
  assert.deepEqual(selectDictationRange(null, DEFAULT_DICTATION_SETTINGS), []);
});

test('shuffle：中身は同じで、元の配列は変えない', () => {
  const a = [1, 2, 3, 4, 5];
  let seed = 1;
  const rng = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const b = shuffle(a, rng);
  assert.deepEqual(a, [1, 2, 3, 4, 5]);
  assert.deepEqual([...b].sort(), [1, 2, 3, 4, 5]);
  assert.deepEqual(shuffle([], rng), []);
});

test('buildQuestionList：番号順・ランダム・問題数', () => {
  const base = { rangeKind: 'stage', stage: 1, hint: true };
  const byId = buildQuestionList(SENTENCES, { ...base, order: 'id', count: 5 });
  assert.deepEqual(byId.map((s) => s.id), [1, 2, 3, 4, 5]);
  assert.equal(buildQuestionList(SENTENCES, { ...base, order: 'id', count: 'all' }).length, 50);
  assert.equal(buildQuestionList(SENTENCES, { ...base, order: 'id', count: 20 }).length, 20);
  // 範囲より問題数が多いときは範囲すべて
  assert.equal(buildQuestionList(SENTENCES, { rangeKind: 'ids', from: 1, to: 3, order: 'id', count: 10 }).length, 3);
  // ランダム：rng を固定すると決まった並び。重複なし・範囲内
  const rng = () => 0;
  const rnd = buildQuestionList(SENTENCES, { ...base, order: 'random', count: 10 }, rng);
  assert.equal(rnd.length, 10);
  assert.equal(new Set(rnd.map((s) => s.id)).size, 10);
  assert.ok(rnd.every((s) => s.id >= 1 && s.id <= 50));
  assert.notDeepEqual(rnd.map((s) => s.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('summarizeResults：平均点と 70% 未満の文', () => {
  const s = summarizeResults([{ id: 1, percent: 100 }, { id: 2, percent: 69 }, { id: 3, percent: 70 }, { id: 4, percent: 0 }]);
  assert.equal(s.average, 60); // (100+69+70+0)/4 = 59.75 → 60
  assert.deepEqual(s.low.map((r) => r.id), [2, 4]);
  assert.equal(s.count, 4);
  assert.deepEqual(summarizeResults([]), { average: 0, low: [], count: 0 });
  assert.deepEqual(summarizeResults(null).low, []);
});

// ======================================================
// 記録（kk.dictation.v1）
// ======================================================

test('記録：無ければ空、保存して読み直せる', () => {
  const st = new MemoryStorage();
  const empty = loadDictation(st);
  assert.deepEqual(empty.records, {});
  assert.deepEqual(empty.settings, { ...DEFAULT_DICTATION_SETTINGS });

  let d = addResult(empty, 5, 60, '2026-11-13');
  d = addResult(d, 5, 90, '2026-11-14');
  d = addResult(d, 5, 40.4, '2026-11-15');
  d = addResult(d, 7, 100, '2026-11-15');
  assert.deepEqual(d.records[5], { best: 90, last: 40, count: 3, date: '2026-11-15' });
  assert.deepEqual(empty.records, {}); // 元のデータは変えない

  d = { ...d, settings: { ...DEFAULT_DICTATION_SETTINGS, order: 'random', count: 'all', hint: false } };
  assert.equal(saveDictation(d, st), true);
  assert.ok(st.getItem(DICTATION_KEY));
  const back = loadDictation(st);
  assert.deepEqual(back.records[5], { best: 90, last: 40, count: 3, date: '2026-11-15' });
  assert.deepEqual(back.records[7], { best: 100, last: 100, count: 1, date: '2026-11-15' });
  assert.equal(back.settings.order, 'random');
  assert.equal(back.settings.count, 'all');
  assert.equal(back.settings.hint, false);
});

test('記録：点数は 0〜100 に丸める', () => {
  const d = addResult(null, 1, 150, '2026-11-13');
  assert.equal(d.records[1].best, 100);
  const d2 = addResult(null, 1, -5, '2026-11-13');
  assert.equal(d2.records[1].last, 0);
});

test('記録：壊れた JSON・形の違う中身・使えない環境でも落ちない', () => {
  const st = new MemoryStorage();
  st.setItem(DICTATION_KEY, '{oops');
  assert.deepEqual(loadDictation(st).records, {});
  st.setItem(DICTATION_KEY, '[1,2]');
  assert.deepEqual(loadDictation(st).records, {});
  st.setItem(DICTATION_KEY, JSON.stringify({
    records: { 3: { best: 50, last: 50, count: 1, date: '2026-11-13' }, x: { best: 1 }, 4: { best: 'a' }, 5: null },
  }));
  assert.deepEqual(Object.keys(loadDictation(st).records), ['3']);

  const broken = new BrokenStorage();
  assert.deepEqual(loadDictation(broken).records, {});
  assert.equal(saveDictation(addResult(null, 1, 50), broken), false);
  assert.deepEqual(loadDictation(null).records, {});
  assert.equal(saveDictation({}, null), false);
});
