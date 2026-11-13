// wordlist.js の DOM を使わない部分のテスト（node --test tests/wordlist.test.mjs）
// データはすべて自作のダミー（教材の文章は使わない）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PAGE_SIZE,
  normalizeText,
  statusOf,
  posGroupOf,
  representativeId,
  wordStage,
  otherSentenceIds,
  listWordStages,
  sortWords,
  normalizeQuery,
  filterWords,
  countByStatus,
  spokenText,
  debounce,
  SORT_KEYS,
  WORDLIST_KEY,
  normalizeSortKey,
  loadWordListSettings,
  saveWordListSettings,
  parseBookNoQuery,
} from '../js/modes/wordlist.js';

// ダミーの単語
function w(id, word, meaning, pos, sentenceIds, extra = {}) {
  return { id, word, meaning, pos, sentenceIds, isPhrase: false, form: word, source: 'auto', verified: false, ...extra };
}
const WORDS = [
  w('w0001', 'zebrafy', 'しま模様にする', '動詞', [1]),
  w('w0002', 'Glimmerstone', 'きらきら石', '名詞', [12, 300], { verified: true }),
  w('w0003', 'quickish', 'わりと速い', '形容詞', [55]),
  w('w0004', 'softly-ish', 'そっとめに', '副詞', [120]),
  w('w0005', 'take a dummy', 'ダミーを取る', '熟語', [51], { isPhrase: true }),
  w('w0006', 'Hi there dummy', 'やあダミー', '会話表現', [560], { isPhrase: true }),
  w('w0007', 'blorp', 'ぶよぶよしたもの', '前置詞', [2]),
  w('w0008', 'noexample', '例文のない語', '名詞', []),
  w('w0009', 'phrase-pos-verb', '句だけど動詞と書かれた語', '動詞', [3], { isPhrase: true }),
];
const PROGRESS = {
  w0002: { box: 4, due: '2026-12-01', correct: 4, wrong: 0, last: '2026-11-10' },     // 覚えた
  w0003: { box: 1, due: '2026-11-14', correct: 1, wrong: 1, last: '2026-11-13' },     // 学習中
  w0004: { box: 5, due: '2026-12-13', correct: 6, wrong: 0, mastered: true },         // マスター
  w0005: { box: 3, due: '2026-11-20', correct: 3, wrong: 2 },                         // 覚えた
  w0007: { box: 0, due: '2026-11-13', correct: 0, wrong: 1 },                         // 学習中
};
const ids = (list) => list.map((x) => x.id);

test('normalizeText：全角半角・大文字小文字・空白・波線をそろえる', () => {
  assert.equal(normalizeText('ＡＢＣ　ｄｅｆ'), 'abc def');
  assert.equal(normalizeText('  Take   A  Dummy '), 'take a dummy');
  assert.equal(normalizeText('ｶﾀｶﾅ'), 'カタカナ');
  assert.equal(normalizeText('a ～ b〜c~d'), 'a ~ b~c~d');
  assert.equal(normalizeText('it’s'), "it's");
  assert.equal(normalizeText(null), '');
  assert.equal(normalizeText(undefined), '');
});

test('statusOf：未学習 / 学習中 / 覚えた / マスター', () => {
  assert.equal(statusOf(undefined), 'new');
  assert.equal(statusOf(null), 'new');
  assert.equal(statusOf({ box: 0 }), 'learning');
  assert.equal(statusOf({ box: 2 }), 'learning');
  assert.equal(statusOf({ box: 3 }), 'learned');
  assert.equal(statusOf({ box: 5 }), 'learned');
  assert.equal(statusOf({ box: 5, mastered: true }), 'mastered');
  assert.equal(statusOf({ box: 0, mastered: false }), 'learning');
  assert.equal(statusOf({}), 'learning'); // 記録はあるが箱が無い
});

test('posGroupOf：品詞のまとまり', () => {
  assert.equal(posGroupOf(WORDS[0]), 'verb');
  assert.equal(posGroupOf(WORDS[1]), 'noun');
  assert.equal(posGroupOf(WORDS[2]), 'adj');
  assert.equal(posGroupOf(WORDS[3]), 'adv');
  assert.equal(posGroupOf(WORDS[4]), 'phrase');
  assert.equal(posGroupOf(WORDS[5]), 'phrase');
  assert.equal(posGroupOf(WORDS[6]), 'other');
  assert.equal(posGroupOf(WORDS[8]), 'phrase'); // isPhrase が優先
  assert.equal(posGroupOf({ pos: '会話表現', isPhrase: false }), 'phrase');
  assert.equal(posGroupOf({}), 'other');
  assert.equal(posGroupOf(null), 'other');
});

test('代表の例文番号・ステージ・ほかの例文', () => {
  assert.equal(representativeId(WORDS[1]), 12);
  assert.equal(representativeId(WORDS[7]), null);
  assert.equal(representativeId({ sentenceIds: [0] }), null);
  assert.equal(wordStage(WORDS[0]), 1);
  assert.equal(wordStage(WORDS[4]), 2);   // 51 → ステージ 2
  assert.equal(wordStage(WORDS[5]), 12);  // 560 → ステージ 12
  assert.equal(wordStage(WORDS[7]), 0);
  assert.deepEqual(otherSentenceIds(WORDS[1]), [300]);
  assert.deepEqual(otherSentenceIds({ sentenceIds: [5, 5, 9, 'x', 9, 0, 7] }), [9, 7]);
  assert.deepEqual(otherSentenceIds(WORDS[0]), []);
  const st = listWordStages(WORDS);
  assert.equal(st.length, 12);
  assert.deepEqual(st[0], { stage: 1, from: 1, to: 50 });
  assert.deepEqual(st[11], { stage: 12, from: 551, to: 600 });
  assert.deepEqual(listWordStages([]), []);
});

test('sortWords：代表の例文番号順、同じなら id 順、例文なしは最後。元の配列は変えない', () => {
  const extra = w('w0010', 'aaa', 'え', '名詞', [1]);
  const input = [...WORDS, extra];
  const before = ids(input);
  const out = sortWords(input);
  assert.deepEqual(ids(out), ['w0001', 'w0010', 'w0007', 'w0009', 'w0002', 'w0005', 'w0003', 'w0004', 'w0006', 'w0008']);
  assert.deepEqual(ids(input), before);
});

test('normalizeQuery：壊れた値はすべて扱い', () => {
  assert.deepEqual(normalizeQuery(undefined), { text: '', stage: 'all', status: 'all', pos: 'all' });
  assert.deepEqual(normalizeQuery('ＡＢ'), { text: 'ab', stage: 'all', status: 'all', pos: 'all' });
  assert.deepEqual(normalizeQuery({ stage: '3', status: 'x', pos: 'y' }), { text: '', stage: 3, status: 'all', pos: 'all' });
  assert.equal(normalizeQuery({ stage: 0 }).stage, 'all');
  assert.equal(normalizeQuery({ stage: 'abc' }).stage, 'all');
  assert.equal(normalizeQuery({ stage: 1.5 }).stage, 'all');
});

test('filterWords：条件なしなら全件（順番はそのまま）', () => {
  assert.deepEqual(ids(filterWords(WORDS, PROGRESS, {})), ids(WORDS));
  assert.deepEqual(ids(filterWords(WORDS, PROGRESS, '')), ids(WORDS));
  assert.equal(filterWords(WORDS, null, undefined).length, WORDS.length);
  assert.deepEqual(filterWords(null, PROGRESS, {}), []);
});

test('filterWords：検索（見出し語・意味の部分一致、正規化）', () => {
  assert.deepEqual(ids(filterWords(WORDS, PROGRESS, 'glimmer')), ['w0002']);       // 大文字小文字
  assert.deepEqual(ids(filterWords(WORDS, PROGRESS, 'ＧＬＩＭ')), ['w0002']);       // 全角
  assert.deepEqual(ids(filterWords(WORDS, PROGRESS, { text: 'きらきら' })), ['w0002']); // 意味
  assert.deepEqual(ids(filterWords(WORDS, PROGRESS, 'ﾀﾞﾐｰ')), ['w0005', 'w0006']);   // 半角カナ → 意味
  assert.deepEqual(ids(filterWords(WORDS, PROGRESS, 'take  a　dum')), ['w0005']);   // 空白の違い
  assert.deepEqual(ids(filterWords(WORDS, PROGRESS, '  ')), ids(WORDS));             // 空白だけは条件なし
  assert.deepEqual(filterWords(WORDS, PROGRESS, 'no-such-word'), []);
  // 「dummy」は見出し語にも意味にも出る語をまとめて拾う
  assert.deepEqual(ids(filterWords(WORDS, PROGRESS, 'dummy')), ['w0005', 'w0006']);
});

test('filterWords：ステージ', () => {
  assert.deepEqual(ids(filterWords(WORDS, PROGRESS, { stage: 1 })), ['w0001', 'w0002', 'w0007', 'w0009']);
  assert.deepEqual(ids(filterWords(WORDS, PROGRESS, { stage: '2' })), ['w0003', 'w0005']);
  assert.deepEqual(ids(filterWords(WORDS, PROGRESS, { stage: 3 })), ['w0004']); // 120 → ステージ 3
  assert.deepEqual(ids(filterWords(WORDS, PROGRESS, { stage: 12 })), ['w0006']);
  assert.deepEqual(filterWords(WORDS, PROGRESS, { stage: 5 }), []);
  // ほかの例文（300）ではステージを決めない
  assert.ok(!ids(filterWords(WORDS, PROGRESS, { stage: 6 })).includes('w0002'));
});

test('filterWords：習得状況・未確認', () => {
  assert.deepEqual(ids(filterWords(WORDS, PROGRESS, { status: 'new' })), ['w0001', 'w0006', 'w0008', 'w0009']);
  assert.deepEqual(ids(filterWords(WORDS, PROGRESS, { status: 'learning' })), ['w0003', 'w0007']);
  assert.deepEqual(ids(filterWords(WORDS, PROGRESS, { status: 'learned' })), ['w0002', 'w0005']);
  assert.deepEqual(ids(filterWords(WORDS, PROGRESS, { status: 'mastered' })), ['w0004']);
  assert.deepEqual(ids(filterWords(WORDS, PROGRESS, { status: 'unverified' })),
    ids(WORDS).filter((id) => id !== 'w0002'));
  // 学習記録が無いときは全部「未学習」
  assert.equal(filterWords(WORDS, {}, { status: 'new' }).length, WORDS.length);
});

test('filterWords：品詞', () => {
  assert.deepEqual(ids(filterWords(WORDS, PROGRESS, { pos: 'noun' })), ['w0002', 'w0008']);
  assert.deepEqual(ids(filterWords(WORDS, PROGRESS, { pos: 'verb' })), ['w0001']);
  assert.deepEqual(ids(filterWords(WORDS, PROGRESS, { pos: 'adj' })), ['w0003']);
  assert.deepEqual(ids(filterWords(WORDS, PROGRESS, { pos: 'adv' })), ['w0004']);
  assert.deepEqual(ids(filterWords(WORDS, PROGRESS, { pos: 'phrase' })), ['w0005', 'w0006', 'w0009']);
  assert.deepEqual(ids(filterWords(WORDS, PROGRESS, { pos: 'other' })), ['w0007']);
});

test('filterWords：組み合わせ（AND）', () => {
  assert.deepEqual(ids(filterWords(WORDS, PROGRESS, { stage: 2, status: 'learned' })), ['w0005']);
  assert.deepEqual(ids(filterWords(WORDS, PROGRESS, { stage: 2, pos: 'phrase', text: 'ダミー' })), ['w0005']);
  assert.deepEqual(ids(filterWords(WORDS, PROGRESS, { stage: 1, status: 'unverified', pos: 'verb' })), ['w0001']);
  assert.deepEqual(filterWords(WORDS, PROGRESS, { stage: 12, status: 'mastered' }), []);
  assert.deepEqual(ids(filterWords(WORDS, PROGRESS, { status: 'new', pos: 'phrase' })), ['w0006', 'w0009']);
});

test('filterWords：件数（大量データでも件数が合う）', () => {
  const many = [];
  for (let i = 1; i <= 1700; i++) {
    many.push(w(`w${String(i).padStart(4, '0')}`, `dummy${i}`, `ダミー${i}`, i % 2 ? '名詞' : '動詞', [((i - 1) % 562) + 1],
      { verified: i % 10 === 0 }));
  }
  const prog = {};
  for (let i = 1; i <= 300; i++) prog[`w${String(i).padStart(4, '0')}`] = { box: i % 6, mastered: i % 50 === 0 };
  assert.equal(filterWords(many, prog, {}).length, 1700);
  assert.equal(filterWords(many, prog, { pos: 'noun' }).length, 850);
  assert.equal(filterWords(many, prog, { status: 'unverified' }).length, 1530);
  assert.equal(filterWords(many, prog, { status: 'new' }).length, 1400);
  assert.equal(filterWords(many, prog, { status: 'mastered' }).length, 6);
  assert.equal(filterWords(many, prog, 'dummy17').length, 12); // 17, 170〜179, 1700
  // ステージ 1（例文 1〜50）：i % 562 が 1〜50 になる語
  const expectStage1 = many.filter((x) => x.sentenceIds[0] <= 50).length;
  assert.equal(filterWords(many, prog, { stage: 1 }).length, expectStage1);
  const c = countByStatus(many, prog);
  assert.equal(c.total, 1700);
  assert.equal(c.new + c.learning + c.learned + c.mastered, 1700);
  assert.equal(c.new, 1400);
  assert.equal(c.mastered, 6);
  assert.equal(c.unverified, 1530);
  assert.ok(PAGE_SIZE > 0 && PAGE_SIZE <= 200);
});

test('countByStatus：ダミーの件数', () => {
  assert.deepEqual(countByStatus(WORDS, PROGRESS),
    { new: 4, learning: 2, learned: 2, mastered: 1, unverified: 8, total: 9 });
  assert.deepEqual(countByStatus([], {}), { new: 0, learning: 0, learned: 0, mastered: 0, unverified: 0, total: 0 });
});

test('検索のキャッシュ：語の中身が変わったら新しい中身で探す', () => {
  const x = w('w9999', 'oldword', 'ふるい', '名詞', [1]);
  assert.equal(filterWords([x], {}, 'oldword').length, 1);
  x.word = 'newword';
  assert.equal(filterWords([x], {}, 'oldword').length, 0);
  assert.equal(filterWords([x], {}, 'newword').length, 1);
});

test('spokenText："..." や "～" は読まない', () => {
  assert.equal(spokenText({ word: 'take ... dummy' }), 'take dummy');
  assert.equal(spokenText({ word: 'dummy ～' }), 'dummy');
  assert.equal(spokenText({ word: '〜 dummy…' }), 'dummy');
  assert.equal(spokenText(null), '');
});

test('debounce：続けて呼んだら最後の 1 回だけ。cancel で止まる', async () => {
  const calls = [];
  const f = debounce((v) => calls.push(v), 20);
  f(1); f(2); f(3);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(calls, [3]);
  f(4); f.cancel();
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(calls, [3]);
});

// ---------- 本の番号（bookNo）・例文にない語 ----------

const BOOK_WORDS = [
  w('w0101', 'alphadum', 'アルファのダミー', '名詞', [3], { bookNo: 87 }),
  w('w0102', 'betadum', 'ベータのダミー', '動詞', [1], { bookNo: 12 }),
  w('w0103', 'gammadum', 'ガンマのダミー', '名詞', [], { bookNo: 88, group: 'ダミーのまとめ', relatedSentenceIds: [60] }),
  w('w0104', 'deltadum', 'デルタのダミー', '名詞', [2]),                          // bookNo なし
  w('w0105', 'epsdum', 'イプシロンのダミー', '名詞', [], { group: 'ダミーのまとめ' }), // ステージなし
  w('w0106', 'zetadum 87', '数字入りのダミー', '名詞', [4]),                       // 見出し語に 87 を含む
];

test('parseBookNoQuery：数字だけ・No.87・no87・全角', () => {
  assert.equal(parseBookNoQuery('87'), 87);
  assert.equal(parseBookNoQuery('No.87'), 87);
  assert.equal(parseBookNoQuery('no87'), 87);
  assert.equal(parseBookNoQuery('NO 87'), 87);
  assert.equal(parseBookNoQuery('８７'), 87);
  assert.equal(parseBookNoQuery(' Ｎｏ．87 '), 87);
  assert.equal(parseBookNoQuery('87a'), null);
  assert.equal(parseBookNoQuery('note'), null);
  assert.equal(parseBookNoQuery('0'), null);
  assert.equal(parseBookNoQuery(''), null);
});

test('filterWords：数字なら bookNo の完全一致でも探す（部分一致は見出し語・意味だけ）', () => {
  assert.deepEqual(ids(filterWords(BOOK_WORDS, {}, '87')), ['w0101', 'w0106']); // No.87 と、見出し語に 87 を含む語
  assert.deepEqual(ids(filterWords(BOOK_WORDS, {}, 'No.87')), ['w0101']);
  assert.deepEqual(ids(filterWords(BOOK_WORDS, {}, 'no87')), ['w0101']);
  assert.deepEqual(ids(filterWords(BOOK_WORDS, {}, '8')), ['w0106']); // bookNo は完全一致だけ（87・88 は出ない。見出し語の部分一致は出る）
  assert.deepEqual(ids(filterWords(BOOK_WORDS, {}, '12')), ['w0102']);
  assert.deepEqual(ids(filterWords(BOOK_WORDS, {}, { text: '88', status: 'nosentence' })), ['w0103']);
});

test('filterWords：例文なし（まとめの語）とステージなし', () => {
  assert.deepEqual(ids(filterWords(BOOK_WORDS, {}, { status: 'nosentence' })), ['w0103', 'w0105']);
  assert.deepEqual(ids(filterWords(WORDS, PROGRESS, { status: 'nosentence' })), ['w0008']);
  assert.equal(normalizeQuery({ stage: 'none' }).stage, 'none');
  assert.equal(normalizeQuery({ status: 'nosentence' }).status, 'nosentence');
  assert.deepEqual(ids(filterWords(BOOK_WORDS, {}, { stage: 'none' })), ['w0105']);
  assert.deepEqual(ids(filterWords(BOOK_WORDS, {}, { stage: 2 })), ['w0103']); // 関連例文 60 → ステージ 2
});

test('wordStage：例文にない語は関連例文で決める。どちらも無ければ 0', () => {
  assert.equal(wordStage(BOOK_WORDS[2]), 2);
  assert.equal(wordStage(BOOK_WORDS[4]), 0);
  assert.equal(wordStage(w('w0200', 'x', 'x', '名詞', [7], { relatedSentenceIds: [400] })), 1);
  assert.equal(listWordStages(BOOK_WORDS).length, 2);
});

test('sortWords：本の番号順（bookNo の無い語は最後、その中は例文の順）。既定は例文の順', () => {
  assert.deepEqual(ids(sortWords(BOOK_WORDS, 'book')), ['w0102', 'w0101', 'w0103', 'w0104', 'w0106', 'w0105']);
  assert.deepEqual(ids(sortWords(BOOK_WORDS)), ['w0102', 'w0104', 'w0101', 'w0106', 'w0103', 'w0105']);
  assert.deepEqual(ids(sortWords(BOOK_WORDS, 'sentence')), ids(sortWords(BOOK_WORDS)));
  assert.deepEqual(ids(sortWords(BOOK_WORDS, 'xxx')), ids(sortWords(BOOK_WORDS)));
  // bookNo の無いデータでは、本の番号順も例文の順と同じ
  assert.deepEqual(ids(sortWords(WORDS, 'book')), ids(sortWords(WORDS)));
});

/** localStorage の代わり */
function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
  };
}

test('並べ替えの設定：kk.wordlist.v1 に覚える。壊れていても既定値', () => {
  assert.equal(WORDLIST_KEY, 'kk.wordlist.v1');
  assert.deepEqual(Object.keys(SORT_KEYS), ['sentence', 'book']);
  assert.equal(normalizeSortKey('book'), 'book');
  assert.equal(normalizeSortKey('toString'), 'sentence');
  const st = memoryStorage();
  assert.deepEqual(loadWordListSettings(st), { sort: 'sentence' });
  assert.equal(saveWordListSettings({ sort: 'book' }, st), true);
  assert.deepEqual(JSON.parse(st.data[WORDLIST_KEY]), { version: 1, sort: 'book' });
  assert.deepEqual(loadWordListSettings(st), { sort: 'book' });
  assert.deepEqual(loadWordListSettings(memoryStorage({ [WORDLIST_KEY]: '{壊れた' })), { sort: 'sentence' });
  assert.deepEqual(loadWordListSettings(memoryStorage({ [WORDLIST_KEY]: '{"sort":"zzz"}' })), { sort: 'sentence' });
  assert.deepEqual(loadWordListSettings(null), { sort: 'sentence' });
  const broken = { getItem: () => { throw new Error('使えない'); }, setItem: () => { throw new Error('使えない'); } };
  assert.deepEqual(loadWordListSettings(broken), { sort: 'sentence' });
  assert.equal(saveWordListSettings({ sort: 'book' }, broken), false);
});
