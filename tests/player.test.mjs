// js/player.js のテスト（node --test tests/player.test.mjs）
// データはすべて自作のダミー（教材の文章は使わない）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRESETS,
  DEFAULT_SETTINGS,
  SECTION_SIZES,
  MYLISTEN_KEY,
  normalizeSettings,
  numberWords,
  sectionOf,
  sectionRange,
  buildPlaylist,
  resolveSteps,
  createPlayer,
  loadMyListen,
  saveMyListen,
  speakableEn,
} from '../js/player.js';

// ---------- ダミーデータ ----------

/** ダミー語。i 番目の語は例文 i を代表の例文に持つ（noSentence なら例文なし） */
function dummyWord(i, { noSentence = false, bookNo } = {}) {
  const w = {
    id: `w${String(i).padStart(4, '0')}`,
    word: `dummyword${i}`,
    meaning: `ダミー意味${i}`,
    sentenceIds: noSentence ? [] : [i],
  };
  if (bookNo !== undefined) w.bookNo = bookNo;
  return w;
}

function dummySentence(id, seg = { en1: [0.5, 2.5], ja: [3, 5], en2: [5.5, 7.5], en3: [8, 10] }) {
  return { id, file: `dummy_${id}.mp3`, en: `Dummy sentence ${id}.`, ja: `ダミー文${id}`, seg };
}

/** No.1〜n の items（Map）を作る。noSentenceNos の No. は例文なし */
function makeItems(n, { noSentenceNos = [], segOverride = {} } = {}) {
  const items = new Map();
  for (let no = 1; no <= n; no++) {
    const noSentence = noSentenceNos.includes(no);
    const word = dummyWord(no, { noSentence });
    const sentence = noSentence ? null : dummySentence(no, segOverride[no]);
    items.set(no, { word, sentence });
  }
  return items;
}

/** 固定の乱数（線形合同法） */
function seededRng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

// ---------- 偽の drivers ----------

/**
 * 呼ばれた順を log に記録する偽の drivers。
 * mode：'immediate'（すぐ解決）| 'delay'（delayMs 後に解決）| 'fail'（reject）
 * failIf(name, args) が true の呼び出しは失敗させる。cancel は待っている呼び出しをすぐ解決する
 * （古いループが「終わった」と思って進もうとする、いちばん厳しい場合を作る）。
 */
function fakeDrivers({ mode = 'immediate', delayMs = 5, failIf = null } = {}) {
  const log = [];
  const pending = new Set();
  let cancels = 0;
  function make(name) {
    return (...args) => {
      log.push({ name, args });
      if (mode === 'fail' || (failIf && failIf(name, args))) {
        return Promise.reject(new Error(`${name} failed`));
      }
      if (mode === 'immediate') return Promise.resolve();
      return new Promise((resolve) => {
        const entry = { resolve };
        entry.timer = setTimeout(() => { pending.delete(entry); resolve(); }, delayMs);
        pending.add(entry);
      });
    };
  }
  return {
    log,
    get cancels() { return cancels; },
    setMode(m) { mode = m; },
    drivers: {
      speak: make('speak'),
      playSegment: make('playSegment'),
      wait: make('wait'),
      cancel() {
        cancels += 1;
        log.push({ name: 'cancel', args: [] });
        for (const e of pending) { clearTimeout(e.timer); e.resolve(); }
        pending.clear();
      },
    },
  };
}

/** 条件が成り立つまで待つ（タイマーを回しながら） */
async function until(pred, timeoutMs = 2000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('待ち時間切れ');
    await new Promise((r) => setTimeout(r, 1));
  }
}

/** log を「名前:主な引数」の文字列にする（cancel は除く） */
function calls(log) {
  return log.filter((c) => c.name !== 'cancel').map((c) => {
    if (c.name === 'speak') return `speak:${c.args[0]}:${c.args[1]}`;
    if (c.name === 'playSegment') return `seg:${c.args[0]}:${c.args[1]}-${c.args[2]}`;
    return `wait:${c.args[0]}`;
  });
}

function settingsWith(over = {}) {
  return normalizeSettings({ ...DEFAULT_SETTINGS, ...over });
}

// =====================================================================
// 設定
// =====================================================================

test('normalizeSettings：既定値と範囲外の補正', () => {
  assert.deepEqual(normalizeSettings(null), { ...DEFAULT_SETTINGS, range: { kind: 'all' } });
  const s = normalizeSettings({
    presetId: 'nope', sectionSize: 40, gapThink: -1, gapNext: 99, rate: 3,
    speakJa: 'yes', repeat: 'x', shuffle: 1, range: { kind: 'nos', from: 30, to: 10 },
  });
  assert.equal(s.presetId, 'ja-en-sentence');
  assert.equal(s.sectionSize, 50);
  assert.equal(s.gapThink, 0);
  assert.equal(s.gapNext, 10);
  assert.equal(s.rate, 1.5);
  assert.equal(s.speakJa, true);
  assert.equal(s.repeat, 'off');
  assert.equal(s.shuffle, false);
  assert.deepEqual(s.range, { kind: 'nos', from: 10, to: 30 });
  assert.equal(normalizeSettings({ rate: 0.1 }).rate, 0.75);
  assert.deepEqual(normalizeSettings({ range: { kind: 'section', section: 0 } }).range, { kind: 'section', section: 1 });
  assert.deepEqual(normalizeSettings({ range: { kind: 'nos', from: 'a', to: 3 } }).range, { kind: 'all' });
  assert.deepEqual(normalizeSettings({ range: { kind: 'zzz' } }).range, { kind: 'all' });
});

test('SECTION_SIZES：20 / 30 / 50 / 100 / 150 / 200 を受け付け、それ以外は 50', () => {
  assert.deepEqual([...SECTION_SIZES], [20, 30, 50, 100, 150, 200]);
  for (const n of SECTION_SIZES) assert.equal(normalizeSettings({ sectionSize: n }).sectionSize, n);
  assert.equal(normalizeSettings({ sectionSize: '150' }).sectionSize, 150);
  for (const n of [0, 10, 25, 120, 250, 'x']) assert.equal(normalizeSettings({ sectionSize: n }).sectionSize, 50);
});

test('speakableEn："..." や "～" は読まない', () => {
  assert.equal(speakableEn('dummy ... word'), 'dummy word');
  assert.equal(speakableEn('～ dummy'), 'dummy');
  assert.equal(speakableEn('dummy… x~y〜'), 'dummy x y');
});

// =====================================================================
// 番号・Section
// =====================================================================

test('numberWords：orderNewWords の順に No.1〜', () => {
  const words = [dummyWord(3, { bookNo: 2 }), dummyWord(1, { bookNo: 3 }), dummyWord(2, { bookNo: 1 })];
  const n = numberWords(words);
  assert.deepEqual(n.map((x) => x.no), [1, 2, 3]);
  assert.deepEqual(n.map((x) => x.word.id), ['w0002', 'w0003', 'w0001']);
  assert.deepEqual(numberWords(null), []);
});

test('sectionOf：端の No.', () => {
  assert.equal(sectionOf(1, 50), 1);
  assert.equal(sectionOf(50, 50), 1);
  assert.equal(sectionOf(51, 50), 2);
  assert.equal(sectionOf(150, 150), 1);
  assert.equal(sectionOf(151, 150), 2);
  assert.equal(sectionOf(200, 200), 1);
  assert.equal(sectionOf(201, 200), 2);
  assert.equal(sectionOf(0, 50), 1);
});

test('sectionRange：端と、最後の Section が N 未満', () => {
  assert.deepEqual(sectionRange(1, 50, 120), { from: 1, to: 50 });
  assert.deepEqual(sectionRange(2, 50, 120), { from: 51, to: 100 });
  assert.deepEqual(sectionRange(3, 50, 120), { from: 101, to: 120 });
  assert.deepEqual(sectionRange(9, 50, 120), { from: 101, to: 120 }); // 最後に丸める
  assert.deepEqual(sectionRange(0, 50, 120), { from: 1, to: 50 });
  assert.deepEqual(sectionRange(2, 150, 320), { from: 151, to: 300 });
  assert.deepEqual(sectionRange(3, 150, 320), { from: 301, to: 320 });
  assert.deepEqual(sectionRange(2, 200, 320), { from: 201, to: 320 });
  assert.deepEqual(sectionRange(1, 50, 0), { from: 1, to: 0 });
});

// =====================================================================
// buildPlaylist
// =====================================================================

const NUMBERED = Array.from({ length: 120 }, (_, i) => ({ no: i + 1, word: dummyWord(i + 1) }));

test('buildPlaylist：all / section / nos / notyet', () => {
  assert.equal(buildPlaylist(NUMBERED, settingsWith(), {}).length, 120);
  assert.deepEqual(
    buildPlaylist(NUMBERED, settingsWith({ range: { kind: 'section', section: 3 } }), {}),
    Array.from({ length: 20 }, (_, i) => 101 + i));
  assert.deepEqual(
    buildPlaylist(NUMBERED, settingsWith({ sectionSize: 20, range: { kind: 'section', section: 2 } }), {}),
    Array.from({ length: 20 }, (_, i) => 21 + i));
  assert.deepEqual(buildPlaylist(NUMBERED, settingsWith({ range: { kind: 'nos', from: 5, to: 8 } }), {}), [5, 6, 7, 8]);
  assert.deepEqual(buildPlaylist(NUMBERED, settingsWith({ range: { kind: 'nos', from: 118, to: 999 } }), {}), [118, 119, 120]);
  const marks = { w0003: 'notyet', w0010: 'known', w0007: 'notyet' };
  assert.deepEqual(buildPlaylist(NUMBERED, settingsWith({ range: { kind: 'notyet' } }), marks), [3, 7]);
  assert.deepEqual(buildPlaylist(NUMBERED, settingsWith({ range: { kind: 'notyet' } }), undefined), []);
});

test('buildPlaylist：startNo（範囲内はそこから最後まで、範囲外は先頭から）', () => {
  const s = settingsWith({ range: { kind: 'section', section: 2 } });
  const pl = buildPlaylist(NUMBERED, s, {}, { startNo: 95 });
  assert.deepEqual(pl, [95, 96, 97, 98, 99, 100]);
  const out = buildPlaylist(NUMBERED, s, {}, { startNo: 5 });
  assert.equal(out[0], 51);
  assert.equal(out.length, 50);
});

test('buildPlaylist：shuffle は startNo が先頭・全部含む・rng 固定で同じ', () => {
  const s = settingsWith({ shuffle: true, range: { kind: 'section', section: 1 } });
  const a = buildPlaylist(NUMBERED, s, {}, { startNo: 10, rng: seededRng(7) });
  const b = buildPlaylist(NUMBERED, s, {}, { startNo: 10, rng: seededRng(7) });
  assert.equal(a[0], 10);
  assert.deepEqual([...a].sort((x, y) => x - y), Array.from({ length: 50 }, (_, i) => i + 1));
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.slice(1), Array.from({ length: 50 }, (_, i) => i + 1).filter((n) => n !== 10));
  // startNo が範囲外なら範囲全体をシャッフル
  const c = buildPlaylist(NUMBERED, s, {}, { startNo: 99, rng: seededRng(3) });
  assert.equal(c.length, 50);
  assert.deepEqual([...c].sort((x, y) => x - y), Array.from({ length: 50 }, (_, i) => i + 1));
});

// =====================================================================
// resolveSteps
// =====================================================================

test('resolveSteps：when の設定と sec の解決', () => {
  const w = dummyWord(1);
  const sen = dummySentence(1);
  const types = (steps) => steps.map((x) => x.type);
  const def = resolveSteps(PRESETS[0], settingsWith(), w, sen);
  assert.deepEqual(types(def), ['showJa', 'speakJa', 'wait', 'showEn', 'speakEn',
    'showSentence', 'playSentence', 'showSentenceJa', 'wait']);
  assert.equal(def[2].sec, 2);
  assert.equal(def[8].sec, 1.5);
  const s2 = settingsWith({ speakJa: false, speakSentenceJa: true, gapThink: 0, gapNext: 4 });
  const r2 = resolveSteps('ja-en-sentence', s2, w, sen);
  assert.ok(!types(r2).includes('speakJa'));
  assert.ok(types(r2).includes('speakSentenceJa'));
  assert.equal(r2.find((x) => x.type === 'wait').sec, 0);
  assert.equal(r2.at(-1).sec, 4);
  // 数の sec はそのまま
  const custom = { id: 'c', name: 'c', steps: [{ type: 'speakEn' }, { type: 'wait', sec: 3 }] };
  assert.deepEqual(resolveSteps(custom, settingsWith(), w, sen), [{ type: 'speakEn' }, { type: 'wait', sec: 3 }]);
});

test('resolveSteps：例文の無い語では例文系のステップが消える', () => {
  const w = dummyWord(1, { noSentence: true });
  const r = resolveSteps(PRESETS[0], settingsWith({ speakSentenceJa: true }), w, null);
  assert.deepEqual(r.map((x) => x.type), ['showJa', 'speakJa', 'wait', 'showEn', 'speakEn', 'wait']);
  // 例文のみのパターンでは何も残らない（その語は飛ばす）
  assert.deepEqual(resolveSteps('sentence-only', settingsWith(), w, null), []);
  // sentenceIds はあっても例文が渡されなければ同じ
  assert.deepEqual(resolveSteps('sentence-only', settingsWith(), dummyWord(2), null), []);
});

// =====================================================================
// プレイヤー
// =====================================================================

function setup({ n = 3, preset = 'ja-en-sentence', settings = {}, drv = {}, items, rng } = {}) {
  const f = fakeDrivers(drv);
  const states = [];
  const player = createPlayer({ drivers: f.drivers, onState: (s) => states.push(s), rng });
  const it = items || makeItems(n);
  const pl = Array.from({ length: n }, (_, i) => i + 1);
  player.load(pl, it, preset, settingsWith(settings));
  return { f, player, states };
}

test('プレイヤー：日→英→例文のステップが順に呼ばれ、最後で ended', async () => {
  const { f, player, states } = setup({ n: 2, settings: { speakSentenceJa: true } });
  player.play();
  await until(() => player.getState().status === 'ended');
  assert.deepEqual(calls(f.log), [
    'speak:ダミー意味1:ja-JP', 'wait:2000', 'speak:dummyword1:en-US', 'seg:dummy_1.mp3:0.5-2.5',
    'seg:dummy_1.mp3:3-5', 'wait:1500',
    'speak:ダミー意味2:ja-JP', 'wait:2000', 'speak:dummyword2:en-US', 'seg:dummy_2.mp3:0.5-2.5',
    'seg:dummy_2.mp3:3-5', 'wait:1500',
  ]);
  const st = player.getState();
  assert.equal(st.index, 1);
  assert.equal(st.no, 2);
  assert.equal(st.total, 2);
  assert.deepEqual([...st.shown].sort(), ['showEn', 'showJa', 'showSentence', 'showSentenceJa']);
  assert.ok(states.some((s) => s.status === 'playing'));
});

test('プレイヤー：英→日・単語のみ・例文のみ', async () => {
  const cases = [
    ['en-ja', ['speak:dummyword1:en-US', 'wait:2000', 'speak:ダミー意味1:ja-JP', 'wait:1500']],
    ['word-only', ['speak:dummyword1:en-US', 'speak:ダミー意味1:ja-JP', 'wait:1500']],
    ['sentence-only', ['seg:dummy_1.mp3:0.5-2.5', 'wait:1500']],
  ];
  for (const [preset, expected] of cases) {
    const { f, player } = setup({ n: 1, preset });
    player.play();
    await until(() => player.getState().status === 'ended');
    assert.deepEqual(calls(f.log), expected, preset);
    if (preset === 'sentence-only') assert.equal(player.getState().shown.size, 0);
  }
});

test('プレイヤー：例文のみで例文の無い語は飛ばす', async () => {
  const items = makeItems(3, { noSentenceNos: [2] });
  const { f, player } = setup({ n: 3, preset: 'sentence-only', items });
  player.play();
  await until(() => player.getState().status === 'ended');
  assert.deepEqual(calls(f.log), ['seg:dummy_1.mp3:0.5-2.5', 'wait:1500', 'seg:dummy_3.mp3:0.5-2.5', 'wait:1500']);
});

test('プレイヤー：全部の語にステップが無いと空回りせず ended', async () => {
  const items = makeItems(2, { noSentenceNos: [1, 2] });
  for (const repeat of ['off', 'one', 'range']) {
    const { player } = setup({ n: 2, preset: 'sentence-only', items, settings: { repeat } });
    player.play();
    await until(() => player.getState().status === 'ended');
  }
});

test('プレイヤー：repeat one は同じ語を繰り返す', async () => {
  const { f, player } = setup({ n: 3, preset: 'word-only', settings: { repeat: 'one' } });
  player.play();
  await until(() => calls(f.log).length >= 9);
  player.pause();
  const c = calls(f.log).slice(0, 9);
  assert.deepEqual(c, Array(3).fill(['speak:dummyword1:en-US', 'speak:ダミー意味1:ja-JP', 'wait:1500']).flat());
  assert.equal(player.getState().no, 1);
});

test('プレイヤー：repeat range は最後の後に先頭へ戻る', async () => {
  const { f, player } = setup({ n: 2, preset: 'sentence-only', settings: { repeat: 'range' } });
  player.play();
  await until(() => calls(f.log).length >= 6);
  player.pause();
  assert.deepEqual(calls(f.log).slice(0, 6), [
    'seg:dummy_1.mp3:0.5-2.5', 'wait:1500', 'seg:dummy_2.mp3:0.5-2.5', 'wait:1500',
    'seg:dummy_1.mp3:0.5-2.5', 'wait:1500']);
  assert.notEqual(player.getState().status, 'ended');
});

test('プレイヤー：repeat range + shuffle は 1 周ごとに並べ直す（全部含む）', async () => {
  const { f, player } = setup({ n: 5, preset: 'sentence-only', settings: { repeat: 'range', shuffle: true }, rng: seededRng(11) });
  player.play();
  await until(() => calls(f.log).length >= 20);
  player.pause();
  const files = calls(f.log).filter((c) => c.startsWith('seg')).map((c) => Number(c.split(':')[1].match(/\d+/)[0]));
  assert.deepEqual(files.slice(5, 10).sort(), [1, 2, 3, 4, 5]);
});

test('プレイヤー：pause → resume で同じステップの頭から', async () => {
  const { f, player } = setup({ n: 2, preset: 'word-only', drv: { mode: 'delay', delayMs: 30 } });
  player.play();
  await until(() => calls(f.log).length === 2); // 2 つ目（日本語）の途中
  player.pause();
  assert.equal(player.getState().status, 'paused');
  assert.equal(player.getState().stepIndex, 3); // showEn, speakEn, showJa, [speakJa]
  const cancelsAtPause = f.cancels;
  assert.ok(cancelsAtPause >= 1);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(calls(f.log).length, 2); // 止まっている間は進まない
  player.resume();
  await until(() => player.getState().status === 'ended');
  assert.deepEqual(calls(f.log), [
    'speak:dummyword1:en-US', 'speak:ダミー意味1:ja-JP', 'speak:ダミー意味1:ja-JP', 'wait:1500',
    'speak:dummyword2:en-US', 'speak:ダミー意味2:ja-JP', 'wait:1500']);
});

test('プレイヤー：toggle で一時停止と再開', async () => {
  const { player } = setup({ n: 1, preset: 'word-only', drv: { mode: 'delay', delayMs: 20 } });
  player.toggle();
  assert.equal(player.getState().status, 'playing');
  player.toggle();
  assert.equal(player.getState().status, 'paused');
  player.toggle();
  await until(() => player.getState().status === 'ended');
});

test('プレイヤー：next / prev / jumpTo は cancel してから新しい語の最初へ', async () => {
  const { f, player } = setup({ n: 5, preset: 'word-only', drv: { mode: 'delay', delayMs: 30 } });
  player.play();
  await until(() => calls(f.log).length === 1);
  const before = f.cancels;
  player.next();
  assert.equal(f.cancels, before + 1);
  let st = player.getState();
  assert.equal(st.no, 2);
  assert.equal(st.status, 'playing');
  await until(() => calls(f.log).length === 2);
  assert.equal(calls(f.log)[1], 'speak:dummyword2:en-US');

  player.jumpTo(5);
  assert.equal(f.cancels, before + 2);
  await until(() => calls(f.log).length === 3);
  assert.equal(calls(f.log)[2], 'speak:dummyword5:en-US');
  assert.deepEqual([...player.getState().shown], ['showEn']);

  player.prev();
  assert.equal(f.cancels, before + 3);
  await until(() => calls(f.log).length === 4);
  assert.equal(calls(f.log)[3], 'speak:dummyword4:en-US');

  assert.equal(player.jumpTo(99), false);
  assert.equal(player.getState().no, 4);
  player.pause();
});

test('プレイヤー：一時停止中の移動は止まったまま、再生でその語から', async () => {
  const { f, player } = setup({ n: 3, preset: 'word-only', drv: { mode: 'delay', delayMs: 20 } });
  player.play();
  await until(() => calls(f.log).length === 1);
  player.pause();
  player.jumpTo(3);
  assert.equal(player.getState().status, 'paused');
  assert.equal(player.getState().stepIndex, 0);
  player.play();
  await until(() => player.getState().status === 'ended');
  assert.equal(calls(f.log)[1], 'speak:dummyword3:en-US');
});

test('プレイヤー：next は最後で ended（repeat range なら先頭へ）', async () => {
  const a = setup({ n: 2, preset: 'word-only', drv: { mode: 'delay', delayMs: 20 } });
  a.player.play();
  a.player.jumpTo(2);
  a.player.next();
  assert.equal(a.player.getState().status, 'ended');
  const b = setup({ n: 2, preset: 'word-only', settings: { repeat: 'range' }, drv: { mode: 'delay', delayMs: 20 } });
  b.player.play();
  b.player.jumpTo(2);
  b.player.next();
  assert.equal(b.player.getState().no, 1);
  b.player.pause();
});

test('プレイヤー：再生中に jumpTo しても古いループの呼び出しが混ざらない（世代番号）', async () => {
  // cancel で待ち中の呼び出しがすぐ「解決」する厳しい偽物で確かめる
  const { f, player } = setup({ n: 10, preset: 'ja-en-sentence', drv: { mode: 'delay', delayMs: 15 } });
  player.play();
  await until(() => calls(f.log).length === 2); // No.1 の gapThink 待ち
  player.jumpTo(7);
  player.jumpTo(8);
  player.jumpTo(9);
  await until(() => player.getState().status === 'ended');
  const after = calls(f.log).slice(2);
  // 古い No.1・7・8 のステップは出てこず、No.9 → No.10 の順だけが並ぶ
  assert.deepEqual(after, [
    'speak:ダミー意味9:ja-JP', 'wait:2000', 'speak:dummyword9:en-US', 'seg:dummy_9.mp3:0.5-2.5', 'wait:1500',
    'speak:ダミー意味10:ja-JP', 'wait:2000', 'speak:dummyword10:en-US', 'seg:dummy_10.mp3:0.5-2.5', 'wait:1500',
  ]);
});

test('プレイヤー：driver の失敗で止まらない', async () => {
  const { f, player } = setup({ n: 2, preset: 'word-only', drv: { mode: 'fail' } });
  player.play();
  await until(() => player.getState().status === 'ended');
  assert.deepEqual(calls(f.log), [
    'speak:dummyword1:en-US', 'speak:ダミー意味1:ja-JP', 'wait:1500',
    'speak:dummyword2:en-US', 'speak:ダミー意味2:ja-JP', 'wait:1500']);
});

test('プレイヤー：playSentence が失敗したら英文を TTS で読む', async () => {
  const { f, player } = setup({
    n: 1, preset: 'sentence-only',
    drv: { failIf: (name) => name === 'playSegment' },
  });
  player.play();
  await until(() => player.getState().status === 'ended');
  assert.deepEqual(calls(f.log), ['seg:dummy_1.mp3:0.5-2.5', 'speak:Dummy sentence 1.:en-US', 'wait:1500']);
});

test('プレイヤー：区間が無い例文は英文・和訳を TTS で読む', async () => {
  const items = makeItems(1, { segOverride: { 1: {} } });
  const { f, player } = setup({ n: 1, items, settings: { speakSentenceJa: true } });
  player.play();
  await until(() => player.getState().status === 'ended');
  const c = calls(f.log);
  assert.ok(c.includes('speak:Dummy sentence 1.:en-US'));
  assert.ok(c.includes('speak:ダミー文1:ja-JP'));
  assert.ok(!c.some((x) => x.startsWith('seg')));
});

test('プレイヤー：setRate は次のステップから効く・wait は rate で割らない', async () => {
  const { f, player } = setup({ n: 1, preset: 'word-only', drv: { mode: 'delay', delayMs: 20 } });
  player.play();
  await until(() => f.log.filter((c) => c.name === 'speak').length === 1);
  player.setRate(1.5);
  await until(() => player.getState().status === 'ended');
  const speaks = f.log.filter((c) => c.name === 'speak');
  assert.equal(speaks[0].args[2], 1.0);
  assert.equal(speaks[1].args[2], 1.5);
  assert.deepEqual(f.log.find((c) => c.name === 'wait').args, [1500]);
  assert.equal(player.getState().rate, 1.5);
  // playSegment にも rate が渡る
  const g = setup({ n: 1, preset: 'sentence-only', settings: { rate: 0.75 } });
  g.player.play();
  await until(() => g.player.getState().status === 'ended');
  assert.equal(g.f.log.find((c) => c.name === 'playSegment').args[3], 0.75);
  // 範囲外は丸める
  g.player.setRate(9);
  assert.equal(g.player.getState().rate, 1.5);
});

test('プレイヤー：setRepeat は語の終わりから効く', async () => {
  const { f, player } = setup({ n: 2, preset: 'word-only', drv: { mode: 'delay', delayMs: 10 } });
  player.play();
  await until(() => calls(f.log).length === 1);
  player.setRepeat('one');
  await until(() => calls(f.log).length >= 6);
  player.pause();
  assert.deepEqual(calls(f.log).slice(3, 6), ['speak:dummyword1:en-US', 'speak:ダミー意味1:ja-JP', 'wait:1500']);
});

test('プレイヤー：setShuffle は今の語を先頭に、残りを並べ直す', async () => {
  const { f, player } = setup({ n: 6, preset: 'word-only', rng: seededRng(5), drv: { mode: 'delay', delayMs: 10 } });
  player.play();
  player.jumpTo(3);
  player.setShuffle(true);
  let st = player.getState();
  assert.equal(st.shuffle, true);
  assert.equal(st.index, 0);
  assert.equal(st.no, 3);
  assert.equal(st.playlist[0], 3);
  assert.deepEqual([...st.playlist].sort(), [1, 2, 3, 4, 5, 6]);
  const order = st.playlist.slice();
  player.setShuffle(false);
  st = player.getState();
  assert.deepEqual(st.playlist, [1, 2, 3, 4, 5, 6]);
  assert.equal(st.no, 3);
  assert.equal(st.index, 2);
  // もう一度シャッフルして、最後まで流すとその順に読む
  player.setShuffle(true);
  const order2 = player.getState().playlist;
  await until(() => player.getState().status === 'ended');
  const enOrder = calls(f.log).filter((c) => c.endsWith(':en-US')).map((c) => Number(c.match(/dummyword(\d+)/)[1]));
  assert.deepEqual(enOrder.slice(-6), order2);
  assert.equal(order.length, 6);
});

test('プレイヤー：ended の後の play は先頭から、空のプレイリストはすぐ ended', async () => {
  const { f, player } = setup({ n: 2, preset: 'sentence-only' });
  player.play();
  await until(() => player.getState().status === 'ended');
  player.play();
  await until(() => player.getState().status === 'ended' && calls(f.log).length === 8);
  assert.equal(calls(f.log)[4], 'seg:dummy_1.mp3:0.5-2.5');

  const e = createPlayer({ drivers: fakeDrivers().drivers });
  e.load([], new Map(), 'word-only', settingsWith());
  e.play();
  await until(() => e.getState().status === 'ended');
  assert.equal(e.getState().no, null);
});

test('プレイヤー：load は今の再生を止めて idle に戻す', async () => {
  const { f, player } = setup({ n: 3, preset: 'word-only', drv: { mode: 'delay', delayMs: 20 } });
  player.play();
  await until(() => calls(f.log).length === 1);
  player.load([2, 3], makeItems(3), 'word-only', settingsWith());
  const st = player.getState();
  assert.equal(st.status, 'idle');
  assert.equal(st.no, 2);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(calls(f.log).length, 1); // 古いループは進まない
});

// =====================================================================
// 記録（kk.mylisten.v1）
// =====================================================================

test('loadMyListen：既定値', () => {
  const d = loadMyListen(new MemoryStorage());
  assert.equal(d.version, 1);
  assert.deepEqual(d.settings, normalizeSettings(null));
  assert.deepEqual(d.marks, {});
  assert.equal(d.last, null);
  assert.deepEqual(loadMyListen(null), d);
});

test('loadMyListen：壊れたデータは既定値・不正な値は捨てる', () => {
  const st = new MemoryStorage();
  st.setItem(MYLISTEN_KEY, '{壊れた');
  assert.deepEqual(loadMyListen(st).marks, {});
  st.setItem(MYLISTEN_KEY, JSON.stringify({
    settings: { sectionSize: 200, rate: 5 },
    marks: { w0001: 'known', w0002: 'notyet', w0003: 'xx' },
    last: { wordId: 'w0002', no: 2, at: '2026-11-14T10:00:00' },
  }));
  const d = loadMyListen(st);
  assert.equal(d.settings.sectionSize, 200);
  assert.equal(d.settings.rate, 1.5);
  assert.deepEqual(d.marks, { w0001: 'known', w0002: 'notyet' });
  assert.deepEqual(d.last, { wordId: 'w0002', no: 2, at: '2026-11-14T10:00:00' });
  st.setItem(MYLISTEN_KEY, JSON.stringify({ last: { wordId: 5, no: 0 } }));
  assert.equal(loadMyListen(st).last, null);
  st.setItem(MYLISTEN_KEY, '[1,2]');
  assert.deepEqual(loadMyListen(st).settings, normalizeSettings(null));
});

test('saveMyListen：保存して読み直せる・保存できない環境は false', () => {
  const st = new MemoryStorage();
  const data = { version: 1, settings: settingsWith({ sectionSize: 150 }), marks: { w0001: 'notyet' }, last: { wordId: 'w0001', no: 1, at: 'x' } };
  assert.equal(saveMyListen(data, st), true);
  const back = loadMyListen(st);
  assert.equal(back.settings.sectionSize, 150);
  assert.deepEqual(back.marks, { w0001: 'notyet' });
  assert.equal(saveMyListen(data, null), false);
  const broken = { getItem() { throw new Error('x'); }, setItem() { throw new Error('容量不足'); } };
  assert.equal(saveMyListen(data, broken), false);
  assert.deepEqual(loadMyListen(broken).marks, {});
});
