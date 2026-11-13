// srs.js の単体テスト
// 実行：node --test tests/srs.test.mjs
// 教材の文章は使わず、自作のダミーデータだけで書く。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  INTERVALS,
  todayStr,
  addDays,
  applyAnswer,
  questionType,
  isDue,
  buildDailyMenu,
  stageOf,
  stageSummary,
  bookNoOf,
  isNoSentenceWord,
  relatedSentenceId,
  stageSentenceId,
  orderNewWords,
} from '../js/srs.js';

const SRS_URL = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'js', 'srs.js'),
).href;

// ---------------------------------------------------------------------------
// ダミーデータ
// ---------------------------------------------------------------------------

/** ダミーの語を作る */
function w(id, sentenceId, extra = {}) {
  return {
    id,
    word: `word${id}`,
    pos: '名詞',
    meaning: `意味${id}`,
    isPhrase: false,
    sentenceIds: sentenceId === null ? [] : [sentenceId],
    form: `word${id}`,
    source: 'auto',
    verified: false,
    ...extra,
  };
}

/** ダミーの学習記録を作る */
function rec(box, due, extra = {}) {
  return { box, due, correct: 0, wrong: 0, last: '2026-11-01', first: '2026-11-01', mastered: false, ...extra };
}

/** オブジェクトを深く凍結する（書き換えたら例外にするため） */
function deepFreeze(obj) {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const v of Object.values(obj)) deepFreeze(v);
  }
  return obj;
}

// ---------------------------------------------------------------------------
// INTERVALS / todayStr
// ---------------------------------------------------------------------------

describe('INTERVALS', () => {
  test('箱0〜5 の日数が 0,1,3,7,14,30', () => {
    assert.deepEqual([...INTERVALS], [0, 1, 3, 7, 14, 30]);
  });
  test('書き換えられない', () => {
    assert.ok(Object.isFrozen(INTERVALS));
  });
});

describe('todayStr', () => {
  test('ローカル日付をゼロ埋めで返す', () => {
    assert.equal(todayStr(new Date(2026, 0, 5, 0, 0, 1)), '2026-01-05');
    assert.equal(todayStr(new Date(2026, 11, 31, 23, 59, 59)), '2026-12-31');
  });
  test('引数なしは今日（ローカル）', () => {
    const now = new Date();
    const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    assert.equal(todayStr(), expected);
  });
  test('無効な Date は RangeError', () => {
    assert.throws(() => todayStr(new Date('xxx')), RangeError);
  });
});

// ---------------------------------------------------------------------------
// addDays
// ---------------------------------------------------------------------------

describe('addDays', () => {
  test('普通の日', () => {
    assert.equal(addDays('2026-11-13', 0), '2026-11-13');
    assert.equal(addDays('2026-11-13', 7), '2026-11-20');
  });
  test('月末をまたぐ', () => {
    assert.equal(addDays('2026-01-31', 1), '2026-02-01');
    assert.equal(addDays('2026-04-30', 1), '2026-05-01');
    assert.equal(addDays('2026-11-20', 14), '2026-12-04');
  });
  test('年末をまたぐ', () => {
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(addDays('2026-12-20', 30), '2027-01-19');
  });
  test('うるう年：2028-02-28 + 1 = 2028-02-29', () => {
    assert.equal(addDays('2028-02-28', 1), '2028-02-29');
    assert.equal(addDays('2028-02-29', 1), '2028-03-01');
  });
  test('うるう年でない年：2027-02-28 + 1 = 2027-03-01', () => {
    assert.equal(addDays('2027-02-28', 1), '2027-03-01');
  });
  test('2100 年はうるう年でない', () => {
    assert.equal(addDays('2100-02-28', 1), '2100-03-01');
  });
  test('負の日数は過去へ', () => {
    assert.equal(addDays('2027-01-01', -1), '2026-12-31');
    assert.equal(addDays('2028-03-01', -1), '2028-02-29');
  });
  test('365 日・366 日', () => {
    assert.equal(addDays('2027-03-01', 366), '2028-03-01');
    assert.equal(addDays('2026-11-13', 365), '2027-11-13');
  });
  test('形式違い・存在しない日付・整数でない日数は RangeError', () => {
    assert.throws(() => addDays('2026/11/13', 1), RangeError);
    assert.throws(() => addDays('2026-11-3', 1), RangeError);
    assert.throws(() => addDays('2026-02-30', 1), RangeError);
    assert.throws(() => addDays('2027-02-29', 1), RangeError);
    assert.throws(() => addDays(undefined, 1), RangeError);
    assert.throws(() => addDays('2026-11-13', 1.5), RangeError);
    assert.throws(() => addDays('2026-11-13', NaN), RangeError);
  });
});

// 夏時間のある時間帯で、別プロセスを立てて確かめる（TZ は起動時に決まるため）
describe('夏時間でずれない', () => {
  /** 指定の TZ で式を評価して JSON で受け取る。tzWorks は year の 1 月と 7 月で時差が違うか（TZ が効いたか） */
  function runInTz(tz, year, expr) {
    const code = `
      import * as s from ${JSON.stringify(SRS_URL)};
      const offJan = new Date(${year}, 0, 1).getTimezoneOffset();
      const offJul = new Date(${year}, 6, 1).getTimezoneOffset();
      console.log(JSON.stringify({ tzWorks: offJan !== offJul, value: (${expr}) }));
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...process.env, TZ: tz },
      encoding: 'utf8',
    });
    return JSON.parse(out.trim());
  }

  test('America/New_York（2026-03-08 開始、2026-11-01 終了）', (t) => {
    const r = runInTz('America/New_York', 2026, `[
      s.addDays('2026-03-07', 1), s.addDays('2026-03-08', 1), s.addDays('2026-03-01', 14),
      s.addDays('2026-10-31', 1), s.addDays('2026-11-01', 1), s.addDays('2026-10-20', 30),
      s.addDays('2026-03-09', -1),
      s.todayStr(new Date(2026, 2, 8, 0, 30)), s.todayStr(new Date(2026, 10, 1, 23, 30))
    ]`);
    if (!r.tzWorks) return t.skip('この環境では TZ 環境変数が効かない');
    assert.deepEqual(r.value, [
      '2026-03-08', '2026-03-09', '2026-03-15',
      '2026-11-01', '2026-11-02', '2026-11-19',
      '2026-03-08',
      '2026-03-08', '2026-11-01',
    ]);
  });

  test('America/Sao_Paulo（2018-11-04 は 0 時が存在しない日）', (t) => {
    const r = runInTz('America/Sao_Paulo', 2018, `[
      s.addDays('2018-11-03', 1), s.addDays('2018-11-04', 1), s.addDays('2018-11-05', -1),
      s.applyAnswer(undefined, true, '2018-11-03').due
    ]`);
    if (!r.tzWorks) return t.skip('この環境では TZ 環境変数が効かない');
    assert.deepEqual(r.value, ['2018-11-04', '2018-11-05', '2018-11-04', '2018-11-04']);
  });
});

// ---------------------------------------------------------------------------
// applyAnswer
// ---------------------------------------------------------------------------

describe('applyAnswer', () => {
  const D = '2026-11-13';

  test('初回正解：box 0 から 1 へ、due は 1 日後、first = 回答日', () => {
    assert.deepEqual(applyAnswer(undefined, true, D), {
      box: 1, due: '2026-11-14', correct: 1, wrong: 0, last: D, first: D, mastered: false,
    });
  });

  test('初回不正解：box 0、due は当日、wrong 1', () => {
    assert.deepEqual(applyAnswer(undefined, false, D), {
      box: 0, due: D, correct: 0, wrong: 1, last: D, first: D, mastered: false,
    });
  });

  test('連続正解で箱が上がり、各箱の due の日数どおり', () => {
    // 毎回 due の日に答えたとする
    let r;
    let date = '2026-11-13';
    const expected = [
      { box: 1, due: '2026-11-14' }, // +1
      { box: 2, due: '2026-11-17' }, // +3
      { box: 3, due: '2026-11-24' }, // +7
      { box: 4, due: '2026-12-08' }, // +14
      { box: 5, due: '2027-01-07' }, // +30（年またぎ）
    ];
    for (const e of expected) {
      r = applyAnswer(r, true, date);
      assert.equal(r.box, e.box);
      assert.equal(r.due, e.due);
      assert.equal(r.mastered, false);
      assert.equal(r.first, '2026-11-13');
      assert.equal(r.last, date);
      date = r.due;
    }
    assert.equal(r.correct, 5);
    assert.equal(r.wrong, 0);
  });

  test('各箱に上がったときの due は INTERVALS[新しい box] 日後', () => {
    for (let before = 0; before <= 4; before++) {
      const r = applyAnswer(rec(before, D), true, D);
      assert.equal(r.box, before + 1);
      assert.equal(r.due, addDays(D, INTERVALS[before + 1]));
    }
  });

  test('不正解でどの箱からでも箱0に戻り、due は当日', () => {
    for (let before = 0; before <= 5; before++) {
      const r = applyAnswer(rec(before, '2026-11-01', { correct: 3, wrong: 2 }), false, D);
      assert.equal(r.box, 0);
      assert.equal(r.due, D);
      assert.equal(r.wrong, 3);
      assert.equal(r.correct, 3);
      assert.equal(r.mastered, false);
      assert.equal(r.last, D);
      assert.equal(r.first, '2026-11-01');
    }
  });

  test('箱5で正解すると mastered（box は 5 のまま、due は 30 日後）', () => {
    const r = applyAnswer(rec(5, D, { correct: 5 }), true, D);
    assert.equal(r.box, 5);
    assert.equal(r.mastered, true);
    assert.equal(r.due, '2026-12-13');
    assert.equal(r.correct, 6);
  });

  test('箱4から箱5に上がっただけでは mastered にならない', () => {
    const r = applyAnswer(rec(4, D), true, D);
    assert.equal(r.box, 5);
    assert.equal(r.mastered, false);
  });

  test('mastered の語を間違えると mastered = false、箱0', () => {
    const r = applyAnswer(rec(5, D, { mastered: true }), false, D);
    assert.equal(r.mastered, false);
    assert.equal(r.box, 0);
  });

  test('mastered の語にまた正解しても mastered のまま', () => {
    const r = applyAnswer(rec(5, D, { mastered: true }), true, D);
    assert.equal(r.mastered, true);
    assert.equal(r.box, 5);
  });

  test('入力の rec を書き換えず、新しいオブジェクトを返す', () => {
    const original = deepFreeze(rec(2, D, { correct: 1, wrong: 1 }));
    const r = applyAnswer(original, true, D);
    assert.notEqual(r, original);
    assert.equal(original.box, 2);
    assert.equal(original.correct, 1);
  });

  test('first が無い古い記録は last を first にする。未知の項目は引き継ぐ', () => {
    const old = { box: 1, due: '2026-11-10', correct: 1, wrong: 0, last: '2026-11-09', memo: 'x' };
    const r = applyAnswer(old, true, D);
    assert.equal(r.first, '2026-11-09');
    assert.equal(r.memo, 'x');
    assert.equal(r.mastered, false);
  });

  test('範囲外の box は丸める', () => {
    assert.equal(applyAnswer(rec(9, D), true, D).box, 5);
    assert.equal(applyAnswer(rec(-3, D), true, D).box, 1);
    assert.equal(applyAnswer(rec(undefined, D), true, D).box, 1);
  });

  test('日付が不正なら RangeError', () => {
    assert.throws(() => applyAnswer(undefined, true, '2026-13-01'), RangeError);
  });
});

// ---------------------------------------------------------------------------
// questionType
// ---------------------------------------------------------------------------

describe('questionType', () => {
  test('箱ごとの形式', () => {
    assert.equal(questionType(0), 'choice');
    assert.equal(questionType(1), 'choice');
    assert.equal(questionType(2), 'cloze');
    assert.equal(questionType(3), 'cloze');
    assert.equal(questionType(4), 'spell');
    assert.equal(questionType(5), 'spell');
  });
  test('範囲外・数値でない箱', () => {
    assert.equal(questionType(-1), 'choice');
    assert.equal(questionType(undefined), 'choice');
    assert.equal(questionType(99), 'spell');
  });
});

// ---------------------------------------------------------------------------
// isDue
// ---------------------------------------------------------------------------

describe('isDue', () => {
  const r = rec(2, '2026-11-13');
  test('期限前は false', () => {
    assert.equal(isDue(r, '2026-11-12'), false);
  });
  test('当日は true', () => {
    assert.equal(isDue(r, '2026-11-13'), true);
  });
  test('期限後は true（月・年をまたいでも）', () => {
    assert.equal(isDue(r, '2026-11-14'), true);
    assert.equal(isDue(r, '2027-01-01'), true);
  });
  test('mastered は期限後でも false', () => {
    assert.equal(isDue(rec(5, '2026-11-01', { mastered: true }), '2026-12-31'), false);
  });
  test('記録が無ければ false', () => {
    assert.equal(isDue(undefined, '2026-11-13'), false);
    assert.equal(isDue(null, '2026-11-13'), false);
  });
  test('due が無い壊れた記録は true（拾い直す）', () => {
    assert.equal(isDue({ box: 1 }, '2026-11-13'), true);
  });
});

// ---------------------------------------------------------------------------
// buildDailyMenu
// ---------------------------------------------------------------------------

describe('buildDailyMenu', () => {
  const DATE = '2026-11-13';

  test('復習は due が古い順、同じなら box が小さい順', () => {
    const words = [w('w0001', 1), w('w0002', 2), w('w0003', 3), w('w0004', 4), w('w0005', 5), w('w0006', 6)];
    const progress = {
      w0001: rec(3, '2026-11-13'),
      w0002: rec(1, '2026-11-13'),
      w0003: rec(2, '2026-11-10'),
      w0004: rec(0, '2026-11-14'), // 期限前
      w0005: rec(4, '2026-10-31'),
      w0006: rec(5, '2026-11-01', { mastered: true }), // マスター済み
    };
    const menu = buildDailyMenu(words, progress, { date: DATE, newPerDay: 10, newDoneToday: 0 });
    assert.deepEqual(menu.reviews, ['w0005', 'w0003', 'w0002', 'w0001']);
    assert.deepEqual(menu.news, []);
  });

  test('due も box も同じなら id 順', () => {
    const words = [w('w0003', 1), w('w0001', 2), w('w0002', 3)];
    const progress = { w0001: rec(1, DATE), w0002: rec(1, DATE), w0003: rec(1, DATE) };
    const menu = buildDailyMenu(words, progress, { date: DATE, newPerDay: 10, newDoneToday: 0 });
    assert.deepEqual(menu.reviews, ['w0001', 'w0002', 'w0003']);
  });

  test('新規は代表の例文番号の小さい順、同じなら id 順', () => {
    const words = [
      w('w0010', 30),
      w('w0002', 5),
      w('w0003', 5),
      w('w0001', 12),
      w('w0004', 5, { sentenceIds: [5, 1] }), // 代表は 5（2 つ目の 1 は見ない）
      w('w0005', 2),
    ];
    const menu = buildDailyMenu(words, {}, { date: DATE, newPerDay: 10, newDoneToday: 0 });
    assert.deepEqual(menu.news, ['w0005', 'w0002', 'w0003', 'w0004', 'w0001', 'w0010']);
  });

  test('新規の件数は newPerDay − newDoneToday', () => {
    const words = Array.from({ length: 30 }, (_, i) => w(`w${String(i + 1).padStart(4, '0')}`, i + 1));
    const m1 = buildDailyMenu(words, {}, { date: DATE, newPerDay: 10, newDoneToday: 0 });
    assert.equal(m1.news.length, 10);
    assert.deepEqual(m1.news.slice(0, 2), ['w0001', 'w0002']);
    const m2 = buildDailyMenu(words, {}, { date: DATE, newPerDay: 10, newDoneToday: 4 });
    assert.equal(m2.news.length, 6);
    const m3 = buildDailyMenu(words, {}, { date: DATE, newPerDay: 20, newDoneToday: 0 });
    assert.equal(m3.news.length, 20);
  });

  test('新規の件数はマイナスにならない', () => {
    const words = [w('w0001', 1), w('w0002', 2)];
    const m1 = buildDailyMenu(words, {}, { date: DATE, newPerDay: 5, newDoneToday: 5 });
    assert.deepEqual(m1.news, []);
    const m2 = buildDailyMenu(words, {}, { date: DATE, newPerDay: 5, newDoneToday: 8 });
    assert.deepEqual(m2.news, []);
  });

  test('新規の残りが少なければあるだけ出す', () => {
    const words = [w('w0001', 1), w('w0002', 2)];
    const m = buildDailyMenu(words, {}, { date: DATE, newPerDay: 10, newDoneToday: 0 });
    assert.deepEqual(m.news, ['w0001', 'w0002']);
  });

  test('mastered の語は復習にも新規にも出ない', () => {
    const words = [w('w0001', 1), w('w0002', 2)];
    const progress = { w0001: rec(5, '2026-01-01', { mastered: true }) };
    const m = buildDailyMenu(words, progress, { date: DATE, newPerDay: 10, newDoneToday: 0 });
    assert.ok(!m.reviews.includes('w0001'));
    assert.ok(!m.news.includes('w0001'));
    assert.deepEqual(m.news, ['w0002']);
  });

  test('記録のある語（期限前）は新規に出ない', () => {
    const words = [w('w0001', 1), w('w0002', 2)];
    const progress = { w0001: rec(2, '2026-12-01') };
    const m = buildDailyMenu(words, progress, { date: DATE, newPerDay: 10, newDoneToday: 0 });
    assert.deepEqual(m.reviews, []);
    assert.deepEqual(m.news, ['w0002']);
  });

  test('progress にだけある id は無視、sentenceIds の無い語は新規の最後', () => {
    const words = [w('w0001', null), w('w0002', 9)];
    const progress = { w9999: rec(0, '2026-11-01') };
    const m = buildDailyMenu(words, progress, { date: DATE, newPerDay: 10, newDoneToday: 0 });
    assert.deepEqual(m.reviews, []);
    assert.deepEqual(m.news, ['w0002', 'w0001']);
  });

  test('newPerDay を省略すると 10 件', () => {
    const words = Array.from({ length: 15 }, (_, i) => w(`w${String(i + 1).padStart(4, '0')}`, i + 1));
    const m = buildDailyMenu(words, {}, { date: DATE });
    assert.equal(m.news.length, 10);
  });

  test('入力の words と progress を書き換えない', () => {
    const words = deepFreeze([w('w0002', 2), w('w0001', 1), w('w0003', 3)]);
    const progress = deepFreeze({ w0003: rec(1, '2026-11-01') });
    const m = buildDailyMenu(words, progress, { date: DATE, newPerDay: 10, newDoneToday: 0 });
    assert.deepEqual(m.news, ['w0001', 'w0002']);
    assert.deepEqual(m.reviews, ['w0003']);
    assert.deepEqual(words.map((x) => x.id), ['w0002', 'w0001', 'w0003']);
  });
});

// ---------------------------------------------------------------------------
// stageOf / stageSummary
// ---------------------------------------------------------------------------

describe('stageOf', () => {
  test('50 文ごとの境目', () => {
    assert.equal(stageOf(1), 1);
    assert.equal(stageOf(50), 1);
    assert.equal(stageOf(51), 2);
    assert.equal(stageOf(100), 2);
    assert.equal(stageOf(101), 3);
    assert.equal(stageOf(550), 11);
    assert.equal(stageOf(551), 12);
    assert.equal(stageOf(562), 12);
  });
  test('無効な番号は 0', () => {
    assert.equal(stageOf(0), 0);
    assert.equal(stageOf(-5), 0);
    assert.equal(stageOf(1.5), 0);
    assert.equal(stageOf(undefined), 0);
    assert.equal(stageOf('10'), 0);
  });
});

describe('stageSummary', () => {
  test('562 文（1 文 1 語）で 12 ステージ、from / to / total', () => {
    const words = Array.from({ length: 562 }, (_, i) => w(`w${String(i + 1).padStart(4, '0')}`, i + 1));
    const s = stageSummary(words, {});
    assert.equal(s.length, 12);
    assert.deepEqual(s.map((r) => r.stage), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    assert.deepEqual(s[0], { stage: 1, from: 1, to: 50, total: 50, learned: 0, mastered: 0, rate: 0 });
    assert.equal(s[1].from, 51);
    assert.equal(s[1].to, 100);
    assert.equal(s[11].from, 551);
    assert.equal(s[11].to, 562);
    assert.equal(s[11].total, 12);
    assert.equal(s.reduce((a, r) => a + r.total, 0), 562);
  });

  test('境目：例文 50 の語はステージ1、51 の語はステージ2', () => {
    const words = [w('w0001', 50), w('w0002', 51)];
    const s = stageSummary(words, {});
    assert.equal(s.length, 2);
    assert.equal(s[0].total, 1);
    assert.equal(s[1].total, 1);
    assert.equal(s[0].to, 50);
    assert.equal(s[1].from, 51);
    assert.equal(s[1].to, 51);
  });

  test('learned（box >= 3 または mastered）と mastered と rate', () => {
    const words = [
      w('w0001', 1), // 記録なし
      w('w0002', 2), // box 2 → 覚えていない
      w('w0003', 3), // box 3 → learned
      w('w0004', 4), // box 5 → learned
      w('w0005', 5), // mastered → learned + mastered
      w('w0006', 60), // ステージ2：box 4 → learned
      w('w0007', 61), // ステージ2：box 0
    ];
    const progress = {
      w0002: rec(2, '2026-11-20'),
      w0003: rec(3, '2026-11-20'),
      w0004: rec(5, '2026-11-20'),
      w0005: rec(5, '2026-12-20', { mastered: true }),
      w0006: rec(4, '2026-11-20'),
      w0007: rec(0, '2026-11-13'),
    };
    const s = stageSummary(words, progress);
    assert.equal(s.length, 2);
    assert.equal(s[0].total, 5);
    assert.equal(s[0].learned, 3);
    assert.equal(s[0].mastered, 1);
    assert.equal(s[0].rate, 3 / 5);
    assert.equal(s[1].total, 2);
    assert.equal(s[1].learned, 1);
    assert.equal(s[1].mastered, 0);
    assert.equal(s[1].rate, 0.5);
  });

  test('ステージは代表の例文で決め、2 つ目以降の例文は数えない', () => {
    const words = [w('w0001', 10, { sentenceIds: [10, 120] })];
    const s = stageSummary(words, {});
    assert.equal(s.length, 1);
    assert.equal(s[0].total, 1);
    assert.equal(s[0].to, 50);
  });

  test('語の無いステージは total 0・rate 0 で含める', () => {
    const words = [w('w0001', 1), w('w0002', 120)];
    const s = stageSummary(words, { w0001: rec(3, '2026-11-20') });
    assert.equal(s.length, 3);
    assert.deepEqual(s[1], { stage: 2, from: 51, to: 100, total: 0, learned: 0, mastered: 0, rate: 0 });
    assert.equal(s[0].rate, 1);
    assert.equal(s[2].to, 120);
  });

  test('語が無ければ空配列。代表の例文が無効な語は数えない', () => {
    assert.deepEqual(stageSummary([], {}), []);
    assert.deepEqual(stageSummary([w('w0001', null)], {}), []);
  });

  test('入力を書き換えない', () => {
    const words = deepFreeze([w('w0001', 1)]);
    const progress = deepFreeze({ w0001: rec(3, '2026-11-20') });
    const s = stageSummary(words, progress);
    assert.equal(s[0].learned, 1);
  });
});

// ---------------------------------------------------------------------------
// 本の番号（bookNo）と例文にない語（ダミーデータ）
// ---------------------------------------------------------------------------

describe('bookNoOf / isNoSentenceWord / relatedSentenceId / stageSentenceId', () => {
  test('bookNoOf：1 以上の整数だけ。数字だけの文字列も読む', () => {
    assert.equal(bookNoOf(w('w0001', 1, { bookNo: 87 })), 87);
    assert.equal(bookNoOf(w('w0001', 1, { bookNo: '87' })), 87);
    assert.equal(bookNoOf(w('w0001', 1)), null);
    assert.equal(bookNoOf(w('w0001', 1, { bookNo: 0 })), null);
    assert.equal(bookNoOf(w('w0001', 1, { bookNo: 1.5 })), null);
    assert.equal(bookNoOf(w('w0001', 1, { bookNo: 'No.87' })), null);
    assert.equal(bookNoOf(null), null);
  });

  test('isNoSentenceWord：sentenceIds が空・無い語', () => {
    assert.equal(isNoSentenceWord(w('w0001', null)), true);
    assert.equal(isNoSentenceWord({ id: 'w0001' }), true);
    assert.equal(isNoSentenceWord(w('w0001', 3)), false);
  });

  test('relatedSentenceId・stageSentenceId', () => {
    const noSent = w('w0001', null, { relatedSentenceIds: [120, 5] });
    assert.equal(relatedSentenceId(noSent), 120);
    assert.equal(stageSentenceId(noSent), 120);
    assert.equal(stageSentenceId(w('w0002', 7, { relatedSentenceIds: [300] })), 7); // 例文がある語は代表の例文
    assert.equal(stageSentenceId(w('w0003', null)), null);
    assert.equal(stageSentenceId(w('w0004', null, { relatedSentenceIds: [] })), null);
    assert.equal(relatedSentenceId(w('w0005', null, { relatedSentenceIds: ['x', 0, 9] })), 9);
  });
});

describe('orderNewWords / buildDailyMenu（本の番号順）', () => {
  const DATE = '2026-11-13';

  test('bookNo の無いデータでは今までどおり（例文番号順 → id 順、例文の無い語は最後）', () => {
    const words = [w('w0003', 5), w('w0001', null), w('w0002', 5), w('w0004', 2)];
    assert.deepEqual(orderNewWords(words), ['w0004', 'w0002', 'w0003', 'w0001']);
  });

  test('bookNo のある語は bookNo の小さい順（例文番号の順ではない）', () => {
    const words = [
      w('w0001', 1, { bookNo: 3 }),
      w('w0002', 2, { bookNo: 1 }),
      w('w0003', null, { bookNo: 2, relatedSentenceIds: [9] }), // 例文にない語も本の順
    ];
    assert.deepEqual(orderNewWords(words), ['w0002', 'w0003', 'w0001']);
    const m = buildDailyMenu(words, {}, { date: DATE, newPerDay: 10, newDoneToday: 0 });
    assert.deepEqual(m.news, ['w0002', 'w0003', 'w0001']);
  });

  test('混在：bookNo の無い語は、その例文の bookNo のある語のうち最小の bookNo の直後', () => {
    const words = [
      w('w0001', 10, { bookNo: 20 }),
      w('w0002', 10, { bookNo: 15 }),
      w('w0003', 10),                      // 例文 10 → 最小 15 の直後
      w('w0004', 3, { bookNo: 16 }),
      w('w0005', 3),                       // 例文 3 → 16 の直後
      w('w0006', 10),                      // 例文 10 → 15 の直後（w0003 と同じ位置なので id 順）
      w('w0007', 8),                       // 例文 8 に bookNo の語がいない → 例文 8 以前の最大の bookNo（30）の直後
      w('w0008', null),                    // 例文も bookNo も無い → 最後
      w('w0009', 4),                       // 例文 4 にもいない → 例文 4 以前の最大の bookNo（30）の直後
      w('w0010', 1, { bookNo: 30, sentenceIds: [1, 12] }),
      w('w0011', 12),                      // 例文 12 には w0010 が 2 つ目の例文として出てくる → 30 の直後
    ];
    // 30 の直後の語どうしは例文番号順（4 → 8 → 12）
    assert.deepEqual(orderNewWords(words),
      ['w0002', 'w0003', 'w0006', 'w0004', 'w0005', 'w0001', 'w0010', 'w0009', 'w0007', 'w0011', 'w0008']);
  });

  test('番号の入力が途中でも、番号のない語は例文の順を保つ', () => {
    const words = [
      w('w0001', 1), w('w0002', 2, { bookNo: 5 }), w('w0003', 3), w('w0004', 4), w('w0005', 5, { bookNo: 9 }), w('w0006', 6),
    ];
    // 番号のある語は 2 つだけでも、全体はおおむね例文の順のまま
    assert.deepEqual(orderNewWords(words), ['w0001', 'w0002', 'w0003', 'w0004', 'w0005', 'w0006']);
  });

  test('よりどころの語が学習済みでも、その直後の位置に出す', () => {
    const words = [
      w('w0001', 1, { bookNo: 1 }),
      w('w0002', 2, { bookNo: 2 }),
      w('w0003', 2),                       // 2 の直後
      w('w0004', 3, { bookNo: 3 }),
    ];
    const progress = { w0002: rec(1, '2026-11-20') };
    const m = buildDailyMenu(words, progress, { date: DATE, newPerDay: 10, newDoneToday: 0 });
    assert.deepEqual(m.news, ['w0001', 'w0003', 'w0004']);
    const m2 = buildDailyMenu(words, progress, { date: DATE, newPerDay: 2, newDoneToday: 0 });
    assert.deepEqual(m2.news, ['w0001', 'w0003']);
  });

  test('同じ bookNo は id 順。重複した id は 1 回だけ。入力を書き換えない', () => {
    const words = deepFreeze([
      w('w0002', 1, { bookNo: 5 }),
      w('w0001', 2, { bookNo: 5 }),
      w('w0002', 1, { bookNo: 5 }),
    ]);
    assert.deepEqual(orderNewWords(words), ['w0001', 'w0002']);
    assert.deepEqual(orderNewWords(null), []);
  });
});

describe('stageSummary（例文にない語）', () => {
  test('sentenceIds が空の語は relatedSentenceIds[0] でステージを決める。どちらも無い語は数えない', () => {
    const words = [
      w('w0001', 1),
      w('w0002', null, { relatedSentenceIds: [60, 2] }), // ステージ 2
      w('w0003', null),                                  // 数えない
      w('w0004', null, { relatedSentenceIds: [] }),       // 数えない
    ];
    const s = stageSummary(words, { w0002: rec(3, '2026-11-20') });
    assert.equal(s.length, 2);
    assert.equal(s[0].total, 1);
    assert.equal(s[1].total, 1);
    assert.equal(s[1].learned, 1);
    assert.equal(s[1].to, 60);
    assert.equal(s.reduce((a, r) => a + r.total, 0), 2);
  });

  test('例文がある語は relatedSentenceIds があっても代表の例文で決める', () => {
    const s = stageSummary([w('w0001', 5, { relatedSentenceIds: [200] })], {});
    assert.equal(s.length, 1);
    assert.equal(s[0].total, 1);
  });
});
