// 聞き流しの画面（js/modes/mylisten.js・mylisten-list.js）の、画面に依存しない関数のテスト
//
// 使い方:
//   node --test tests/mylisten.test.mjs
//
// 自作のダミーの単語だけを使う（教材の文章は使わない）。player.js が無くても通る
// （mylisten.js は player.js を startMyListen の中で読み込むため）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanSpeechText, speakTimeoutMs, pickVoice, parseNoInput, shorten, formatResumeLabel, progressInfo,
  planJump, nextPreloadNo, setMark, describeRange, gapOptions, rateText,
} from '../js/modes/mylisten.js';
import {
  normalizeListText, parseNoQuery, filterListItems, sectionOfNo, buildListEntries, findEntryIndex,
  initialWindow, markLabel,
} from '../js/modes/mylisten-list.js';

/** ダミーの通し番号つき単語（numberWords の結果の形） */
function makeNumbered(n) {
  return Array.from({ length: n }, (_, i) => ({
    no: i + 1,
    word: { id: `d${String(i + 1).padStart(4, '0')}`, word: `dummy${i + 1}`, meaning: `ダミー${i + 1}` },
  }));
}

// ---------- 読み上げ ----------

test('cleanSpeechText："..." や "～" は読まない', () => {
  assert.equal(cleanSpeechText('zork ... blip'), 'zork blip');
  assert.equal(cleanSpeechText('～をフープする'), 'をフープする');
  assert.equal(cleanSpeechText('a 〜 b ~ c…'), 'a b c');
  assert.equal(cleanSpeechText(null), '');
});

test('speakTimeoutMs：文字数×0.25 秒＋2 秒を rate で割る', () => {
  assert.equal(speakTimeoutMs('abcd', 1), 3000);
  assert.equal(speakTimeoutMs('abcd', 2), 1500);
  assert.equal(speakTimeoutMs('', 1), 2000);
  assert.equal(speakTimeoutMs('abcd', 0), 3000); // 変な rate は 1 とみなす
});

test('pickVoice：完全一致 → 言語だけ一致。無ければ null', () => {
  const voices = [
    { name: 'A', lang: 'en-GB', localService: true },
    { name: 'B', lang: 'en_US', localService: false },
    { name: 'C', lang: 'en-US', localService: true },
    { name: 'D', lang: 'ja-JP', localService: true },
  ];
  assert.equal(pickVoice(voices, 'en-US').name, 'C');
  assert.equal(pickVoice(voices, 'ja-JP').name, 'D');
  assert.equal(pickVoice([{ name: 'E', lang: 'en-AU' }], 'en-US').name, 'E');
  assert.equal(pickVoice(voices, 'fr-FR'), null);
  assert.equal(pickVoice([], 'ja-JP'), null);
  assert.equal(pickVoice(undefined, 'ja-JP'), null);
});

// ---------- 番号入力 ----------

test('parseNoInput：数字・No. の形・全角を読む', () => {
  assert.deepEqual(parseNoInput('125', 300), { no: 125, message: '' });
  assert.deepEqual(parseNoInput(' No.7 ', 300), { no: 7, message: '' });
  assert.deepEqual(parseNoInput('no 8', 300), { no: 8, message: '' });
  assert.deepEqual(parseNoInput('１２', 300), { no: 12, message: '' });
});

test('parseNoInput：範囲外は近い端へ（知らせる）、数字でなければエラー', () => {
  const big = parseNoInput('999', 300);
  assert.equal(big.no, 300);
  assert.match(big.message, /No\.300/);
  const zero = parseNoInput('0', 300);
  assert.equal(zero.no, 1);
  assert.ok(zero.message);
  assert.ok(parseNoInput('abc', 300).error);
  assert.ok(parseNoInput('', 300).error);
  assert.ok(parseNoInput('5', 0).error);
});

// ---------- 前回の位置 ----------

test('formatResumeLabel：前回の語の No. と語を出す。見つからなければ null', () => {
  const numbered = makeNumbered(200);
  const r = formatResumeLabel({ wordId: 'd0125', no: 3, at: 'x' }, numbered);
  assert.equal(r.no, 125); // 保存した no ではなく、今の並びで数え直す
  assert.equal(r.label, '続きから再生（No.125 dummy125 から）');
  assert.equal(formatResumeLabel({ wordId: 'zzz' }, numbered), null);
  assert.equal(formatResumeLabel(null, numbered), null);
  assert.equal(formatResumeLabel({}, numbered), null);
});

test('shorten：長い語は … で切る', () => {
  assert.equal(shorten('abc', 5), 'abc');
  assert.equal(shorten('abcdefgh', 5), 'abcde…');
});

// ---------- 上部の表示・移動 ----------

test('progressInfo：Section と Section の中の位置', () => {
  assert.equal(progressInfo(112, 50, 300).text, 'Section 3 ／ 12 / 50');
  assert.equal(progressInfo(50, 50, 300).text, 'Section 1 ／ 50 / 50');
  assert.equal(progressInfo(51, 50, 300).text, 'Section 2 ／ 1 / 50');
  // 最後の Section は語数が少ない
  assert.equal(progressInfo(290, 50, 297).text, 'Section 6 ／ 40 / 47');
  assert.equal(progressInfo(undefined, 50, 300).text, '');
});

test('planJump：再生リストにあれば jump、無ければその Section で読み直す', () => {
  assert.deepEqual(planJump(5, [3, 4, 5, 6], 50), { kind: 'jump' });
  assert.deepEqual(planJump(125, new Set([1, 2, 3]), 50), { kind: 'reload', range: { kind: 'section', section: 3 } });
  assert.deepEqual(planJump(20, [], 20), { kind: 'reload', range: { kind: 'section', section: 1 } });
});

test('nextPreloadNo：次に流れそうな No.', () => {
  assert.equal(nextPreloadNo([4, 5, 6], 5, 'off'), 6);
  assert.equal(nextPreloadNo([4, 5, 6], 6, 'off'), null);
  assert.equal(nextPreloadNo([4, 5, 6], 6, 'range'), 4);
  assert.equal(nextPreloadNo([4, 5, 6], 5, 'one'), null);
  assert.equal(nextPreloadNo([4, 5, 6], 99, 'off'), 4);
});

test('setMark：付ける・付け替える・同じものでもう一度押すと外す（元は変えない）', () => {
  const m0 = { d0001: 'known' };
  const m1 = setMark(m0, 'd0002', 'notyet');
  assert.deepEqual(m1, { d0001: 'known', d0002: 'notyet' });
  assert.deepEqual(m0, { d0001: 'known' });
  assert.deepEqual(setMark(m1, 'd0002', 'known'), { d0001: 'known', d0002: 'known' });
  assert.deepEqual(setMark(m1, 'd0001', 'known'), { d0002: 'notyet' });
  assert.deepEqual(setMark(null, 'd0003', 'bad'), {});
});

test('describeRange：範囲の説明', () => {
  assert.equal(describeRange({ kind: 'all' }, 50, 300), '全体（No.1〜300）');
  assert.equal(describeRange({ kind: 'section', section: 6 }, 50, 297), 'Section 6（No.251〜297）');
  assert.equal(describeRange({ kind: 'nos', from: 10, to: 20 }, 50, 300), 'No.10〜20');
  assert.equal(describeRange({ kind: 'notyet' }, 50, 300), '「まだ」の語だけ');
  assert.equal(describeRange(null, 50, 9), '全体（No.1〜9）');
});

test('gapOptions・rateText', () => {
  assert.deepEqual(gapOptions(2), [0, 0.5, 1, 1.5, 2, 3, 5]);
  assert.deepEqual(gapOptions(7), [0, 0.5, 1, 1.5, 2, 3, 5, 7]);
  assert.equal(rateText(1), '1.0');
  assert.equal(rateText(0.75), '0.75');
  assert.equal(rateText(1.5), '1.5');
});

// ---------- 単語リスト ----------

test('normalizeListText・parseNoQuery', () => {
  assert.equal(normalizeListText('  ＡＢＣ　 def '), 'abc def');
  assert.equal(normalizeListText('〜を'), '~を');
  assert.equal(parseNoQuery('125'), 125);
  assert.equal(parseNoQuery('No.12'), 12);
  assert.equal(parseNoQuery('ｎｏ　３'), 3);
  assert.equal(parseNoQuery('dummy1'), null);
  assert.equal(parseNoQuery('0'), null);
});

test('filterListItems：英単語・意味の部分一致、数字なら No. の完全一致も', () => {
  const numbered = makeNumbered(30);
  assert.equal(filterListItems(numbered, '').length, 30);
  assert.deepEqual(filterListItems(numbered, 'DUMMY2').map((x) => x.no), [2, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
  assert.deepEqual(filterListItems(numbered, 'ダミー3').map((x) => x.no), [3, 30]);
  // 「12」は No.12 と、語・意味に 12 を含むもの
  assert.deepEqual(filterListItems(numbered, '12').map((x) => x.no), [12]);
  assert.deepEqual(filterListItems(numbered, 'No.5').map((x) => x.no), [5]);
  assert.deepEqual(filterListItems(numbered, 'zzz'), []);
});

test('buildListEntries：Section の見出しを差し込む（絞ったら行のある Section だけ）', () => {
  const numbered = makeNumbered(45);
  const all = buildListEntries(numbered, 20, 45);
  const heads = all.filter((e) => e.type === 'head');
  assert.deepEqual(heads.map((h) => [h.section, h.from, h.to]), [[1, 1, 20], [2, 21, 40], [3, 41, 45]]);
  assert.equal(all.length, 45 + 3);
  assert.equal(all[0].type, 'head');
  assert.equal(all[21].type, 'head'); // 見出し 1 + 20 行のあと

  const some = buildListEntries(numbered.filter((x) => x.no === 3 || x.no === 44), 20, 45);
  assert.deepEqual(some.map((e) => (e.type === 'head' ? `S${e.section}` : e.no)), ['S1', 3, 'S3', 44]);
  assert.equal(findEntryIndex(some, 44), 3);
  assert.equal(findEntryIndex(some, 5), -1);
  assert.equal(findEntryIndex(some, null), -1);
});

test('sectionOfNo', () => {
  assert.equal(sectionOfNo(1, 50), 1);
  assert.equal(sectionOfNo(50, 50), 1);
  assert.equal(sectionOfNo(51, 50), 2);
  assert.equal(sectionOfNo(1700, 200), 9);
});

test('initialWindow：目当ての少し前から描く', () => {
  assert.deepEqual(initialWindow(0, -1), { lo: 0, hi: 0 });
  assert.deepEqual(initialWindow(1800, -1, 120, 30), { lo: 0, hi: 120 });
  assert.deepEqual(initialWindow(1800, 1000, 120, 30), { lo: 970, hi: 1090 });
  assert.deepEqual(initialWindow(1800, 1799, 120, 30), { lo: 1769, hi: 1800 });
  assert.deepEqual(initialWindow(50, 10, 120, 30), { lo: 0, hi: 50 });
});

test('markLabel', () => {
  assert.equal(markLabel('known'), '○ 覚えた');
  assert.equal(markLabel('notyet'), '△ まだ');
  assert.equal(markLabel(undefined), '');
});
