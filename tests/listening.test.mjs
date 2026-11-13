// listening.js の DOM を使わない部分のテスト（node --test tests/listening.test.mjs）
// データはすべて自作のダミー（教材の文章は使わない）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LISTENING_KEY,
  DEFAULT_LISTENING_SETTINGS,
  SEG_PAD,
  listStages,
  idBounds,
  clampIdRange,
  normalizeSettings,
  loadListeningSettings,
  saveListeningSettings,
  selectRange,
  segmentFor,
  playableList,
  nextStep,
  moveIndex,
  estimateSeconds,
  formatDuration,
} from '../js/modes/listening.js';

// ダミーの例文（id 1〜120）。seg は 1 文 10 秒の作り
function dummy(id, seg = undefined) {
  return {
    id,
    file: `dummy_${String(id).padStart(4, '0')}.mp3`,
    en: `Dummy sentence ${id}.`,
    ja: `ダミー文 ${id}`,
    seg: seg === undefined ? { en1: [0.5, 2.5], ja: [3, 5], en2: [5.5, 7.5], en3: [8, 10] } : seg,
  };
}
const SENTENCES = Array.from({ length: 120 }, (_, i) => dummy(i + 1));

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≒ ${b}`);

// ---------- 範囲 ----------

test('listStages：50 文ごとのステージと、実際にある番号の範囲', () => {
  const st = listStages(SENTENCES);
  assert.deepEqual(st, [
    { stage: 1, from: 1, to: 50, count: 50 },
    { stage: 2, from: 51, to: 100, count: 50 },
    { stage: 3, from: 101, to: 120, count: 20 },
  ]);
});

test('listStages：順番がばらばら・不正な id があっても番号順で、不正なものは数えない', () => {
  const st = listStages([dummy(60), dummy(3), { id: 0 }, { id: 'x' }, null, dummy(51)]);
  assert.deepEqual(st, [
    { stage: 1, from: 3, to: 3, count: 1 },
    { stage: 2, from: 51, to: 60, count: 2 },
  ]);
  assert.deepEqual(listStages([]), []);
  assert.deepEqual(listStages(undefined), []);
});

test('idBounds：最小と最大。空なら null', () => {
  assert.deepEqual(idBounds(SENTENCES), { min: 1, max: 120 });
  assert.equal(idBounds([]), null);
});

test('clampIdRange：範囲外は端に寄せ、逆なら入れ替え、数字でなければ端', () => {
  assert.deepEqual(clampIdRange(10, 20, SENTENCES), { from: 10, to: 20 });
  assert.deepEqual(clampIdRange(-5, 999, SENTENCES), { from: 1, to: 120 });
  assert.deepEqual(clampIdRange(30, 5, SENTENCES), { from: 5, to: 30 });
  assert.deepEqual(clampIdRange('', 'abc', SENTENCES), { from: 1, to: 120 });
  assert.deepEqual(clampIdRange('7', '8.9', SENTENCES), { from: 7, to: 8 });
  assert.equal(clampIdRange(1, 2, []), null);
});

test('selectRange：ステージで選ぶ', () => {
  const list = selectRange(SENTENCES, { ...DEFAULT_LISTENING_SETTINGS, rangeKind: 'stage', stage: 3 });
  assert.equal(list.length, 20);
  assert.equal(list[0].id, 101);
  assert.equal(list.at(-1).id, 120);
});

test('selectRange：番号で選ぶ（両端を含む、逆でもよい、番号順に並べる）', () => {
  const shuffled = [...SENTENCES].reverse();
  const a = selectRange(shuffled, { ...DEFAULT_LISTENING_SETTINGS, rangeKind: 'ids', from: 45, to: 55 });
  assert.deepEqual(a.map((s) => s.id), [45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55]);
  const b = selectRange(SENTENCES, { ...DEFAULT_LISTENING_SETTINGS, rangeKind: 'ids', from: 3, to: 1 });
  assert.deepEqual(b.map((s) => s.id), [1, 2, 3]);
});

// ---------- 区間 ----------

test('segmentFor：英語のみ・日本語のみ・全体（前後に余白）', () => {
  const s = dummy(1);
  assert.deepEqual(segmentFor(s, 'en'), [0.5 - SEG_PAD, 2.5 + SEG_PAD]);
  assert.deepEqual(segmentFor(s, 'ja'), [3 - SEG_PAD, 5 + SEG_PAD]);
  assert.deepEqual(segmentFor(s, 'all'), [0.5 - SEG_PAD, 10 + SEG_PAD]);
});

test('segmentFor：開始は 0 秒より前にしない', () => {
  const s = dummy(2, { en1: [0.02, 1], ja: [1.5, 2], en2: [2.5, 3], en3: [3.5, 4] });
  assert.equal(segmentFor(s, 'en')[0], 0);
});

test('segmentFor：区間の不備・ファイルなしは null。全体は使える区間だけで作る', () => {
  assert.equal(segmentFor(dummy(3, null), 'en'), null);
  assert.equal(segmentFor(dummy(4, { ja: [1, 2] }), 'en'), null);
  assert.equal(segmentFor(dummy(5, { en1: [3, 2] }), 'en'), null);          // 終わりが前
  assert.equal(segmentFor(dummy(6, { en1: ['a', 2] }), 'en'), null);        // 数字でない
  assert.equal(segmentFor({ ...dummy(7), file: '' }, 'en'), null);
  assert.equal(segmentFor(dummy(8), 'xx'), null);
  assert.deepEqual(segmentFor(dummy(9, { en1: [1, 2], ja: null, en3: [6, 7] }), 'all'), [1 - SEG_PAD, 7 + SEG_PAD]);
  assert.equal(segmentFor(dummy(10, {}), 'all'), null);
});

test('playableList：再生できる例文だけ残す', () => {
  const list = [dummy(1), dummy(2, { ja: [1, 2] }), dummy(3, null)];
  assert.deepEqual(playableList(list, 'en').map((s) => s.id), [1]);
  assert.deepEqual(playableList(list, 'ja').map((s) => s.id), [1, 2]);
  assert.deepEqual(playableList(list, 'all').map((s) => s.id), [1, 2]);
});

// ---------- 進み方 ----------

test('nextStep：くり返し → 次の文 → 最後で止まる', () => {
  const opt = { count: 3, repeat: 2, loop: false };
  assert.deepEqual(nextStep({ index: 0, rep: 0 }, opt), { index: 0, rep: 1 });
  assert.deepEqual(nextStep({ index: 0, rep: 1 }, opt), { index: 1, rep: 0 });
  assert.deepEqual(nextStep({ index: 2, rep: 0 }, opt), { index: 2, rep: 1 });
  assert.equal(nextStep({ index: 2, rep: 1 }, opt), null);
});

test('nextStep：ループのときは最初に戻る。件数 0 なら null', () => {
  assert.deepEqual(nextStep({ index: 2, rep: 0 }, { count: 3, repeat: 1, loop: true }), { index: 0, rep: 0 });
  assert.deepEqual(nextStep({ index: 0, rep: 0 }, { count: 1, repeat: 1, loop: true }), { index: 0, rep: 0 });
  assert.equal(nextStep({ index: 0, rep: 0 }, { count: 0, repeat: 1, loop: true }), null);
});

test('moveIndex：端で止まる／ループなら反対側へ', () => {
  assert.equal(moveIndex(0, -1, 5, false), 0);
  assert.equal(moveIndex(4, 1, 5, false), 4);
  assert.equal(moveIndex(2, 1, 5, false), 3);
  assert.equal(moveIndex(0, -1, 5, true), 4);
  assert.equal(moveIndex(4, 1, 5, true), 0);
  assert.equal(moveIndex(0, 1, 0, true), 0);
});

test('estimateSeconds / formatDuration：だいたいの時間', () => {
  const list = [dummy(1), dummy(2)];
  // 英語：区間 2 秒＋余白 0.2 秒、間 1 秒、2 回ずつ、2 文
  near(estimateSeconds(list, 'en', 2, 1), (2 + 2 * SEG_PAD + 1) * 2 * 2);
  assert.equal(estimateSeconds([dummy(3, null)], 'en', 1, 1), 0);
  assert.equal(formatDuration(0), '0 分');
  assert.equal(formatDuration(30), '1 分未満');
  assert.equal(formatDuration(150), '約 3 分');
});

// ---------- 設定 ----------

test('normalizeSettings：壊れた値は既定値に戻す', () => {
  assert.deepEqual(normalizeSettings(null), { ...DEFAULT_LISTENING_SETTINGS });
  assert.deepEqual(normalizeSettings([1, 2]), { ...DEFAULT_LISTENING_SETTINGS });
  const s = normalizeSettings({
    rangeKind: 'zzz', stage: -1, from: 'a', to: 2.5, mode: 'fr', gap: 3, repeat: 5, loop: 'yes',
  });
  assert.deepEqual(s, { ...DEFAULT_LISTENING_SETTINGS });
});

test('normalizeSettings：正しい値はそのまま（文字列の数字も受け付ける）', () => {
  const s = normalizeSettings({
    rangeKind: 'ids', stage: 2, from: '20', to: 10, mode: 'all', gap: '0.5', repeat: 3, loop: true,
  });
  assert.deepEqual(s, { rangeKind: 'ids', stage: 2, from: 10, to: 20, mode: 'all', gap: 0.5, repeat: 3, loop: true });
});

test('normalizeSettings：例文を渡すと、無いステージは最初のステージに、番号は範囲内に寄せる', () => {
  const s = normalizeSettings({ rangeKind: 'stage', stage: 9, from: 100, to: 500 }, SENTENCES);
  assert.equal(s.stage, 1);
  assert.equal(s.from, 100);
  assert.equal(s.to, 120);
});

test('保存と読み込み：同じ値が戻る。キーは kk.listening.v1', () => {
  const storage = new MemoryStorage();
  const want = { rangeKind: 'ids', stage: 2, from: 5, to: 15, mode: 'ja', gap: 2, repeat: 2, loop: true };
  assert.equal(saveListeningSettings(want, storage), true);
  assert.ok(storage.getItem(LISTENING_KEY));
  assert.equal(LISTENING_KEY, 'kk.listening.v1');
  assert.deepEqual(loadListeningSettings(storage), want);
});

test('読み込み：何もない・壊れた JSON は既定値', () => {
  const storage = new MemoryStorage();
  assert.deepEqual(loadListeningSettings(storage), { ...DEFAULT_LISTENING_SETTINGS });
  storage.setItem(LISTENING_KEY, '{こわれた');
  assert.deepEqual(loadListeningSettings(storage), { ...DEFAULT_LISTENING_SETTINGS });
});

test('使えない環境（例外・storage なし）でも止まらない', () => {
  const broken = {
    getItem() { throw new Error('使えません'); },
    setItem() { throw new Error('容量不足'); },
    removeItem() {},
  };
  assert.deepEqual(loadListeningSettings(broken), { ...DEFAULT_LISTENING_SETTINGS });
  assert.equal(saveListeningSettings(DEFAULT_LISTENING_SETTINGS, broken), false);
  assert.deepEqual(loadListeningSettings(null), { ...DEFAULT_LISTENING_SETTINGS });
  assert.equal(saveListeningSettings(DEFAULT_LISTENING_SETTINGS, null), false);
  // node には localStorage が無い（または使えない）が、既定の引数でも例外にならない
  assert.doesNotThrow(() => loadListeningSettings());
  assert.doesNotThrow(() => saveListeningSettings(DEFAULT_LISTENING_SETTINGS));
});

test('既定値の物は書き換えられない（読み込み結果は毎回新しい物）', () => {
  const a = loadListeningSettings(null);
  a.mode = 'ja';
  assert.equal(DEFAULT_LISTENING_SETTINGS.mode, 'en');
  assert.equal(loadListeningSettings(null).mode, 'en');
});
