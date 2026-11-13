// 瞬間英作文（日本語の音声を聞く → 自分で英語を言う → 英語の音声で確認 → 自己採点）
//
// 使い方：startCompose(root, { words, sentences, sentencesById, getAudioBlob, onExit })
//   root          … 描画先の要素（この中だけに描く）
//   words         … 全単語（見出し語の太字と「この文の単語」に使う）
//   sentences     … 全例文（番号順の配列）
//   sentencesById … 例文の Map（使わなくてもよい。sentences が無いときの予備）
//   getAudioBlob  … ファイル名 → Blob
//   onExit        … やめたときに呼ぶ（ホームに戻す）
//
// この画面で決めたこと：
// - 範囲は「ステージ（srs.stageOf と同じ 50 文ごと）」か「例文番号の から〜まで」。
//   範囲の計算・画面の言葉は例文リスニング（listening.js）とそろえ、同じ関数を使う。
// - 出題できるのは、音声ファイルがあり seg.ja と seg.en1 の両方が正しい例文だけ（それ以外は飛ばし、件数を出す）。
// - 出題順は「番号順」か「ランダム」。ランダムの順番は設定画面で範囲を決めた時点で決める
//   （1 問目の音声を「始める」より前に用意しておくため）。
// - 1 問の流れ：日本語の音声（seg.ja）を 1 回流す → 和訳（設定で隠せる）と考える時間（経過秒数）を表示
//   →「英語を確認」で英文と「この文の単語」を表示し、英語の音声（seg.en1）を流す
//   → 自己採点 ○（言えた）△（少し違った）×（言えなかった）→「次へ」。
//   採点する前は「日本語をもう一度」「英語をもう一度」で何度でも聞ける。採点した後は聞き直しボタンを出さない
//   （次の文の音声に切り替えておくため）。
// - 太字にする見出し語は、その例文が代表の例文（sentenceIds[0]）になっている語。
//   位置は quiz.findForm（form、無ければ word）で探し、重なる位置はまとめる。
// - 記録は localStorage 'kk.compose.v1' に { settings, records } で保存する（読み書きは try/catch）。
//   records は例文番号ごとに { last: 'ok'|'partial'|'ng', date: 'YYYY-MM-DD', count: 採点した回数 }。
//   箱（box）・期限（due）には触らない（変えてよいのは「今日の学習」だけ）。
// - 「前回 × だった文だけ」は records の last が 'ng' の文に絞る。
// - 終了画面の「×と△だけもう一度」は、その回の × と △ の文を同じ順で出し直す。
//
// 音声（audio.js）について：
// - audio.js は読み込むと Audio 要素を作るため、startCompose の中で動的 import する
//   （DOM を使わない関数はこのファイルから export して node のテストで確かめる）。
// - iPhone 対策：音声は表示した時点（または採点した時点）で prepare() しておき、
//   「始める」「次へ」「英語を確認」などのボタンの処理の中では playSegment() だけを呼ぶ。
//   採点した時点で英語の音声が流れていたら、流れ終わってから次の文を prepare() する（音を途中で切らないため）。

import { todayStr } from '../srs.js';
import { findForm } from '../quiz.js';
import { listStages, idBounds, clampIdRange, selectRange, segmentFor } from './listening.js';

export const COMPOSE_KEY = 'kk.compose.v1';
export const GRADES = Object.freeze(['ok', 'partial', 'ng']);
export const ORDERS = Object.freeze(['number', 'random']);
export const DEFAULT_COMPOSE_SETTINGS = Object.freeze({
  rangeKind: 'stage', // 'stage' | 'ids'
  stage: 1,
  from: 1,
  to: 50,
  order: 'number',    // 'number' | 'random'
  showJa: true,       // 和訳の文字を見せる
  onlyMissed: false,  // 前回 × だった文だけ
});

const GRADE_MARK = { ok: '○', partial: '△', ng: '×' };
const GRADE_LABEL = { ok: '言えた', partial: '少し違った', ng: '言えなかった' };
const MSG_PLAY_FAILED = '音声を再生できませんでした。マナーモードや音量を確認して、もう一度押してください。';
const MSG_SAVE_FAILED = '記録を保存できませんでした（プライベートブラウズなど）。この回の結果は、アプリを閉じると消えます。';

// ---------- DOM を使わない部分（テスト対象） ----------

function toNum(v) {
  if (v === null || v === '' || typeof v === 'boolean') return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function isValidSentence(s) {
  return !!s && Number.isInteger(s.id) && s.id > 0;
}

function isDateStr(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/**
 * 設定を正しい形に直す（壊れた値は既定値に戻す）。
 * sentences を渡すと、ステージと番号の範囲を実際の例文に合わせる。
 */
export function normalizeComposeSettings(raw, sentences = null) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const d = DEFAULT_COMPOSE_SETTINGS;
  const posInt = (v, def) => {
    const n = toNum(v);
    return Number.isInteger(n) && n >= 1 ? n : def;
  };
  const out = {
    rangeKind: r.rangeKind === 'ids' ? 'ids' : 'stage',
    stage: posInt(r.stage, d.stage),
    from: posInt(r.from, d.from),
    to: posInt(r.to, d.to),
    order: ORDERS.includes(r.order) ? r.order : d.order,
    showJa: typeof r.showJa === 'boolean' ? r.showJa : d.showJa,
    onlyMissed: r.onlyMissed === true,
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

/** 1 文の記録を正しい形に直す。直せなければ null */
function normalizeRecord(rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null;
  if (!GRADES.includes(rec.last)) return null;
  const count = toNum(rec.count);
  return {
    last: rec.last,
    date: isDateStr(rec.date) ? rec.date : '',
    count: Number.isInteger(count) && count >= 1 ? count : 1,
  };
}

/** 記録全体（例文番号 → 記録）を正しい形に直す。番号が正の整数でないもの・壊れた記録は捨てる */
export function normalizeRecords(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    const id = Number(k);
    if (!Number.isInteger(id) || id < 1) continue;
    const rec = normalizeRecord(v);
    if (rec) out[String(id)] = rec;
  }
  return out;
}

/**
 * 自己採点を記録に足す（元の records は変えずに新しいオブジェクトを返す）。
 * grade が GRADES 以外、id が正の整数でないときは、そのままのコピーを返す。
 */
export function applyGrade(records, sentenceId, grade, dateStr) {
  const out = { ...normalizeRecords(records) };
  if (!Number.isInteger(sentenceId) || sentenceId < 1 || !GRADES.includes(grade)) return out;
  const key = String(sentenceId);
  const prev = out[key];
  out[key] = { last: grade, date: isDateStr(dateStr) ? dateStr : '', count: (prev ? prev.count : 0) + 1 };
  return out;
}

function defaultStorage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

/** 保存した設定と記録を読む。無い・壊れている・使えない環境では既定値と空の記録 */
export function loadComposeData(storage = defaultStorage()) {
  const empty = { settings: { ...DEFAULT_COMPOSE_SETTINGS }, records: {} };
  try {
    if (!storage) return empty;
    const text = storage.getItem(COMPOSE_KEY);
    if (!text) return empty;
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return empty;
    return { settings: normalizeComposeSettings(data.settings), records: normalizeRecords(data.records) };
  } catch {
    return empty;
  }
}

/** 設定と記録をまとめて保存する。保存できたら true（使えない環境・容量不足では false） */
export function saveComposeData({ settings, records } = {}, storage = defaultStorage()) {
  try {
    if (!storage) return false;
    const data = { settings: normalizeComposeSettings(settings), records: normalizeRecords(records) };
    storage.setItem(COMPOSE_KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

/** 出題できる例文か（音声ファイルがあり、seg.ja と seg.en1 が正しい） */
export function isComposable(sentence) {
  return isValidSentence(sentence) && segmentFor(sentence, 'ja') !== null && segmentFor(sentence, 'en') !== null;
}

/** 出題順に並べる（元の配列は変えない）。random は Fisher–Yates、それ以外は番号順 */
export function orderSentences(list, order, rng = Math.random) {
  const a = (Array.isArray(list) ? list : []).slice();
  if (order !== 'random') return a.sort((x, y) => x.id - y.id);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.max(0, Math.floor(rng() * (i + 1))));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 前回 × だった文か */
export function isLastMissed(records, sentenceId) {
  const rec = records && records[String(sentenceId)];
  return !!rec && rec.last === 'ng';
}

/**
 * 設定の範囲から出題する例文の一覧を作る。
 * @returns {{ list: object[], inRange: number, skipped: number, missedInRange: number }}
 *   list … 出題順に並べた例文、inRange … 範囲の例文の数、skipped … 音声の区切りがなく飛ばす数、
 *   missedInRange … 範囲の中で（出題できる文のうち）前回 × だった数
 */
export function buildQuestionList(sentences, settings, records = {}, rng = Math.random) {
  const st = normalizeComposeSettings(settings);
  const range = selectRange(sentences, st);
  const playable = range.filter(isComposable);
  const missed = playable.filter((s) => isLastMissed(records, s.id));
  const base = st.onlyMissed ? missed : playable;
  return {
    list: orderSentences(base, st.order, rng),
    inRange: range.length,
    skipped: range.length - playable.length,
    missedInRange: missed.length,
  };
}

/** その例文が代表の例文（sentenceIds[0]）になっている語 */
export function wordsForSentence(words, sentenceId) {
  return (Array.isArray(words) ? words : []).filter(
    (w) => w && Array.isArray(w.sentenceIds) && w.sentenceIds[0] === sentenceId,
  );
}

/**
 * 英文の中の見出し語の位置（太字にする範囲）。[{ start, end, wordIds }] を始まりの順で返す。
 * - 1 語につき最初の 1 か所（quiz.findForm の探し方）。form が空なら word で探す。
 * - 重なる・接する範囲は 1 つにまとめる（熟語とその中の語など）。
 * - 見つからない語は含めない。
 */
export function boldRanges(en, words) {
  if (typeof en !== 'string' || !en) return [];
  const hits = [];
  for (const w of Array.isArray(words) ? words : []) {
    if (!w) continue;
    const key = typeof w.form === 'string' && w.form.trim() ? w.form : (typeof w.word === 'string' ? w.word : '');
    if (!key) continue;
    let f = null;
    try { f = findForm(en, key); } catch { f = null; }
    if (!f || !f.target) continue;
    const start = f.before.length;
    hits.push({ start, end: start + f.target.length, wordIds: [w.id] });
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged = [];
  for (const h of hits) {
    const last = merged[merged.length - 1];
    if (last && h.start <= last.end) {
      last.end = Math.max(last.end, h.end);
      for (const id of h.wordIds) if (!last.wordIds.includes(id)) last.wordIds.push(id);
    } else {
      merged.push({ start: h.start, end: h.end, wordIds: [...h.wordIds] });
    }
  }
  return merged;
}

/** 文字列を範囲で区切る。[{ text, bold }]（空の部分は入れない） */
export function splitByRanges(text, ranges) {
  const s = typeof text === 'string' ? text : '';
  const out = [];
  let pos = 0;
  for (const r of Array.isArray(ranges) ? ranges : []) {
    const start = Math.max(pos, Math.min(s.length, r.start));
    const end = Math.max(start, Math.min(s.length, r.end));
    if (start > pos) out.push({ text: s.slice(pos, start), bold: false });
    if (end > start) out.push({ text: s.slice(start, end), bold: true });
    pos = end;
  }
  if (pos < s.length) out.push({ text: s.slice(pos), bold: false });
  return out;
}

/** 「この文の単語」を英文に出てくる順に並べる（見つからない語は最後に、元の順で） */
export function orderWordsBySentence(en, words) {
  const list = Array.isArray(words) ? words.filter(Boolean) : [];
  const pos = new Map();
  for (const w of list) {
    const r = boldRanges(en, [w]);
    pos.set(w, r.length ? r[0].start : Infinity);
  }
  return list
    .map((w, i) => ({ w, i }))
    .sort((a, b) => (pos.get(a.w) - pos.get(b.w)) || (a.i - b.i))
    .map((x) => x.w);
}

/**
 * その回の結果をまとめる。results = [{ id, grade }]
 * @returns {{ ok, partial, ng, total, retryIds: number[] }} retryIds は × と △ の文の番号（出題した順）
 */
export function summarizeResults(results) {
  const sum = { ok: 0, partial: 0, ng: 0, total: 0, retryIds: [] };
  for (const r of Array.isArray(results) ? results : []) {
    if (!r || !GRADES.includes(r.grade)) continue;
    sum[r.grade] += 1;
    sum.total += 1;
    if (r.grade !== 'ok' && !sum.retryIds.includes(r.id)) sum.retryIds.push(r.id);
  }
  return sum;
}

/** 経過秒数を「12 秒」「1 分 05 秒」にする */
export function formatElapsed(sec) {
  const s = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0));
  if (s < 60) return `${s} 秒`;
  return `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, '0')} 秒`;
}

// ---------- 画面（DOM） ----------

/**
 * 要素を作る（today.js と同じ書き方）。props の class / text / on○○ は特別扱い、それ以外は属性
 * children は文字列か Node（null / false は無視）
 */
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

export async function startCompose(root, ctx) {
  const { words: givenWords = [], sentences: given, sentencesById, getAudioBlob, onExit } = ctx || {};
  const audio = await import('../audio.js');
  let source = Array.isArray(given) ? given : [];
  if (!source.length && sentencesById) {
    source = sentencesById instanceof Map ? [...sentencesById.values()] : Object.values(sentencesById);
  }
  const sentences = source.filter(isValidSentence).sort((a, b) => a.id - b.id);
  const sentenceMap = new Map(sentences.map((s) => [s.id, s]));
  const words = Array.isArray(givenWords) ? givenWords : [];

  const loaded = loadComposeData();
  let settings = normalizeComposeSettings(loaded.settings, sentences);
  let records = loaded.records;
  let saveFailed = false;

  function persist() {
    const ok = saveComposeData({ settings, records });
    if (!ok) saveFailed = true;
    return ok;
  }

  // ---- 音声の読み込み（今の文と次の文だけ手元に置く） ----
  const blobCache = new Map(); // file → Blob
  const pending = new Map();   // file → Promise<Blob|null>
  let preparedFile = null;     // audio.prepare() 済みのファイル
  let playing = false;         // 区間を再生中か
  let deferredFile = null;     // 再生が終わったら prepare するファイル

  function fetchBlob(file) {
    if (!file) return Promise.resolve(null);
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

  /** 手元に Blob があれば、その場で prepare する。できたら true */
  function prepareNow(file) {
    if (file === preparedFile) return true;
    const blob = blobCache.get(file);
    if (!blob) return false;
    audio.prepare(file, blob);
    preparedFile = file;
    playing = false;
    return true;
  }

  /** 再生中なら終わってから、そうでなければすぐに prepare する */
  function prepareSoon(file) {
    if (!file || file === preparedFile) return;
    if (playing) { deferredFile = file; return; }
    prepareNow(file);
  }

  function stopAudio() {
    playing = false;
    deferredFile = null;
    audio.stop();
  }

  /**
   * 例文の区間を再生する（ボタンの処理の中から呼ぶ）。kind は 'ja' | 'en'
   * 用意できていればその場で playSegment()、まだなら読み込んでから（その場合 iPhone では拒否されることがある）
   */
  function playPart(sentence, kind, onFail) {
    const range = segmentFor(sentence, kind);
    if (!range) { onFail('この文の音声はありません。'); return; }
    deferredFile = null;
    const run = () => {
      playing = true;
      audio.playSegment(range[0], range[1], {
        onFinish: () => {
          playing = false;
          if (deferredFile) { const f = deferredFile; deferredFile = null; prepareNow(f); }
        },
      }).catch((e) => { console.warn(e); playing = false; onFail(MSG_PLAY_FAILED); });
    };
    if (prepareNow(sentence.file)) { run(); return; }
    const tok = screenToken;
    fetchBlob(sentence.file).then((blob) => {
      if (tok !== screenToken) return;
      if (!blob) { onFail(`例文 ${sentence.id} の音声が見つかりません。データパックを入れ直してください。`); return; }
      prepareNow(sentence.file);
      run();
    });
  }

  // ---- 画面の状態 ----
  let screenToken = 0;  // 画面を描き直したら増やす（古い非同期処理を捨てるため）
  let tickTimer = 0;    // 考える時間の表示
  let round = [];       // この回に出す例文
  let index = 0;
  let results = [];     // [{ id, grade }]
  let isRetry = false;  // 「×と△だけもう一度」の回か

  function beginScreen() {
    screenToken += 1;
    if (tickTimer) { clearInterval(tickTimer); tickTimer = 0; }
  }

  function quit() {
    beginScreen();
    stopAudio();
    if (typeof onExit === 'function') onExit();
  }

  function quitButton() {
    return el('button', { type: 'button', class: 'btn btn-quit', onclick: quit }, 'やめる');
  }

  /** 「始める」系のボタンを、指定の文の音声を用意してから押せるようにする */
  function armStartButton(btn, sentence, label) {
    const tok = screenToken;
    const ready = () => { btn.disabled = false; btn.textContent = label; };
    if (!sentence) { btn.disabled = true; return; }
    if (prepareNow(sentence.file)) { ready(); return; }
    btn.disabled = true;
    btn.textContent = '音声を準備中…';
    fetchBlob(sentence.file).then((blob) => {
      if (tok !== screenToken) return;
      if (!blob) { btn.textContent = '音声が見つかりません'; return; }
      keepOnly([sentence.file]);
      prepareNow(sentence.file);
      ready();
    });
  }

  // ======================================================
  // 設定画面
  // ======================================================

  function radioGroup(name, legend, options, current, onChange) {
    return el('fieldset', { class: 'choice-group' },
      el('legend', { class: 'field-label', text: legend }),
      el('div', { class: options.length === 2 ? 'choice-row choice-row-2' : 'choice-row' },
        options.map(([value, label]) => el('label', { class: 'choice' },
          el('input', {
            type: 'radio', name, value, checked: value === current,
            onchange: (ev) => { if (ev.target.checked) onChange(value); },
          }),
          el('span', { text: label }),
        )),
      ),
    );
  }

  function renderSetup() {
    beginScreen();
    stopAudio();
    const stages = listStages(sentences);
    const bounds = idBounds(sentences);

    if (!bounds) {
      root.replaceChildren(el('div', { class: 'study compose' },
        el('div', { class: 'study-body' },
          el('p', { class: 'kicker', text: '瞬間英作文' }),
          el('div', { class: 'card' }, el('p', { text: '例文がありません。データパックを確認してください。' })),
        ),
        el('div', { class: 'study-bottom' },
          el('button', { type: 'button', class: 'btn', onclick: quit }, 'ホームに戻る')),
      ));
      return;
    }

    // 範囲
    const stageSelect = el('select', { class: 'select', id: 'compose-stage' },
      stages.map((s) => new Option(`ステージ ${s.stage}（例文 ${s.from}〜${s.to}）`, String(s.stage))));
    stageSelect.value = String(settings.stage);
    stageSelect.addEventListener('change', () => { settings.stage = Number(stageSelect.value); changed(); });

    const numInput = (id, value) => el('input', {
      type: 'number', id, class: 'num-input', inputmode: 'numeric', min: bounds.min, max: bounds.max, step: 1, value,
    });
    const fromInput = numInput('compose-from', settings.from);
    const toInput = numInput('compose-to', settings.to);
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
      el('label', { class: 'field-label', for: 'compose-stage', text: 'ステージ（50 文ごと）' }),
      stageSelect);
    const idsBox = el('div', {},
      el('p', { class: 'field-label', text: `例文の番号（${bounds.min}〜${bounds.max}）` }),
      el('div', { class: 'range-row' },
        fromInput, el('label', { for: 'compose-from', text: 'から' }),
        toInput, el('label', { for: 'compose-to', text: 'まで' }),
      ));
    const showRangeKind = () => {
      stageBox.hidden = settings.rangeKind !== 'stage';
      idsBox.hidden = settings.rangeKind !== 'ids';
    };
    showRangeKind();

    const rangeKindGroup = radioGroup('compose-range-kind', '範囲の選び方',
      [['stage', 'ステージで選ぶ'], ['ids', '番号で選ぶ']], settings.rangeKind,
      (v) => { settings.rangeKind = v; showRangeKind(); changed(); });

    const orderGroup = radioGroup('compose-order', '出題順',
      [['number', '番号順'], ['random', 'ランダム']], settings.order,
      (v) => { settings.order = v; changed(); });

    const jaCheck = el('input', { type: 'checkbox', checked: settings.showJa });
    jaCheck.addEventListener('change', () => { settings.showJa = jaCheck.checked; changed(); });

    const missedCheck = el('input', { type: 'checkbox', checked: settings.onlyMissed });
    missedCheck.addEventListener('change', () => { settings.onlyMissed = missedCheck.checked; changed(); });
    const missedNote = el('span', { class: 'muted small' });

    // 下：要約と開始ボタン
    const summary = el('p', { class: 'listen-summary', 'aria-live': 'polite' });
    const skipped = el('p', { class: 'muted small' });
    const saveNote = el('p', { class: 'muted small' });
    const startBtn = el('button', { type: 'button', class: 'btn btn-primary btn-start', disabled: true }, '音声を準備中…');
    let planned = [];

    startBtn.addEventListener('click', () => {
      if (!planned.length) return;
      // await をはさまずに 1 問目の日本語を流す（iPhone 対策）
      startRound(planned, false);
    });

    function refresh() {
      const built = buildQuestionList(sentences, settings, records);
      planned = built.list;
      const label = settings.rangeKind === 'stage' ? `ステージ ${settings.stage}` : `例文 ${settings.from}〜${settings.to}`;
      summary.textContent = `${label}：${planned.length} 文${settings.onlyMissed ? '（前回 × の文だけ）' : ''}`;
      missedNote.textContent = `（この範囲に ${built.missedInRange} 文）`;
      skipped.textContent = built.skipped > 0 ? `音声の区切りがない例文 ${built.skipped} 文は出しません。` : '';
      saveNote.textContent = saveFailed ? '設定と記録を保存できません（プライベートブラウズなど）。' : '';
      if (!planned.length) {
        startBtn.disabled = true;
        startBtn.textContent = settings.onlyMissed ? '前回 × だった文はありません' : '出題できる例文がありません';
        return;
      }
      armStartButton(startBtn, planned[0], '▶ 始める（日本語が流れます）');
    }

    function changed() {
      screenToken += 1; // 準備中の古い音声を捨てる
      persist();
      refresh();
    }

    root.replaceChildren(el('div', { class: 'study compose' },
      el('div', { class: 'study-body' },
        el('p', { class: 'kicker', text: '瞬間英作文' }),
        el('p', { class: 'muted small compose-howto', text: '日本語を聞いて、英語で言ってみよう。言えたら「英語を確認」で答え合わせ。' }),
        el('div', { class: 'card' },
          el('h3', { text: '範囲' }),
          rangeKindGroup,
          stageBox,
          idsBox,
        ),
        el('div', { class: 'card' },
          el('h3', { text: '出し方' }),
          orderGroup,
          el('label', { class: 'check-row' }, jaCheck, el('span', { text: '和訳の文字を見せる' })),
          el('label', { class: 'check-row' }, missedCheck,
            el('span', {}, '前回 × だった文だけ ', missedNote)),
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

  // ======================================================
  // 出題画面
  // ======================================================

  /** 回を始める（ボタンの処理の中から呼ぶ） */
  function startRound(list, retry) {
    round = list.slice();
    index = 0;
    results = [];
    isRetry = retry;
    renderQuestion();
  }

  /** 次の文の音声を読み込んでおく */
  function preloadNext() {
    const cur = round[index];
    const nxt = round[index + 1];
    keepOnly([cur && cur.file, nxt && nxt.file, preparedFile].filter(Boolean));
    if (nxt) fetchBlob(nxt.file);
  }

  /** 英文（見出し語を太字） */
  function answerSentence(sentence, sentenceWords) {
    const p = el('p', { class: 'sentence-en', lang: 'en' });
    if (!sentence.en) {
      p.textContent = '（英文がありません）';
      p.classList.add('muted');
      return p;
    }
    for (const part of splitByRanges(sentence.en, boldRanges(sentence.en, sentenceWords))) {
      p.append(part.bold ? el('strong', { text: part.text }) : part.text);
    }
    return p;
  }

  /** 「この文の単語」の一覧 */
  function wordList(sentence, sentenceWords) {
    if (!sentenceWords.length) return null;
    return el('div', { class: 'compose-words' },
      el('p', { class: 'compose-words-title', text: 'この文の単語' }),
      el('ul', { class: 'compose-word-list' },
        orderWordsBySentence(sentence.en, sentenceWords).map((w) => el('li', {},
          el('span', { class: 'compose-word', lang: 'en', text: w.word || '' }),
          el('span', { class: 'compose-meaning', text: w.meaning || '' }),
          w.verified !== true ? el('span', { class: 'badge-unverified', title: 'まだ本と照合していない語です', text: '未確認' }) : null,
        ))),
    );
  }

  function renderQuestion() {
    beginScreen();
    const sentence = round[index];
    const total = round.length;
    const sentenceWords = wordsForSentence(words, sentence.id);
    const tok = screenToken;

    const notice = el('p', { class: 'error', role: 'alert', hidden: true });
    const showNotice = (msg) => {
      if (tok !== screenToken) return;
      notice.textContent = msg;
      notice.hidden = !msg;
    };

    // 和訳（設定で隠しているときは「和訳を見る」で出せる）
    const ja = el('p', { class: 'sentence-ja compose-ja', text: sentence.ja || '（和訳がありません）' });
    ja.hidden = !settings.showJa;
    const jaShowBtn = settings.showJa ? null : el('button', {
      type: 'button', class: 'btn btn-subtle compose-ja-btn',
      onclick: () => { ja.hidden = false; jaShowBtn.remove(); },
    }, '和訳の文字を見る');

    // 考える時間
    const started = Date.now();
    const elapsed = el('span', { class: 'compose-elapsed', text: formatElapsed(0) });
    const thinkLine = el('p', { class: 'compose-think', 'aria-live': 'off' },
      '考える時間 ', elapsed);
    tickTimer = setInterval(() => { elapsed.textContent = formatElapsed((Date.now() - started) / 1000); }, 1000);
    const thinkHint = el('p', { class: 'muted small', text: '英語を声に出して言ってみよう。' });

    const answerBox = el('div', { class: 'compose-answer', hidden: true });

    const jaAgain = el('button', { type: 'button', class: 'btn', onclick: () => { showNotice(''); playPart(sentence, 'ja', showNotice); } }, '日本語をもう一度');
    const enAgain = el('button', { type: 'button', class: 'btn', onclick: () => { showNotice(''); playPart(sentence, 'en', showNotice); } }, '英語をもう一度');
    const checkBtn = el('button', { type: 'button', class: 'btn btn-primary btn-start', onclick: reveal }, '英語を確認');
    const bottom = el('div', { class: 'study-bottom' },
      el('div', { class: 'btn-row btn-row-single' }, jaAgain),
      checkBtn,
    );

    function reveal() {
      if (tickTimer) { clearInterval(tickTimer); tickTimer = 0; }
      showNotice('');
      // ボタンの処理の中で英語を流す
      playPart(sentence, 'en', showNotice);
      thinkHint.remove();
      if (jaShowBtn && jaShowBtn.isConnected) { ja.hidden = false; jaShowBtn.remove(); }
      answerBox.replaceChildren(
        el('p', { class: 'compose-answer-label', text: '英語' }),
        answerSentence(sentence, sentenceWords),
        wordList(sentence, sentenceWords),
      );
      answerBox.hidden = false;
      bottom.replaceChildren(
        el('div', { class: 'btn-row' }, jaAgain, enAgain),
        el('p', { class: 'compose-grade-label', text: '言えたかな？' }),
        el('div', { class: 'compose-grades' },
          GRADES.map((g) => el('button', {
            type: 'button', class: `btn compose-grade grade-${g}`, onclick: () => grade(g),
            'aria-label': `${GRADE_MARK[g]} ${GRADE_LABEL[g]}`,
          },
            el('span', { class: 'grade-mark', 'aria-hidden': 'true', text: GRADE_MARK[g] }),
            el('span', { class: 'grade-text', text: GRADE_LABEL[g] }),
          ))),
      );
    }

    function grade(g) {
      results.push({ id: sentence.id, grade: g });
      records = applyGrade(records, sentence.id, g, todayStr());
      if (!persist()) showNotice(MSG_SAVE_FAILED);
      // 次の文の音声を用意しておく（英語が流れていたら、終わってから）
      const nxt = round[index + 1];
      if (nxt) {
        if (blobCache.has(nxt.file)) prepareSoon(nxt.file);
        else {
          fetchBlob(nxt.file).then((blob) => { if (blob && tok === screenToken) prepareSoon(nxt.file); });
        }
      }
      const isLast = index + 1 >= total;
      const nextBtn = el('button', { type: 'button', class: 'btn btn-primary btn-start', onclick: goNext },
        isLast ? '結果を見る' : '次へ（日本語が流れます）');
      bottom.replaceChildren(
        el('p', { class: `compose-graded grade-${g}` },
          el('span', { class: 'grade-mark', 'aria-hidden': 'true', text: GRADE_MARK[g] }),
          GRADE_LABEL[g]),
        nextBtn,
      );
      nextBtn.focus({ preventScroll: true });
    }

    root.replaceChildren(el('div', { class: 'study compose' },
      el('div', { class: 'study-head' },
        el('span', { class: 'study-count', text: `${index + 1} / ${total}` }),
        el('div', {
          class: 'progress study-progress', role: 'progressbar', 'aria-label': 'この回の進み具合',
          'aria-valuemin': 0, 'aria-valuemax': total, 'aria-valuenow': index,
        }, el('div', { class: 'progress-bar', style: `width:${Math.round((index / total) * 100)}%` })),
        quitButton(),
      ),
      notice,
      el('div', { class: 'study-body' },
        el('p', { class: 'kicker' },
          isRetry ? el('span', { class: 'tag-retry', text: 'もう一度' }) : null,
          '日本語を聞いて、英語で言おう'),
        el('div', { class: 'card' },
          el('p', { class: 'listen-number', text: `例文 ${sentence.id}` }),
          ja,
          jaShowBtn,
          thinkLine,
          thinkHint,
          answerBox,
        ),
      ),
      bottom,
    ));
    window.scrollTo(0, 0);
    preloadNext();
    // 日本語を 1 回流す（この関数は「始める」「次へ」の処理の中から呼ばれる）
    playPart(sentence, 'ja', showNotice);
  }

  function goNext() {
    index += 1;
    if (index >= round.length) { renderEnd(); return; }
    renderQuestion();
  }

  // ======================================================
  // 終了画面
  // ======================================================

  function renderEnd() {
    beginScreen();
    stopAudio();
    const sum = summarizeResults(results);
    const retryList = sum.retryIds.map((id) => sentenceMap.get(id)).filter(Boolean);
    const retryGrade = new Map(results.map((r) => [r.id, r.grade]));

    const body = [
      el('div', { class: 'card' },
        el('h2', { text: isRetry ? 'もう一度の回が終わりました' : '瞬間英作文が終わりました' }),
        el('div', { class: 'compose-score' },
          GRADES.map((g) => el('div', { class: `compose-score-box grade-${g}` },
            el('span', { class: 'grade-mark', 'aria-hidden': 'true', text: GRADE_MARK[g] }),
            el('span', { class: 'compose-score-label', text: GRADE_LABEL[g] }),
            el('strong', { class: 'compose-score-num', text: `${sum[g]}` }),
          ))),
        el('p', { class: 'muted', text: `全部で ${sum.total} 文` }),
        saveFailed ? el('p', { class: 'error', text: MSG_SAVE_FAILED }) : null,
      ),
    ];
    if (retryList.length) {
      body.push(el('div', { class: 'card' },
        el('h3', { text: '× と △ の文' }),
        el('ul', { class: 'compose-retry-list' }, retryList.map((s) => el('li', {},
          el('span', { class: `grade-mark grade-${retryGrade.get(s.id)}`, text: GRADE_MARK[retryGrade.get(s.id)] || '' }),
          el('span', { class: 'compose-retry-num', text: `例文 ${s.id}` }),
          el('span', { class: 'compose-retry-en', lang: 'en', text: s.en || '（英文がありません）' }),
        ))),
      ));
    } else if (sum.total) {
      body.push(el('p', { class: 'compose-allok', text: 'ぜんぶ ○ でした！' }));
    }

    const bottom = [];
    if (retryList.length) {
      const retryBtn = el('button', { type: 'button', class: 'btn btn-primary btn-start' }, '×と△だけもう一度');
      retryBtn.addEventListener('click', () => startRound(retryList, true));
      bottom.push(retryBtn);
    }
    bottom.push(
      el('button', { type: 'button', class: 'btn', onclick: renderSetup }, '範囲を選び直す'),
      el('button', { type: 'button', class: retryList.length ? 'btn' : 'btn btn-primary', onclick: quit }, 'ホームに戻る'),
    );

    root.replaceChildren(el('div', { class: 'study compose' },
      el('div', { class: 'study-body' }, body),
      el('div', { class: 'study-bottom' }, bottom),
    ));
    window.scrollTo(0, 0);
    // もう一度の 1 問目の音声を用意しておく（ボタンの処理の中で流すため）
    if (retryList.length) armStartButton(bottom[0], retryList[0], '×と△だけもう一度');
  }

  renderSetup();
}
