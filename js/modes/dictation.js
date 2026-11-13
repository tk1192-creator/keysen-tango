// ディクテーション（英語音声を聞いて書き取り、語単位で自動採点する）
//
// 使い方：startDictation(root, { sentences, getAudioBlob, onExit })
//   root         … 描画先の要素
//   sentences    … 全例文（番号順の配列）
//   getAudioBlob … ファイル名 → Blob（db.getAudioBlob）
//   onExit       … やめたときに呼ぶ（ホームに戻す）
//
// この画面で決めたこと：
// - 範囲は「ステージ（srs.stageOf と同じ 50 文ごと）」か「例文番号の から〜まで」（例文リスニングと同じ画面・言葉）。
//   出題順は 番号順 / ランダム、問題数は 5 / 10 / 20 / 範囲すべて、ヒント（語数を「_ _ _」で見せる）はオン/オフ。
// - 出題できるのは、英文（en）と英語区間（seg.en1）と音声ファイル名がそろった例文だけ。
// - 「▶ 聞く」は seg.en1（前後に SEG_PAD 秒の余白）を audio.js で再生する。何回でも押せる。
// - 「ゆっくり」は audio.js に速さを変える機能がないため、このモード専用の Audio 要素を 1 つ作り、
//   playbackRate 0.75 で同じ区間を再生する（audio.js の Audio 要素には触らない）。
// - 採点（scoreDictation）：
//   1. 両方を語に分ける。NFKC 正規化、’ ‘ ` ´ → '、小文字化。英字・数字（と語の中の '）以外は区切りとみなす
//      （句読点・ハイフン・引用符は無視。well-known は well と known の 2 語）。
//   2. 短縮形は展開してから比べる（I'm = I am、don't = do not、can't / cannot = can not、won't = will not、
//      're = are、'll = will、'd = would、'm = am、it's / he's などの代名詞＋'s = is、let's = let us）。
//      名詞＋'s（Tom's）は所有格とみなして展開しない。he's を he has、I'd を I had と書いた場合は違うと判定する。
//   3. 展開後の語の並びで最長共通部分列（LCS）をとり、一致した語を「○」にする。
//      一致した語と語のすき間では、つづりの近いもの同士を「×（入力→正解）」として対応づけ、
//      残った正解の語は「―（抜け）」、残った入力の語は「＋（余分）」にする。
//   4. 表示と点数は正解の英文の語（短縮形は 1 語）単位。展開した語がすべて一致したら ○。
//      点数 = ○ の語数 / 正解の語数。余分な語は点数を下げない（一覧には出す）。数字と数の単語（1 と one）は別の語。
// - 記録：localStorage 'kk.dictation.v1' に { settings, records } を保存する（読み書きは try/catch）。
//   records[例文番号] = { best, last, count, date }（best / last は 0〜100 の整数 %、date は "YYYY-MM-DD"）。
//   学習記録（箱・期限）は変えない。
// - 終了画面：平均点、文ごとの点数、70% 未満の文の一覧、「70% 未満だけもう一度」。

import { stageOf, todayStr } from '../srs.js';
import { listStages, idBounds, clampIdRange, segmentFor } from './listening.js';

export const DICTATION_KEY = 'kk.dictation.v1';
export const COUNT_CHOICES = Object.freeze([5, 10, 20, 'all']);
export const ORDER_CHOICES = Object.freeze(['id', 'random']);
export const LOW_THRESHOLD = 70; // これ未満の文を「もう一度」の対象にする（%）
export const SLOW_RATE = 0.75;
export const DEFAULT_DICTATION_SETTINGS = Object.freeze({
  rangeKind: 'stage', // 'stage' | 'ids'
  stage: 1,
  from: 1,
  to: 50,
  order: 'id',        // 'id' | 'random'
  count: 10,          // 5 | 10 | 20 | 'all'
  hint: true,         // 語数を「_ _ _」で見せる
});

const MSG_PLAY_FAILED = '音声を再生できませんでした。マナーモードや音量を確認して、もう一度押してください。';

// ---------- DOM を使わない部分（テスト対象） ----------

function toNum(v) {
  if (v === null || v === '' || typeof v === 'boolean') return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function isValidSentence(s) {
  return !!s && Number.isInteger(s.id) && s.id > 0;
}

/** 比べる前に文字をそろえる（全角→半角、いろいろな引用符 → '） */
function normalizeText(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/[‘’‛`´′]/g, "'");
}

const TOKEN_RE = /[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu;

/**
 * 英文を語に分ける。[{ text: 元の書き方, norm: 小文字 }]
 * 句読点・ハイフン・引用符は区切りとして捨てる。語の中の '（I'm, Tom's, o'clock）は残す。
 */
export function tokenize(text) {
  const out = [];
  for (const m of normalizeText(text).matchAll(TOKEN_RE)) {
    out.push({ text: m[0], norm: m[0].toLowerCase() });
  }
  return out;
}

// 's を is として展開する語（これ以外の 's は所有格とみなす）
const S_IS = new Set(['it', 'he', 'she', 'that', 'what', 'there', 'here', 'who', 'where', 'how', 'when', 'why', 'this']);
const SPECIAL = new Map([
  ["won't", ['will', 'not']],
  ["can't", ['can', 'not']],
  ['cannot', ['can', 'not']],
  ["shan't", ['shall', 'not']],
  ["let's", ['let', 'us']],
]);

/** 1 語（小文字）を短縮形の展開後の語の並びにする */
export function expandContraction(norm) {
  const w = String(norm).toLowerCase();
  if (SPECIAL.has(w)) return [...SPECIAL.get(w)];
  if (w.length > 3 && w.endsWith("n't")) return [w.slice(0, -3), 'not'];
  const m = w.match(/^(.+)'(m|re|ve|ll|d|s)$/);
  if (!m) return [w];
  const [, base, suf] = m;
  switch (suf) {
    case 'm': return [base, 'am'];
    case 're': return [base, 'are'];
    case 've': return [base, 'have'];
    case 'll': return [base, 'will'];
    case 'd': return [base, 'would'];
    case 's': return S_IS.has(base) ? [base, 'is'] : [w];
    default: return [w];
  }
}

/** 語の並び → 展開後の単位の並び。各単位は元の語の番号 tok を持つ */
function toUnits(tokens) {
  const units = [];
  tokens.forEach((t, i) => {
    for (const u of expandContraction(t.norm)) units.push({ norm: u, tok: i });
  });
  return units;
}

/** つづりの近さ（0〜1）。レーベンシュタイン距離から */
export function similarity(a, b) {
  a = String(a); b = String(b);
  if (a === b) return 1;
  const n = a.length;
  const m = b.length;
  if (!n || !m) return 0;
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur = [i];
    for (let j = 1; j <= m; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[m] / Math.max(n, m);
}

/** 最長共通部分列で一致する組 [[a の番号, b の番号], ...]（番号順） */
function lcsPairs(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

/**
 * 一致しなかったすき間（正解 a[a0..a1)、入力 b[b0..b1)）を対応づける。
 * 置き換え（×）の重さ = 1 - 0.5×つづりの近さ（0.5〜1）、抜け・余分 = 1。
 * 置き換えのほうが常に軽いので、少ないほうの数だけ × になり、つづりの近いもの同士が組になる。
 */
function alignGap(a, a0, a1, b, b0, b1) {
  const n = a1 - a0;
  const m = b1 - b0;
  const cost = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n; i >= 0; i--) {
    for (let j = m; j >= 0; j--) {
      if (i === n && j === m) continue;
      let best = Infinity;
      if (i < n && j < m) best = Math.min(best, cost[i + 1][j + 1] + 1 - 0.5 * similarity(a[a0 + i], b[b0 + j]));
      if (i < n) best = Math.min(best, cost[i + 1][j] + 1);
      if (j < m) best = Math.min(best, cost[i][j + 1] + 1);
      cost[i][j] = best;
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  const EPS = 1e-9;
  while (i < n || j < m) {
    if (i < n && j < m
      && Math.abs(cost[i][j] - (cost[i + 1][j + 1] + 1 - 0.5 * similarity(a[a0 + i], b[b0 + j]))) < EPS) {
      ops.push({ type: 'sub', a: a0 + i, b: b0 + j }); i++; j++;
    } else if (i < n && Math.abs(cost[i][j] - (cost[i + 1][j] + 1)) < EPS) {
      ops.push({ type: 'del', a: a0 + i }); i++;
    } else {
      ops.push({ type: 'ins', b: b0 + j }); j++;
    }
  }
  return ops;
}

/** 単位の並び同士の対応づけ（match / sub / del / ins の並び、文の順） */
function alignUnits(aNorms, bNorms) {
  const ops = [];
  let pa = 0;
  let pb = 0;
  for (const [i, j] of [...lcsPairs(aNorms, bNorms), [aNorms.length, bNorms.length]]) {
    ops.push(...alignGap(aNorms, pa, i, bNorms, pb, j));
    if (i < aNorms.length) ops.push({ type: 'match', a: i, b: j });
    pa = i + 1;
    pb = j + 1;
  }
  return ops;
}

/**
 * 書き取りを採点する。
 * @returns {{
 *   items: Array<{ kind: 'ok'|'wrong'|'missing'|'extra', expected?: string, got?: string }>,
 *   total, ok, wrong, missing, extra, score (0〜1), percent (0〜100 の整数)
 * }}
 * items は文の順。ok / wrong / missing は正解の語ごとに 1 つ、extra は余分な入力の語。
 */
export function scoreDictation(expectedText, inputText) {
  const aTok = tokenize(expectedText);
  const bTok = tokenize(inputText);
  const aUnits = toUnits(aTok);
  const bUnits = toUnits(bTok);
  const ops = alignUnits(aUnits.map((u) => u.norm), bUnits.map((u) => u.norm));

  // 正解の語ごとの状態
  const aInfo = aTok.map(() => ({ units: 0, matched: 0, linked: new Set() }));
  aUnits.forEach((u) => { aInfo[u.tok].units += 1; });
  // 入力の語ごとの「余分」だった単位
  const bExtra = bTok.map(() => []);
  const bUnitsCount = bTok.map(() => 0);
  bUnits.forEach((u) => { bUnitsCount[u.tok] += 1; });

  for (const op of ops) {
    if (op.type === 'match' || op.type === 'sub') {
      const info = aInfo[aUnits[op.a].tok];
      info.linked.add(bUnits[op.b].tok);
      if (op.type === 'match') info.matched += 1;
    } else if (op.type === 'ins') {
      bExtra[bUnits[op.b].tok].push(bUnits[op.b].norm);
    }
  }

  // 文の順に並べる
  const items = [];
  const doneA = new Set();
  const doneB = new Set();
  for (const op of ops) {
    if (op.type === 'ins') {
      const t = bUnits[op.b].tok;
      if (doneB.has(t)) continue;
      doneB.add(t);
      const whole = bExtra[t].length === bUnitsCount[t];
      items.push({ kind: 'extra', got: whole ? bTok[t].text : bExtra[t].join(' ') });
      continue;
    }
    const t = aUnits[op.a].tok;
    if (doneA.has(t)) continue;
    doneA.add(t);
    const info = aInfo[t];
    const got = [...info.linked].sort((x, y) => x - y).map((k) => bTok[k].text).join(' ');
    let kind;
    if (info.matched === info.units) kind = 'ok';
    else if (info.linked.size) kind = 'wrong';
    else kind = 'missing';
    const item = { kind, expected: aTok[t].text };
    if (kind !== 'missing') item.got = got;
    items.push(item);
  }

  const count = (k) => items.filter((it) => it.kind === k).length;
  const total = aTok.length;
  const ok = count('ok');
  const score = total ? ok / total : 0;
  return {
    items,
    total,
    ok,
    wrong: count('wrong'),
    missing: count('missing'),
    extra: count('extra'),
    score,
    percent: Math.round(score * 100),
  };
}

/** ヒント：語数を「_ _ _」で見せる。{ pattern, count } */
export function hintPattern(text) {
  const count = tokenize(text).length;
  return { pattern: Array(count).fill('_').join(' '), count };
}

/** 設定を正しい形に直す。sentences を渡すと、ステージと番号の範囲を実際の例文に合わせる */
export function normalizeDictationSettings(raw, sentences = null) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const d = DEFAULT_DICTATION_SETTINGS;
  const posInt = (v, def) => {
    const n = toNum(v);
    return Number.isInteger(n) && n >= 1 ? n : def;
  };
  const countRaw = r.count === 'all' ? 'all' : toNum(r.count);
  const out = {
    rangeKind: r.rangeKind === 'ids' ? 'ids' : 'stage',
    stage: posInt(r.stage, d.stage),
    from: posInt(r.from, d.from),
    to: posInt(r.to, d.to),
    order: ORDER_CHOICES.includes(r.order) ? r.order : d.order,
    count: COUNT_CHOICES.includes(countRaw) ? countRaw : d.count,
    hint: typeof r.hint === 'boolean' ? r.hint : d.hint,
  };
  if (out.from > out.to) [out.from, out.to] = [out.to, out.from];
  if (Array.isArray(sentences)) {
    const stages = listStages(sentences);
    if (stages.length && !stages.some((s) => s.stage === out.stage)) out.stage = stages[0].stage;
    const c = clampIdRange(out.from, out.to, sentences);
    if (c) { out.from = c.from; out.to = c.to; }
  }
  return out;
}

/** 書き取りに使える例文か（英文・英語区間・音声ファイル名がある） */
export function isDictatable(s) {
  return isValidSentence(s) && typeof s.en === 'string' && tokenize(s.en).length > 0
    && segmentFor(s, 'en') !== null;
}

/** 設定の範囲に入る、書き取りに使える例文（番号順） */
export function selectDictationRange(sentences, settings) {
  const st = settings || DEFAULT_DICTATION_SETTINGS;
  const list = (Array.isArray(sentences) ? sentences : [])
    .filter(isDictatable)
    .sort((a, b) => a.id - b.id);
  if (st.rangeKind === 'ids') {
    let f = toNum(st.from);
    let t = toNum(st.to);
    if (!Number.isFinite(f) || !Number.isFinite(t)) return [];
    if (f > t) [f, t] = [t, f];
    return list.filter((s) => s.id >= f && s.id <= t);
  }
  return list.filter((s) => stageOf(s.id) === st.stage);
}

/** 並べかえ（Fisher–Yates）。元の配列は変えない */
export function shuffle(list, rng = Math.random) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.max(0, Math.floor(rng() * (i + 1))));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 出題する例文の並び（範囲 → 順番 → 問題数） */
export function buildQuestionList(sentences, settings, rng = Math.random) {
  const st = normalizeDictationSettings(settings);
  let list = selectDictationRange(sentences, st);
  if (st.order === 'random') list = shuffle(list, rng);
  if (st.count !== 'all') list = list.slice(0, st.count);
  return list;
}

/** 結果の一覧から、平均点と点数の低い文。results = [{ id, percent }] */
export function summarizeResults(results, threshold = LOW_THRESHOLD) {
  const list = Array.isArray(results) ? results : [];
  const average = list.length
    ? Math.round(list.reduce((s, r) => s + (Number(r.percent) || 0), 0) / list.length)
    : 0;
  const low = list.filter((r) => (Number(r.percent) || 0) < threshold);
  return { average, low, count: list.length };
}

// ---- 記録（kk.dictation.v1） ----

function defaultStorage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

function emptyData() {
  return { settings: { ...DEFAULT_DICTATION_SETTINGS }, records: {} };
}

function cleanRecord(r) {
  if (!r || typeof r !== 'object') return null;
  const pct = (v) => {
    const n = toNum(v);
    return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : null;
  };
  const best = pct(r.best);
  const last = pct(r.last);
  const count = toNum(r.count);
  if (best === null || last === null || !Number.isInteger(count) || count < 1) return null;
  const date = typeof r.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : '';
  return { best: Math.max(best, last), last, count, date };
}

/** 記録を読む。無い・壊れている・使えない環境では空の記録 */
export function loadDictation(storage = defaultStorage()) {
  try {
    if (!storage) return emptyData();
    const text = storage.getItem(DICTATION_KEY);
    if (!text) return emptyData();
    const raw = JSON.parse(text);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyData();
    const records = {};
    if (raw.records && typeof raw.records === 'object' && !Array.isArray(raw.records)) {
      for (const [k, v] of Object.entries(raw.records)) {
        const id = Number(k);
        const r = cleanRecord(v);
        if (Number.isInteger(id) && id > 0 && r) records[id] = r;
      }
    }
    return { settings: normalizeDictationSettings(raw.settings), records };
  } catch {
    return emptyData();
  }
}

/** 記録を保存する。保存できたら true（使えない環境・容量不足では false） */
export function saveDictation(data, storage = defaultStorage()) {
  try {
    if (!storage) return false;
    const d = data && typeof data === 'object' ? data : emptyData();
    storage.setItem(DICTATION_KEY, JSON.stringify({
      settings: normalizeDictationSettings(d.settings),
      records: d.records && typeof d.records === 'object' ? d.records : {},
    }));
    return true;
  } catch {
    return false;
  }
}

/** 1 文の結果を記録に足した新しいデータを返す（元のデータは変えない） */
export function addResult(data, sentenceId, percent, dateStr = todayStr()) {
  const base = data && typeof data === 'object' ? data : emptyData();
  const records = { ...(base.records || {}) };
  const p = Math.min(100, Math.max(0, Math.round(Number(percent) || 0)));
  const prev = records[sentenceId];
  records[sentenceId] = prev
    ? { best: Math.max(prev.best, p), last: p, count: prev.count + 1, date: dateStr }
    : { best: p, last: p, count: 1, date: dateStr };
  return { ...base, records };
}

// ---------- 画面（DOM） ----------

/** 要素を作る（today.js と同じ書き方） */
function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    n.append(c instanceof Node ? c : String(c));
  }
  return n;
}

const KIND_MARK = { ok: '○', wrong: '×', missing: '―', extra: '＋' };
const KIND_LABEL = { ok: '合っている', wrong: '違う', missing: '抜けている', extra: '余分' };

export async function startDictation(root, ctx) {
  const { sentences: given = [], getAudioBlob, onExit } = ctx || {};
  const audio = await import('../audio.js');
  const sentences = (Array.isArray(given) ? given : []).filter(isValidSentence).sort((a, b) => a.id - b.id);

  let data = loadDictation();
  let settings = normalizeDictationSettings(data.settings, sentences);
  let canSave = true;

  // ---- 音声 ----
  const blobCache = new Map(); // file → Blob（今の問題と次の問題だけ）
  const pending = new Map();
  let preparedFile = null;

  // 「ゆっくり」用の Audio 要素（audio.js とは別。playbackRate を変えるため）
  const slow = new Audio();
  slow.preload = 'auto';
  let slowFile = null;
  let slowUrl = null;
  let slowEnd = 0;
  let slowTimer = 0;

  function fetchBlob(file) {
    if (blobCache.has(file)) return Promise.resolve(blobCache.get(file));
    if (pending.has(file)) return pending.get(file);
    const p = Promise.resolve()
      .then(() => getAudioBlob(file))
      .then((b) => { pending.delete(file); if (b) blobCache.set(file, b); return b || null; },
        (e) => { pending.delete(file); console.warn(e); return null; });
    pending.set(file, p);
    return p;
  }

  function keepOnly(files) {
    for (const k of [...blobCache.keys()]) if (!files.includes(k)) blobCache.delete(k);
  }

  /** 手元の Blob で両方の Audio 要素を用意する。できたら true */
  function prepareNow(file) {
    const blob = blobCache.get(file);
    if (!blob) return false;
    if (preparedFile !== file) {
      audio.prepare(file, blob);
      preparedFile = file;
    }
    if (slowFile !== file) {
      stopSlow();
      if (slowUrl) URL.revokeObjectURL(slowUrl);
      slowUrl = URL.createObjectURL(blob);
      slow.src = slowUrl;
      slowFile = file;
      slow.load();
    }
    return true;
  }

  function stopSlow() {
    if (slowTimer) cancelAnimationFrame(slowTimer);
    slowTimer = 0;
    slowEnd = 0;
    if (!slow.paused) slow.pause();
  }

  function watchSlow() {
    if (slow.paused) { slowTimer = 0; return; }
    if (slow.currentTime >= slowEnd) { stopSlow(); return; }
    slowTimer = requestAnimationFrame(watchSlow);
  }
  // 画面が消えている間は requestAnimationFrame が止まるので timeupdate でも見張る
  slow.addEventListener('timeupdate', () => {
    if (slowEnd && !slow.paused && slow.currentTime >= slowEnd) stopSlow();
  });

  function stopAll() {
    audio.stop();
    stopSlow();
  }

  /** ゆっくり再生（ボタンの処理の中で await をはさまずに呼ぶ） */
  function playSlow(range) {
    audio.stop();
    stopSlow();
    slowEnd = range[1];
    const begin = () => {
      slow.currentTime = range[0];
      slow.defaultPlaybackRate = SLOW_RATE;
      slow.playbackRate = SLOW_RATE;
      if ('preservesPitch' in slow) slow.preservesPitch = true;
      const p = slow.play();
      slowTimer = requestAnimationFrame(watchSlow);
      return p;
    };
    if (slow.readyState >= 1) return begin();
    // iPhone は preload を無視して、play() するまで読み込まないことがある。
    // ボタンの処理の中で消音のまま play() しておき、メタデータが来たら位置と速さを合わせて音を出す。
    slow.muted = true;
    const first = slow.play();
    slow.addEventListener('loadedmetadata', () => {
      slow.currentTime = range[0];
      slow.defaultPlaybackRate = SLOW_RATE;
      slow.playbackRate = SLOW_RATE;
      slow.muted = false;
      if (slow.paused) slow.play().catch((e) => console.warn(e));
      slowTimer = requestAnimationFrame(watchSlow);
    }, { once: true });
    return first;
  }

  function cleanupAudio() {
    stopAll();
    if (slowUrl) URL.revokeObjectURL(slowUrl);
    slowUrl = null;
    slowFile = null;
    slow.removeAttribute('src');
  }

  function quit() {
    cleanupAudio();
    token += 1;
    if (typeof onExit === 'function') onExit();
  }

  // ---- 進行の状態 ----
  let list = [];      // 出題する例文
  let index = 0;
  let results = [];   // [{ id, percent, sentence }]
  let token = 0;      // 画面を切り替えるたびに増やす（古い読み込みの結果を捨てるため）

  function persist() {
    canSave = saveDictation(data);
  }

  function radioGroup(name, legend, options, current, onChange) {
    return el('fieldset', { class: 'choice-group' },
      el('legend', { class: 'field-label', text: legend }),
      el('div', { class: options.length === 2 ? 'choice-row choice-row-2' : 'choice-row' },
        options.map(([value, label]) => el('label', { class: 'choice' },
          el('input', {
            type: 'radio', name, value: String(value), checked: value === current,
            onchange: (ev) => { if (ev.target.checked) onChange(value); },
          }),
          el('span', { text: label }),
        )),
      ),
    );
  }

  // ======================================================
  // 設定の画面
  // ======================================================

  function renderSetup() {
    stopAll();
    token += 1;
    const stages = listStages(sentences);
    const bounds = idBounds(sentences);

    if (!bounds) {
      root.replaceChildren(el('div', { class: 'study dictation' },
        el('div', { class: 'study-body' },
          el('p', { class: 'kicker', text: 'ディクテーション' }),
          el('div', { class: 'card' }, el('p', { text: '例文がありません。データパックを確認してください。' })),
        ),
        el('div', { class: 'study-bottom' },
          el('button', { type: 'button', class: 'btn', onclick: quit }, 'ホームに戻る')),
      ));
      return;
    }

    const stageSelect = el('select', { class: 'select', id: 'dict-stage' },
      stages.map((s) => new Option(`ステージ ${s.stage}（例文 ${s.from}〜${s.to}）`, String(s.stage))));
    stageSelect.value = String(settings.stage);
    stageSelect.addEventListener('change', () => { settings.stage = Number(stageSelect.value); changed(); });

    const numInput = (id, value) => el('input', {
      type: 'number', id, class: 'num-input', inputmode: 'numeric', min: bounds.min, max: bounds.max, step: 1, value,
    });
    const fromInput = numInput('dict-from', settings.from);
    const toInput = numInput('dict-to', settings.to);
    const onIdsChange = () => {
      const c = clampIdRange(fromInput.value, toInput.value, sentences);
      settings.from = c.from;
      settings.to = c.to;
      fromInput.value = String(c.from);
      toInput.value = String(c.to);
      changed();
    };
    fromInput.addEventListener('change', onIdsChange);
    toInput.addEventListener('change', onIdsChange);

    const stageBox = el('div', {},
      el('label', { class: 'field-label', for: 'dict-stage', text: 'ステージ（50 文ごと）' }),
      stageSelect);
    const idsBox = el('div', {},
      el('p', { class: 'field-label', text: `例文の番号（${bounds.min}〜${bounds.max}）` }),
      el('div', { class: 'range-row' },
        fromInput, el('label', { for: 'dict-from', text: 'から' }),
        toInput, el('label', { for: 'dict-to', text: 'まで' }),
      ));
    const showRangeKind = () => {
      stageBox.hidden = settings.rangeKind !== 'stage';
      idsBox.hidden = settings.rangeKind !== 'ids';
    };
    showRangeKind();

    const rangeKindGroup = radioGroup('dict-range-kind', '範囲の選び方',
      [['stage', 'ステージで選ぶ'], ['ids', '番号で選ぶ']], settings.rangeKind,
      (v) => { settings.rangeKind = v; showRangeKind(); changed(); });
    const orderGroup = radioGroup('dict-order', '出題順',
      [['id', '番号順'], ['random', 'ランダム']], settings.order,
      (v) => { settings.order = v; changed(); });

    const countSelect = el('select', { class: 'select', id: 'dict-count' },
      COUNT_CHOICES.map((c) => new Option(c === 'all' ? '範囲すべて' : `${c} 問`, String(c))));
    countSelect.value = String(settings.count);
    countSelect.addEventListener('change', () => {
      settings.count = countSelect.value === 'all' ? 'all' : Number(countSelect.value);
      changed();
    });

    const hintCheck = el('input', { type: 'checkbox', checked: settings.hint });
    hintCheck.addEventListener('change', () => { settings.hint = hintCheck.checked; changed(); });

    const summary = el('p', { class: 'listen-summary', 'aria-live': 'polite' });
    const skipped = el('p', { class: 'muted small' });
    const saveNote = el('p', { class: 'muted small' });
    const startBtn = el('button', { type: 'button', class: 'btn btn-primary btn-start' }, '書き取りを始める');
    startBtn.addEventListener('click', () => {
      const qs = buildQuestionList(sentences, settings);
      if (!qs.length) return;
      startRound(qs);
    });

    function refresh() {
      const range = settings.rangeKind === 'ids'
        ? sentences.filter((s) => s.id >= settings.from && s.id <= settings.to)
        : sentences.filter((s) => stageOf(s.id) === settings.stage);
      const usable = selectDictationRange(sentences, settings);
      const n = settings.count === 'all' ? usable.length : Math.min(settings.count, usable.length);
      const label = settings.rangeKind === 'stage' ? `ステージ ${settings.stage}` : `例文 ${settings.from}〜${settings.to}`;
      summary.textContent = `${label}：${n} 問（${settings.order === 'random' ? 'ランダム' : '番号順'}）`;
      const missing = range.length - usable.length;
      skipped.textContent = missing > 0 ? `英文か音声の区切りがない例文 ${missing} 文は出しません。` : '';
      saveNote.textContent = canSave ? '' : 'この画面では記録を保存できません（プライベートブラウズなど）。';
      startBtn.disabled = n === 0;
      startBtn.textContent = n === 0 ? '出題できる例文がありません' : '書き取りを始める';
    }

    function changed() {
      data = { ...data, settings: { ...settings } };
      persist();
      refresh();
    }

    root.replaceChildren(el('div', { class: 'study listen dictation' },
      el('div', { class: 'study-body' },
        el('p', { class: 'kicker', text: 'ディクテーション' }),
        el('div', { class: 'card' },
          el('h3', { text: '範囲' }),
          rangeKindGroup,
          stageBox,
          idsBox,
        ),
        el('div', { class: 'card' },
          el('h3', { text: '出し方' }),
          orderGroup,
          el('label', { class: 'field-label', for: 'dict-count', text: '問題数' }),
          countSelect,
          el('label', { class: 'check-row' }, hintCheck, el('span', { text: 'ヒント（語数を「_ _ _」で見せる）' })),
        ),
      ),
      el('div', { class: 'study-bottom' },
        summary,
        skipped,
        saveNote,
        startBtn,
        el('button', { type: 'button', class: 'btn', onclick: quit }, 'ホームに戻る'),
      ),
    ));
    window.scrollTo(0, 0);
    refresh();
  }

  function startRound(qs) {
    list = qs;
    index = 0;
    results = [];
    renderQuestion();
  }

  // ======================================================
  // 問題の画面
  // ======================================================

  function head() {
    const total = list.length;
    const bar = el('div', { class: 'progress-bar' });
    bar.style.width = `${Math.round((index / total) * 100)}%`;
    return el('div', { class: 'study-head' },
      el('span', { class: 'study-count', text: `${index + 1} / ${total}` }),
      el('div', {
        class: 'progress study-progress', role: 'progressbar', 'aria-label': '進み具合',
        'aria-valuemin': 0, 'aria-valuemax': total, 'aria-valuenow': index,
      }, bar),
      el('button', { type: 'button', class: 'btn btn-quit', onclick: quit }, 'やめる'),
    );
  }

  /** 「▶ 聞く」「ゆっくり」のボタン。音声の用意ができたら押せるようにする */
  function listenButtons(s, notice, primary) {
    const range = segmentFor(s, 'en');
    const playBtn = el('button', { type: 'button', class: `btn btn-listen${primary ? ' btn-primary' : ''}`, disabled: true }, '音声を準備中…');
    const slowBtn = el('button', { type: 'button', class: 'btn btn-listen', disabled: true }, 'ゆっくり');
    const fail = (e) => {
      console.warn(e);
      notice.textContent = MSG_PLAY_FAILED;
      notice.hidden = false;
    };
    playBtn.addEventListener('click', () => {
      notice.hidden = true;
      stopSlow();
      // await をはさまずに再生を始める（iPhone 対策）
      audio.playSegment(range[0], range[1]).catch(fail);
    });
    slowBtn.addEventListener('click', () => {
      notice.hidden = true;
      playSlow(range).catch(fail);
    });
    const ready = () => {
      playBtn.disabled = false;
      slowBtn.disabled = false;
      playBtn.textContent = '▶ 聞く';
      slowBtn.textContent = `ゆっくり（×${SLOW_RATE}）`;
    };
    const my = token;
    if (prepareNow(s.file)) ready();
    else {
      fetchBlob(s.file).then((blob) => {
        if (my !== token) return;
        if (!blob) {
          playBtn.textContent = '音声が見つかりません';
          notice.textContent = `例文 ${s.id} の音声が見つかりません。データパックを入れ直してください。`;
          notice.hidden = false;
          return;
        }
        prepareNow(s.file);
        ready();
      });
    }
    return el('div', { class: 'btn-row' }, playBtn, slowBtn);
  }

  function preloadNext() {
    const cur = list[index];
    const nxt = list[index + 1];
    keepOnly([cur && cur.file, nxt && nxt.file].filter(Boolean));
    if (nxt) fetchBlob(nxt.file);
  }

  function renderQuestion() {
    stopAll();
    token += 1;
    const s = list[index];
    const notice = el('p', { class: 'error', role: 'alert', hidden: true });
    const rec = data.records[s.id];
    const hint = settings.hint ? hintPattern(s.en) : null;

    const input = el('textarea', {
      class: 'dict-input', id: 'dict-input', rows: 4, lang: 'en', inputmode: 'text', enterkeyhint: 'enter',
      autocapitalize: 'off', autocorrect: 'off', autocomplete: 'off', spellcheck: 'false',
      placeholder: '聞こえた英語を書こう',
    });
    const checkBtn = el('button', { type: 'button', class: 'btn btn-primary btn-next' }, '答え合わせ');
    checkBtn.addEventListener('click', () => {
      const r = scoreDictation(s.en, input.value);
      results.push({ id: s.id, percent: r.percent, sentence: s });
      data = addResult(data, s.id, r.percent);
      persist();
      renderAnswer(s, input.value, r);
    });

    root.replaceChildren(el('div', { class: 'study dictation' },
      head(),
      el('div', { class: 'study-body' },
        el('div', { class: 'card' },
          el('div', { class: 'listen-head' },
            el('span', { class: 'listen-number', text: `例文 ${s.id}` }),
            rec ? el('span', { class: 'muted small', text: `前回 ${rec.last}%・最高 ${rec.best}%` }) : null,
          ),
          el('p', { class: 'dict-lead', text: '英語を聞いて、聞こえたとおりに書こう。' }),
          hint ? el('p', { class: 'dict-hint', lang: 'en', 'aria-label': `ヒント：${hint.count} 語` },
            el('span', { class: 'dict-hint-pattern', text: hint.pattern }),
            el('span', { class: 'muted small', text: `（${hint.count} 語）` })) : null,
          listenButtons(s, notice, true),
          el('label', { class: 'field-label', for: 'dict-input', text: '書き取り（大文字・小文字、記号は気にしなくてよい）' }),
          input,
        ),
        notice,
      ),
      el('div', { class: 'study-bottom' }, checkBtn),
    ));
    window.scrollTo(0, 0);
    preloadNext();
  }

  // ======================================================
  // 答え合わせの画面
  // ======================================================

  function wordChip(it) {
    const mark = el('span', { class: 'dict-mark', 'aria-hidden': 'true', text: KIND_MARK[it.kind] });
    let body;
    if (it.kind === 'wrong') {
      body = el('span', { class: 'dict-word', lang: 'en' },
        el('s', { class: 'dict-got', text: it.got }), ' → ', el('strong', { text: it.expected }));
    } else if (it.kind === 'extra') {
      body = el('span', { class: 'dict-word', lang: 'en' }, el('s', { class: 'dict-got', text: it.got }));
    } else {
      body = el('span', { class: 'dict-word', lang: 'en', text: it.expected });
    }
    const sr = it.kind === 'wrong'
      ? `違う：${it.got} → ${it.expected}`
      : `${KIND_LABEL[it.kind]}：${it.kind === 'extra' ? it.got : it.expected}`;
    return el('li', { class: `dict-chip is-${it.kind}`, 'aria-label': sr }, mark, body);
  }

  function renderAnswer(s, typed, r) {
    stopAll();
    token += 1;
    const notice = el('p', { class: 'error', role: 'alert', hidden: true });
    const isLast = index + 1 >= list.length;
    const good = r.percent >= LOW_THRESHOLD;
    const nextBtn = el('button', { type: 'button', class: 'btn btn-primary btn-next' }, isLast ? '結果を見る' : '次へ');
    nextBtn.addEventListener('click', () => {
      if (isLast) renderEnd();
      else { index += 1; renderQuestion(); }
    });

    const counts = [
      `○ ${r.ok}`, `× ${r.wrong}`, `― ${r.missing}`, r.extra ? `＋ 余分 ${r.extra}` : null,
    ].filter(Boolean).join('　');

    root.replaceChildren(el('div', { class: 'study dictation' },
      head(),
      el('div', { class: 'study-body' },
        el('div', { class: 'card' },
          el('div', { class: 'listen-head' },
            el('span', { class: 'listen-number', text: `例文 ${s.id}` })),
          el('p', { class: `result ${good ? 'ok' : 'ng'}` },
            el('span', { class: 'result-mark', 'aria-hidden': 'true', text: good ? '○' : '△' }),
            `${r.percent}%`,
            el('span', { class: 'dict-score-detail', text: `（${r.ok} / ${r.total} 語）` })),
          el('p', { class: 'muted small', text: counts }),
          el('ul', { class: 'dict-words', 'aria-label': '語ごとの結果' }, r.items.map(wordChip)),
          el('p', { class: 'dict-legend muted small', text: '○ 合っている　× 違う（書いた語 → 正しい語）　― 抜けている　＋ 余分' }),
        ),
        el('div', { class: 'card' },
          el('p', { class: 'field-label', text: '正しい英文' }),
          el('p', { class: 'sentence-en', lang: 'en', text: s.en }),
          el('p', { class: 'field-label', text: '和訳' }),
          el('p', { class: 'sentence-ja', text: s.ja || '（和訳がありません）' }),
          el('p', { class: 'field-label', text: 'あなたの書き取り' }),
          el('p', { class: 'dict-typed', lang: 'en', text: typed.trim() ? typed : '（何も書いていません）' }),
          listenButtons(s, notice, false),
        ),
        notice,
      ),
      el('div', { class: 'study-bottom' }, nextBtn),
    ));
    window.scrollTo(0, 0);
  }

  // ======================================================
  // 終了の画面
  // ======================================================

  function renderEnd() {
    stopAll();
    token += 1;
    const sum = summarizeResults(results);
    const lowSentences = sum.low.map((r) => r.sentence);

    const rowsList = el('ol', { class: 'dict-result-list' },
      results.map((r) => el('li', { class: r.percent < LOW_THRESHOLD ? 'is-low' : '' },
        el('span', { class: 'dict-result-id', text: `例文 ${r.id}` }),
        el('span', { class: 'dict-result-pct', text: `${r.percent < LOW_THRESHOLD ? '△' : '○'} ${r.percent}%` }),
      )));

    const lowCard = sum.low.length
      ? el('div', { class: 'card' },
        el('h3', { text: `${LOW_THRESHOLD}% 未満の文（${sum.low.length} 文）` }),
        el('ul', { class: 'missed-list' },
          sum.low.map((r) => el('li', {},
            el('span', { class: 'missed-word', text: `例文 ${r.id}（${r.percent}%）` }),
            el('span', { lang: 'en', text: r.sentence.en })))))
      : el('div', { class: 'card' }, el('p', { text: `全部 ${LOW_THRESHOLD}% 以上でした。よくできました。` }));

    root.replaceChildren(el('div', { class: 'study dictation' },
      el('div', { class: 'study-body' },
        el('p', { class: 'kicker', text: 'ディクテーションの結果' }),
        el('div', { class: 'card' },
          el('p', { class: 'score' }, '平均 ', el('strong', { class: 'score-num', text: `${sum.average}` }), ' %'),
          el('p', { class: 'muted small', text: `${sum.count} 文` }),
          rowsList,
        ),
        lowCard,
        canSave ? null : el('p', { class: 'error', text: '記録を保存できませんでした（プライベートブラウズなど）。' }),
      ),
      el('div', { class: 'study-bottom' },
        sum.low.length
          ? el('button', { type: 'button', class: 'btn btn-primary', onclick: () => startRound(lowSentences) },
            `${LOW_THRESHOLD}% 未満だけもう一度（${sum.low.length} 文）`)
          : null,
        el('button', { type: 'button', class: 'btn', onclick: renderSetup }, '範囲・出し方を変える'),
        el('button', { type: 'button', class: 'btn', onclick: quit }, 'ホームに戻る'),
      ),
    ));
    window.scrollTo(0, 0);
  }

  renderSetup();
}
