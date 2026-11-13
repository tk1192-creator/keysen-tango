// 聞き流し（マイリスニング）の再生の仕組み（純粋なロジック）
//
// 取り決め：js/PLAYER.md の「js/player.js」の節。DOM・audio.js・speechSynthesis は直接使わず、
// 音はすべて createPlayer に渡す drivers（speak / playSegment / wait / cancel）を通す。
// node で import してテストできる（tests/player.test.mjs）。
//
// 取り決めで決まっていなかった点の決め方：
// 1. normalizeSettings
//    - presetId が PRESETS に無ければ既定値。sectionSize は SECTION_SIZES に無ければ既定値（50）。
//    - rate は 0.75〜1.5、gapThink / gapNext は 0〜10 秒に丸める（数でなければ既定値）。
//    - speakJa / speakSentenceJa は真偽値でなければ既定値。shuffle は true のときだけ true。
//    - range：section は 1 以上の整数（でなければ 1）。nos の from / to は 1 以上の整数で、逆なら入れ替える。
//      どちらかが不正、kind が不明なら { kind: 'all' }。総語数での頭打ちは buildPlaylist で行う。
// 2. numberWords：words に同じ id があっても 1 回だけ数える（orderNewWords の結果に従う）。
// 3. sectionOf：no が 1 未満・不正なら 1。sectionSize が不正なら既定値（50）。
// 4. sectionRange：section は 1〜最後の Section に丸める。to は total で頭打ち（最後の Section は N 未満になる）。
//    total が 0 なら { from: 1, to: 0 }（空）。
// 5. buildPlaylist
//    - nos の範囲は 1〜total に丸める。範囲に 1 語も無ければ []。
//    - shuffle のときは「startNo の語を先頭に、範囲の残り全部（startNo より前の語も含む）をシャッフル」。
//      startNo が無い・範囲外なら、範囲全体をシャッフル。シャッフルは Fisher–Yates（rng は 0 以上 1 未満）。
// 6. resolveSteps
//    - 例文系（showSentence / playSentence / showSentenceJa / speakSentenceJa）は、
//      sentenceIds が空の語、または sentence が渡されない語では除く。
//    - 除いた結果、wait 以外のステップが 1 つも残らない（例文のみのパターンで例文の無い語など）ときは []
//      にして、その語は待たずに飛ばす。
//    - sec が数ならそのまま、設定のキー名ならその値。どちらも 0 以上の数でなければ 0。
// 7. 各ステップの音
//    - speakJa：word.meaning を ja-JP で。speakEn：word.word から "..." "…" "～" "〜" "~" を除いて en-US で。
//    - playSentence：sentence.seg.en1 を playSegment(sentence.file, 始め, 終わり, rate)。
//      区間が無い・失敗したら sentence.en を en-US の TTS で読む。それも無ければ飛ばす。
//    - speakSentenceJa：sentence.seg.ja を playSegment。区間が無い・失敗したら sentence.ja を ja-JP の TTS で読む。
//    - 読む文字が空のステップは何もせず次へ。driver が失敗（reject）しても止めずに次へ。
//    - wait：drivers.wait(秒 × 1000)。rate では割らない。
// 8. プレイヤー
//    - load は今の再生を止めて status 'idle'、先頭の語・最初のステップに戻す。preset は PRESETS の
//      オブジェクトか id の文字列。settings は normalizeSettings してから使う（プレイヤーの中で書き換えても
//      呼び出し側のオブジェクトは変えない）。
//    - play：idle なら今の位置から、ended なら先頭から（shown も空に）、paused なら resume と同じ。
//    - 状態は「今のステップを始める直前」に onState で知らせる（stepIndex は今流しているステップ）。
//      show 系は shown に足してから知らせる。語を移ったとき・止めたときも知らせる。
//    - next：最後の語では repeat 'range' なら先頭へ（shuffle なら並べ直す）、それ以外は ended。
//      prev：先頭の語では先頭の語の最初からやり直す。jumpTo(no)：プレイリストに無い No. なら何もせず false。
//    - 移動（next / prev / jumpTo）は、playing なら新しい語から続けて再生、paused・idle ならそのまま
//      （再生を押すとその語から）。ended のときの移動は idle に戻す。
//    - repeat 'one' と自動の次への移動でも、語の切り替えでは drivers.cancel() を呼ぶ。
//    - 1 周しても 1 つもステップが無い（全部の語が空）ときは、空回りしないよう ended にする。
//    - setShuffle(true)：今の語を先頭に、プレイリストの残りをシャッフル。setShuffle(false)：No. の小さい順に
//      並べ直し、今の語の位置へ。どちらも今のステップは止めない（次の語から新しい順）。
//    - setRate / setRepeat は今のステップを止めない（rate は次のステップから効く）。
//    - createPlayer の第 1 引数に rng（既定 Math.random）を渡せる（テストで順番を固定するため）。
//    - 語を移るたびに setTimeout(0) で一度譲る（driver がすぐ解決しても repeat で画面が固まらないように）。
//    - getState には取り決めの項目に加えて stepType・rate・repeat・shuffle・playlist（コピー）も入れる。
// 9. loadMyListen / saveMyListen
//    - storage を省略すると globalThis.localStorage。使えない・無い・壊れている → 既定値。
//    - marks は 'known' | 'notyet' 以外の値を捨てる。last は wordId が文字列・no が 1 以上の整数のときだけ残す。
//    - saveMyListen は正しい形に直して保存し、保存できたら true、できなければ false（例外は投げない）。

import { orderNewWords } from './srs.js';

export const MYLISTEN_KEY = 'kk.mylisten.v1';
export const SECTION_SIZES = Object.freeze([20, 30, 50, 100, 150, 200]);
export const RATE_MIN = 0.75;
export const RATE_MAX = 1.5;
export const GAP_MIN = 0;
export const GAP_MAX = 10;
export const REPEAT_MODES = Object.freeze(['off', 'one', 'range']);
export const RANGE_KINDS = Object.freeze(['all', 'section', 'nos', 'notyet']);

/** パターン（JSON で保存できる形。PLAYER.md のとおり） */
export const PRESETS = Object.freeze([
  { id: 'ja-en-sentence', name: '日→英→例文', steps: [
    { type: 'showJa' }, { type: 'speakJa', when: 'speakJa' }, { type: 'wait', sec: 'gapThink' },
    { type: 'showEn' }, { type: 'speakEn' },
    { type: 'showSentence' }, { type: 'playSentence' },
    { type: 'showSentenceJa' }, { type: 'speakSentenceJa', when: 'speakSentenceJa' },
    { type: 'wait', sec: 'gapNext' } ] },
  { id: 'en-ja', name: '英→日', steps: [
    { type: 'showEn' }, { type: 'speakEn' }, { type: 'wait', sec: 'gapThink' },
    { type: 'showJa' }, { type: 'speakJa', when: 'speakJa' }, { type: 'wait', sec: 'gapNext' } ] },
  { id: 'word-only', name: '単語のみ', steps: [
    { type: 'showEn' }, { type: 'speakEn' }, { type: 'showJa' }, { type: 'speakJa', when: 'speakJa' },
    { type: 'wait', sec: 'gapNext' } ] },
  { id: 'sentence-only', name: '例文のみ', steps: [
    { type: 'playSentence' }, { type: 'wait', sec: 'gapNext' } ] },   // 文字は出さない
]);

export const DEFAULT_SETTINGS = Object.freeze({
  presetId: 'ja-en-sentence', sectionSize: 50, gapThink: 2, gapNext: 1.5,
  speakJa: true, speakSentenceJa: false, rate: 1.0, repeat: 'off', shuffle: false,
  range: Object.freeze({ kind: 'all' }),
});

/** 例文が必要なステップ */
const SENTENCE_STEPS = new Set(['showSentence', 'playSentence', 'showSentenceJa', 'speakSentenceJa']);

// ---------------------------------------------------------------------------
// 内部の小道具
// ---------------------------------------------------------------------------

function toNum(v) {
  if (v === null || v === '' || typeof v === 'boolean' || Array.isArray(v)) return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function posInt(v) {
  const n = toNum(v);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

function clamp(n, lo, hi) {
  return Math.min(Math.max(n, lo), hi);
}

function isObj(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function defaultStorage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

/** 英単語の発音用の文字（"..." や "～" は読まない） */
export function speakableEn(text) {
  return String(text ?? '')
    .replace(/\.{2,}|…|～|〜|~/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 例文の無い語か（sentenceIds が無い・空） */
function hasNoSentence(word) {
  return !word || !Array.isArray(word.sentenceIds) || word.sentenceIds.length === 0;
}

/** 区間 [start, end] が使える形なら返す */
function segOf(sentence, key) {
  const s = sentence && isObj(sentence.seg) ? sentence.seg[key] : null;
  if (!Array.isArray(s) || s.length < 2) return null;
  const a = toNum(s[0]);
  const b = toNum(s[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b <= a) return null;
  return [a, b];
}

/** Fisher–Yates で並べ替えた新しい配列 */
function shuffled(arr, rng) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    let r = Number(rng());
    if (!Number.isFinite(r) || r < 0) r = 0;
    if (r >= 1) r = 0.999999;
    const j = Math.floor(r * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** 一度ほかの処理に順番を譲る（setTimeout 0） */
function yieldTurn() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function findPreset(preset) {
  if (isObj(preset) && Array.isArray(preset.steps)) return preset;
  const id = typeof preset === 'string' ? preset : DEFAULT_SETTINGS.presetId;
  return PRESETS.find((p) => p.id === id) || PRESETS[0];
}

// ---------------------------------------------------------------------------
// 設定・番号・プレイリスト
// ---------------------------------------------------------------------------

function normalizeRange(r) {
  if (!isObj(r) || !RANGE_KINDS.includes(r.kind)) return { kind: 'all' };
  if (r.kind === 'section') return { kind: 'section', section: posInt(r.section) ?? 1 };
  if (r.kind === 'nos') {
    let from = posInt(r.from);
    let to = posInt(r.to);
    if (from === null || to === null) return { kind: 'all' };
    if (from > to) [from, to] = [to, from];
    return { kind: 'nos', from, to };
  }
  return { kind: r.kind };
}

/** 設定を正しい形に直す（範囲外は補正、壊れた値は既定値） */
export function normalizeSettings(obj) {
  const r = isObj(obj) ? obj : {};
  const d = DEFAULT_SETTINGS;
  const num = (v, def, lo, hi) => {
    const n = toNum(v);
    return Number.isFinite(n) ? clamp(n, lo, hi) : def;
  };
  const size = toNum(r.sectionSize);
  return {
    presetId: PRESETS.some((p) => p.id === r.presetId) ? r.presetId : d.presetId,
    sectionSize: SECTION_SIZES.includes(size) ? size : d.sectionSize,
    gapThink: num(r.gapThink, d.gapThink, GAP_MIN, GAP_MAX),
    gapNext: num(r.gapNext, d.gapNext, GAP_MIN, GAP_MAX),
    speakJa: typeof r.speakJa === 'boolean' ? r.speakJa : d.speakJa,
    speakSentenceJa: typeof r.speakSentenceJa === 'boolean' ? r.speakSentenceJa : d.speakSentenceJa,
    rate: num(r.rate, d.rate, RATE_MIN, RATE_MAX),
    repeat: REPEAT_MODES.includes(r.repeat) ? r.repeat : d.repeat,
    shuffle: r.shuffle === true,
    range: normalizeRange(r.range),
  };
}

/** orderNewWords の順に No.1〜 をつける */
export function numberWords(words) {
  const list = Array.isArray(words) ? words : [];
  const byId = new Map();
  for (const w of list) {
    if (w && w.id != null && !byId.has(w.id)) byId.set(w.id, w);
  }
  return orderNewWords(list).map((id, i) => ({ no: i + 1, word: byId.get(id) }));
}

function sizeOf(sectionSize) {
  const n = toNum(sectionSize);
  return SECTION_SIZES.includes(n) ? n : (posInt(n) ?? DEFAULT_SETTINGS.sectionSize);
}

/** No. が入る Section（1〜） */
export function sectionOf(no, sectionSize) {
  const n = posInt(no) ?? 1;
  return Math.ceil(n / sizeOf(sectionSize));
}

/** Section の No. の範囲（to は total で頭打ち） */
export function sectionRange(section, sectionSize, total) {
  const size = sizeOf(sectionSize);
  const t = Math.max(0, Math.trunc(toNum(total)) || 0);
  if (t === 0) return { from: 1, to: 0 };
  const last = Math.ceil(t / size);
  const s = clamp(posInt(section) ?? 1, 1, last);
  return { from: (s - 1) * size + 1, to: Math.min(s * size, t) };
}

/** 再生する No. の配列 */
export function buildPlaylist(numbered, settings, marks, { startNo, rng = Math.random } = {}) {
  const list = Array.isArray(numbered) ? numbered.filter((x) => x && posInt(x.no) !== null) : [];
  const s = normalizeSettings(settings);
  const total = list.length;
  const m = isObj(marks) ? marks : {};
  let picked;
  switch (s.range.kind) {
    case 'section': {
      const { from, to } = sectionRange(s.range.section, s.sectionSize, total);
      picked = list.filter((x) => x.no >= from && x.no <= to);
      break;
    }
    case 'nos': {
      const from = clamp(s.range.from, 1, Math.max(total, 1));
      const to = clamp(s.range.to, 1, Math.max(total, 1));
      picked = list.filter((x) => x.no >= from && x.no <= to);
      break;
    }
    case 'notyet':
      picked = list.filter((x) => x.word && m[x.word.id] === 'notyet');
      break;
    default:
      picked = list;
  }
  const nos = picked.map((x) => x.no).sort((a, b) => a - b);
  const start = posInt(startNo);
  const at = start === null ? -1 : nos.indexOf(start);
  if (s.shuffle) {
    if (at < 0) return shuffled(nos, rng);
    return [start, ...shuffled(nos.filter((n) => n !== start), rng)];
  }
  return at < 0 ? nos : nos.slice(at);
}

/** パターンのステップを、設定と語に合わせて実際に流す形にする */
export function resolveSteps(preset, settings, word, sentence) {
  const p = findPreset(preset);
  const s = normalizeSettings(settings);
  const noSentence = hasNoSentence(word) || !sentence;
  const out = [];
  for (const st of p.steps) {
    if (!st || typeof st.type !== 'string') continue;
    if (st.when && s[st.when] === false) continue;
    if (noSentence && SENTENCE_STEPS.has(st.type)) continue;
    if (st.type === 'wait') {
      let sec = typeof st.sec === 'string' ? toNum(s[st.sec]) : toNum(st.sec);
      if (!Number.isFinite(sec) || sec < 0) sec = 0;
      out.push({ type: 'wait', sec });
    } else {
      out.push({ type: st.type });
    }
  }
  return out.some((x) => x.type !== 'wait') ? out : [];
}

// ---------------------------------------------------------------------------
// プレイヤー
// ---------------------------------------------------------------------------

export function createPlayer({ drivers, onState, rng = Math.random } = {}) {
  const d = drivers || {};
  let playlist = [];
  let items = new Map();
  let preset = PRESETS[0];
  let settings = normalizeSettings(null);
  let status = 'idle';
  let index = 0;
  let stepIndex = 0;
  let steps = [];        // 今の語の解決済みステップ
  let shown = new Set();
  let generation = 0;    // 単語の切り替え・一時停止のたびに増やし、古いループを捨てる

  function cancelDrivers() {
    try { if (typeof d.cancel === 'function') d.cancel(); } catch { /* 止められなくても進める */ }
  }

  function getState() {
    return {
      status, index, no: playlist[index] ?? null, stepIndex,
      stepType: steps[stepIndex]?.type ?? null,
      shown: new Set(shown), total: playlist.length,
      rate: settings.rate, repeat: settings.repeat, shuffle: settings.shuffle,
      playlist: playlist.slice(),
    };
  }

  function emit() {
    if (typeof onState !== 'function') return;
    try { onState(getState()); } catch { /* 画面側の失敗で再生を止めない */ }
  }

  function stepsFor(i) {
    const item = items.get(playlist[i]);
    if (!item) return [];
    return resolveSteps(preset, settings, item.word, item.sentence);
  }

  /** driver を呼んで終わるまで待つ。失敗したら false */
  async function call(fn, ...args) {
    if (typeof fn !== 'function') return false;
    try {
      await fn(...args);
      return true;
    } catch {
      return false;
    }
  }

  /** 1 ステップ分の音を流す（show 系は何もしない） */
  async function runStep(step, item, gen) {
    const word = item.word || {};
    const sentence = item.sentence || null;
    const rate = settings.rate;
    switch (step.type) {
      case 'speakJa': {
        const t = String(word.meaning ?? '').trim();
        if (t) await call(d.speak, t, 'ja-JP', rate);
        return;
      }
      case 'speakEn': {
        const t = speakableEn(word.word);
        if (t) await call(d.speak, t, 'en-US', rate);
        return;
      }
      case 'playSentence':
      case 'speakSentenceJa': {
        const isEn = step.type === 'playSentence';
        const seg = segOf(sentence, isEn ? 'en1' : 'ja');
        let ok = false;
        if (seg && sentence.file) ok = await call(d.playSegment, sentence.file, seg[0], seg[1], rate);
        if (ok || gen !== generation) return;
        // mp3 が無い・読めない → 文字を TTS で読む（止めない）
        const t = String((isEn ? sentence?.en : sentence?.ja) ?? '').trim();
        if (t) await call(d.speak, t, isEn ? 'en-US' : 'ja-JP', settings.rate);
        return;
      }
      case 'wait':
        await call(d.wait, step.sec * 1000);
        return;
      default:
        return;
    }
  }

  /** 次の語へ（自動）。続けるなら true */
  function advanceAuto() {
    if (settings.repeat === 'one') {
      return true;
    }
    if (index + 1 < playlist.length) {
      index += 1;
      return true;
    }
    if (settings.repeat === 'range' && playlist.length > 0) {
      if (settings.shuffle) playlist = shuffled(playlist, rng);
      index = 0;
      return true;
    }
    return false;
  }

  async function loop(gen) {
    let emptyRun = 0; // ステップの無い語が続いた数（空回り防止）
    while (gen === generation) {
      if (index >= playlist.length) {
        status = 'ended';
        emit();
        return;
      }
      steps = stepsFor(index);
      const item = items.get(playlist[index]) || {};
      if (steps.length === 0) {
        emptyRun += 1;
      } else {
        emptyRun = 0;
      }
      while (stepIndex < steps.length) {
        if (gen !== generation) return;
        const step = steps[stepIndex];
        if (step.type.startsWith('show')) shown.add(step.type);
        emit();
        await runStep(step, item, gen);
        if (gen !== generation) return;
        stepIndex += 1;
      }
      if (gen !== generation) return;
      // 語の終わり → 次の語へ
      const limit = settings.repeat === 'one' ? 1 : Math.max(playlist.length, 1);
      if (emptyRun >= limit || !advanceAuto()) {
        stepIndex = steps.length;
        status = 'ended';
        emit();
        return;
      }
      cancelDrivers();
      stepIndex = 0;
      shown = new Set();
      // driver がすぐ解決する環境（TTS が無い・間隔 0）でも画面が固まらないよう、語ごとに一度譲る
      await yieldTurn();
    }
  }

  function start() {
    generation += 1;
    const gen = generation;
    status = 'playing';
    loop(gen).catch(() => {
      // 想定外の失敗でも画面が固まらないよう、止まったことを知らせる
      if (gen === generation) { status = 'paused'; emit(); }
    });
  }

  function load(list, map, p, s) {
    cancelDrivers();
    generation += 1;
    playlist = Array.isArray(list) ? list.slice() : [];
    items = map instanceof Map ? map : new Map();
    preset = findPreset(p);
    settings = normalizeSettings(s);
    status = 'idle';
    index = 0;
    stepIndex = 0;
    shown = new Set();
    steps = stepsFor(0);
    emit();
  }

  function play() {
    if (status === 'playing') return;
    if (status === 'paused') { resume(); return; }
    if (status === 'ended') {
      cancelDrivers();
      if (settings.shuffle) playlist = shuffled(playlist, rng);
      index = 0;
      stepIndex = 0;
      shown = new Set();
    }
    start();
  }

  function pause() {
    if (status !== 'playing') return;
    cancelDrivers();
    generation += 1;
    status = 'paused';
    emit();
  }

  function resume() {
    if (status !== 'paused') return;
    cancelDrivers();
    start(); // stepIndex はそのまま → 同じステップの頭から
  }

  function toggle() {
    if (status === 'playing') pause();
    else play();
  }

  /** 語を移る（next / prev / jumpTo） */
  function moveTo(i) {
    cancelDrivers();
    generation += 1;
    index = i;
    stepIndex = 0;
    shown = new Set();
    steps = stepsFor(index);
    if (status === 'playing') {
      start();
    } else {
      if (status === 'ended') status = 'idle';
      emit();
    }
  }

  function next() {
    if (playlist.length === 0) return;
    if (index + 1 < playlist.length) { moveTo(index + 1); return; }
    if (settings.repeat === 'range') {
      if (settings.shuffle) playlist = shuffled(playlist, rng);
      moveTo(0);
      return;
    }
    cancelDrivers();
    generation += 1;
    status = 'ended';
    emit();
  }

  function prev() {
    if (playlist.length === 0) return;
    moveTo(Math.max(0, index - 1));
  }

  function jumpTo(no) {
    const i = playlist.indexOf(Number(no));
    if (i < 0) return false;
    moveTo(i);
    return true;
  }

  function setRate(r) {
    settings = normalizeSettings({ ...settings, rate: r });
    emit();
  }

  function setRepeat(mode) {
    settings = normalizeSettings({ ...settings, repeat: mode });
    emit();
  }

  function setShuffle(on) {
    const flag = on === true;
    const cur = playlist[index];
    if (flag) {
      const rest = playlist.filter((_, i) => i !== index);
      playlist = cur === undefined ? shuffled(rest, rng) : [cur, ...shuffled(rest, rng)];
      index = 0;
    } else {
      playlist = playlist.slice().sort((a, b) => a - b);
      index = cur === undefined ? 0 : Math.max(0, playlist.indexOf(cur));
    }
    settings = normalizeSettings({ ...settings, shuffle: flag });
    emit();
  }

  return {
    load, play, pause, resume, toggle, next, prev, jumpTo,
    setRate, setRepeat, setShuffle, getState,
  };
}

// ---------------------------------------------------------------------------
// 記録（kk.mylisten.v1）
// ---------------------------------------------------------------------------

function defaultData() {
  return { version: 1, settings: normalizeSettings(null), marks: {}, last: null };
}

function normalizeData(raw) {
  const r = isObj(raw) ? raw : {};
  const marks = {};
  if (isObj(r.marks)) {
    for (const [k, v] of Object.entries(r.marks)) {
      if (v === 'known' || v === 'notyet') marks[k] = v;
    }
  }
  let last = null;
  if (isObj(r.last) && typeof r.last.wordId === 'string' && posInt(r.last.no) !== null) {
    last = { wordId: r.last.wordId, no: posInt(r.last.no), at: typeof r.last.at === 'string' ? r.last.at : '' };
  }
  return { version: 1, settings: normalizeSettings(r.settings), marks, last };
}

/** 保存した記録を読む。無い・壊れている・使えない環境では既定値 */
export function loadMyListen(storage = defaultStorage()) {
  try {
    if (!storage) return defaultData();
    const text = storage.getItem(MYLISTEN_KEY);
    if (!text) return defaultData();
    return normalizeData(JSON.parse(text));
  } catch {
    return defaultData();
  }
}

/** 記録を保存する。保存できたら true */
export function saveMyListen(data, storage = defaultStorage()) {
  try {
    if (!storage) return false;
    storage.setItem(MYLISTEN_KEY, JSON.stringify(normalizeData(data)));
    return true;
  } catch {
    return false;
  }
}
