// 例文リスニング（範囲を選んで、英語のみ・日本語のみ・全体を連続再生する。聞き流し用）
//
// 使い方：startListening(root, { sentences, getAudioBlob, onExit })
//   root         … 描画先の要素
//   sentences    … 全例文（番号順の配列。db.getAllSentences の結果を並べたもの）
//   getAudioBlob … ファイル名 → Blob（db.getAudioBlob）
//   onExit       … やめたときに呼ぶ（ホームに戻す）
//
// この画面で決めたこと：
// - 範囲は「ステージ（srs.stageOf と同じ 50 文ごと）」か「例文番号の から〜まで」。
// - 再生のしかた：英語のみ = seg.en1、日本語のみ = seg.ja、全体 = en1 の始まり〜en3 の終わり（1 文まるごと）。
//   区間の前後には SEG_PAD 秒の余白をつける（区切りの検出で語の端が欠けないように）。
// - 文と文の間（くり返しの間も同じ）は gap 秒あける。1 文を repeat 回くり返してから次の文へ。
// - 「一時停止」→「再開」は、今の文（今のくり返し）の最初から再生し直す。
// - 間（gap）の最中に一時停止したときは、次に流す予定の文から再開する。
// - 音声区間がない例文（seg の不備・ファイルなし）は、範囲から外して再生する（件数を画面に出す）。
// - 選んだ範囲・再生のしかた・間隔・くり返し・ループは localStorage 'kk.listening.v1' に保存する。
//   英文・和訳の「表示する／隠す」は保存しない（毎回、英文だけ表示から始める）。
//
// 音声（audio.js）について：
// - audio.js は読み込んだ時点で Audio 要素を作るため、node のテストでも読めるように
//   startListening の中で動的 import する（DOM を使わない関数はこのファイルから export してテストする）。
// - iPhone 対策：最初の文の音声は範囲を選んだ時点で prepare() しておき、
//   「再生を始める」ボタンの処理の中で（await をはさまずに）playSegment() を呼ぶ。
// - 終了秒の見張り（audio.js）は requestAnimationFrame なので、画面が非表示になると止まる。
//   聞き流しで画面を消しても次の文へ進めるよう、区間の長さ＋少しの時間で動く予備のタイマーも置く。

import { stageOf } from '../srs.js';

export const LISTENING_KEY = 'kk.listening.v1';
export const MODES = Object.freeze(['en', 'ja', 'all']);
export const GAP_CHOICES = Object.freeze([0.5, 1, 2]);
export const REPEAT_CHOICES = Object.freeze([1, 2, 3]);
export const SEG_PAD = 0.1; // 区間の前後につける余白（秒）
export const DEFAULT_LISTENING_SETTINGS = Object.freeze({
  rangeKind: 'stage', // 'stage' | 'ids'
  stage: 1,
  from: 1,
  to: 50,
  mode: 'en',         // 'en' | 'ja' | 'all'
  gap: 1,             // 文と文の間（秒）
  repeat: 1,          // 1 文のくり返し回数
  loop: false,        // 範囲の最後まで行ったら最初に戻る
});

const MODE_LABELS = { en: '英語のみ', ja: '日本語のみ', all: '全体（英→日→英→英）' };
const MODE_PLAYING = { en: '英語', ja: '日本語', all: '全体' };
const FALLBACK_MARGIN = 0.25; // 予備のタイマーを区間の長さより何秒遅らせるか
const MSG_PLAY_FAILED = '音声を再生できませんでした。マナーモードや音量を確認して、「再開」を押してください。';

// ---------- DOM を使わない部分（テスト対象） ----------

function toNum(v) {
  if (v === null || v === '' || typeof v === 'boolean') return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function isValidSentence(s) {
  return !!s && Number.isInteger(s.id) && s.id > 0;
}

function round3(x) {
  return Math.round(x * 1000) / 1000;
}

/** 範囲に含まれるステージの一覧（例文があるステージだけ、番号順） */
export function listStages(sentences) {
  const map = new Map();
  for (const s of Array.isArray(sentences) ? sentences : []) {
    if (!isValidSentence(s)) continue;
    const st = stageOf(s.id);
    if (!st) continue;
    const cur = map.get(st);
    if (!cur) map.set(st, { stage: st, from: s.id, to: s.id, count: 1 });
    else {
      cur.from = Math.min(cur.from, s.id);
      cur.to = Math.max(cur.to, s.id);
      cur.count += 1;
    }
  }
  return [...map.values()].sort((a, b) => a.stage - b.stage);
}

/** 例文番号の最小・最大。例文がなければ null */
export function idBounds(sentences) {
  let min = Infinity;
  let max = -Infinity;
  for (const s of Array.isArray(sentences) ? sentences : []) {
    if (!isValidSentence(s)) continue;
    if (s.id < min) min = s.id;
    if (s.id > max) max = s.id;
  }
  return min === Infinity ? null : { min, max };
}

/** 「から〜まで」を整える（数字でなければ端、範囲外は端に寄せる、逆なら入れ替える）。例文がなければ null */
export function clampIdRange(from, to, sentences) {
  const b = idBounds(sentences);
  if (!b) return null;
  let f = Math.trunc(toNum(from));
  let t = Math.trunc(toNum(to));
  if (!Number.isFinite(f)) f = b.min;
  if (!Number.isFinite(t)) t = b.max;
  f = Math.min(Math.max(f, b.min), b.max);
  t = Math.min(Math.max(t, b.min), b.max);
  if (f > t) [f, t] = [t, f];
  return { from: f, to: t };
}

/**
 * 設定を正しい形に直す（壊れた値は既定値に戻す）。
 * sentences を渡すと、ステージと番号の範囲を実際の例文に合わせる。
 */
export function normalizeSettings(raw, sentences = null) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const d = DEFAULT_LISTENING_SETTINGS;
  const posInt = (v, def) => {
    const n = toNum(v);
    return Number.isInteger(n) && n >= 1 ? n : def;
  };
  const out = {
    rangeKind: r.rangeKind === 'ids' ? 'ids' : 'stage',
    stage: posInt(r.stage, d.stage),
    from: posInt(r.from, d.from),
    to: posInt(r.to, d.to),
    mode: MODES.includes(r.mode) ? r.mode : d.mode,
    gap: GAP_CHOICES.includes(toNum(r.gap)) ? toNum(r.gap) : d.gap,
    repeat: REPEAT_CHOICES.includes(toNum(r.repeat)) ? toNum(r.repeat) : d.repeat,
    loop: r.loop === true,
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

function defaultStorage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

/** 保存した設定を読む。無い・壊れている・使えない環境では既定値 */
export function loadListeningSettings(storage = defaultStorage()) {
  try {
    if (!storage) return { ...DEFAULT_LISTENING_SETTINGS };
    const text = storage.getItem(LISTENING_KEY);
    if (!text) return { ...DEFAULT_LISTENING_SETTINGS };
    return normalizeSettings(JSON.parse(text));
  } catch {
    return { ...DEFAULT_LISTENING_SETTINGS };
  }
}

/** 設定を保存する。保存できたら true（使えない環境・容量不足では false） */
export function saveListeningSettings(settings, storage = defaultStorage()) {
  try {
    if (!storage) return false;
    storage.setItem(LISTENING_KEY, JSON.stringify(normalizeSettings(settings)));
    return true;
  } catch {
    return false;
  }
}

/** 設定の範囲に入る例文（番号順） */
export function selectRange(sentences, settings) {
  const list = (Array.isArray(sentences) ? sentences : [])
    .filter(isValidSentence)
    .sort((a, b) => a.id - b.id);
  const st = settings || DEFAULT_LISTENING_SETTINGS;
  if (st.rangeKind === 'ids') {
    let f = toNum(st.from);
    let t = toNum(st.to);
    if (!Number.isFinite(f) || !Number.isFinite(t)) return [];
    if (f > t) [f, t] = [t, f];
    return list.filter((s) => s.id >= f && s.id <= t);
  }
  return list.filter((s) => stageOf(s.id) === st.stage);
}

function isValidSeg(seg) {
  return Array.isArray(seg) && seg.length >= 2
    && Number.isFinite(seg[0]) && Number.isFinite(seg[1])
    && seg[0] >= 0 && seg[1] > seg[0];
}

/**
 * 再生する区間 [開始秒, 終了秒]（前後に SEG_PAD の余白つき）。再生できなければ null
 * - en  … seg.en1
 * - ja  … seg.ja
 * - all … en1・ja・en2・en3 のうち正しい区間の、いちばん早い始まり〜いちばん遅い終わり
 */
export function segmentFor(sentence, mode) {
  if (!sentence || !sentence.file || !sentence.seg || typeof sentence.seg !== 'object') return null;
  const seg = sentence.seg;
  let range = null;
  if (mode === 'en') range = isValidSeg(seg.en1) ? seg.en1 : null;
  else if (mode === 'ja') range = isValidSeg(seg.ja) ? seg.ja : null;
  else if (mode === 'all') {
    const parts = ['en1', 'ja', 'en2', 'en3'].map((k) => seg[k]).filter(isValidSeg);
    if (parts.length) range = [Math.min(...parts.map((p) => p[0])), Math.max(...parts.map((p) => p[1]))];
  }
  if (!range) return null;
  return [round3(Math.max(0, range[0] - SEG_PAD)), round3(range[1] + SEG_PAD)];
}

/** 再生できる例文だけにする */
export function playableList(sentences, mode) {
  return (Array.isArray(sentences) ? sentences : []).filter((s) => segmentFor(s, mode) !== null);
}

/**
 * 1 区間を再生し終えたあとの位置。{ index, rep }（rep は 0 始まりのくり返し回数）
 * 最後まで行ってループしないときは null
 */
export function nextStep(pos, { count, repeat = 1, loop = false } = {}) {
  if (!count || count < 1) return null;
  const reps = Math.max(1, repeat | 0);
  if (pos.rep + 1 < reps) return { index: pos.index, rep: pos.rep + 1 };
  if (pos.index + 1 < count) return { index: pos.index + 1, rep: 0 };
  return loop ? { index: 0, rep: 0 } : null;
}

/** 前の文・次の文。ループのときは端で反対側へ回る。ループしないときは端で止まる */
export function moveIndex(index, delta, count, loop = false) {
  if (!count || count < 1) return 0;
  let i = index + delta;
  if (i < 0) i = loop ? count - 1 : 0;
  if (i >= count) i = loop ? 0 : count - 1;
  return i;
}

/** 範囲を 1 周するのにかかる、だいたいの秒数（区間の長さ＋間）×くり返し */
export function estimateSeconds(sentences, mode, repeat = 1, gap = 0) {
  let sec = 0;
  for (const s of Array.isArray(sentences) ? sentences : []) {
    const r = segmentFor(s, mode);
    if (r) sec += (r[1] - r[0] + gap) * Math.max(1, repeat | 0);
  }
  return sec;
}

/** 秒数を「約 ○ 分」にする */
export function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '0 分';
  if (sec < 60) return '1 分未満';
  return `約 ${Math.round(sec / 60)} 分`;
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

export async function startListening(root, ctx) {
  const { sentences: given = [], getAudioBlob, onExit } = ctx || {};
  const audio = await import('../audio.js');
  const sentences = (Array.isArray(given) ? given : []).filter(isValidSentence).sort((a, b) => a.id - b.id);

  let settings = normalizeSettings(loadListeningSettings(), sentences);
  let canSave = true;

  // ---- 音声の読み込み（今の文と次の文だけ手元に置く） ----
  const blobCache = new Map(); // file → Blob
  const pending = new Map();   // file → Promise<Blob|null>
  let preparedFile = null;     // audio.prepare() 済みのファイル

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

  /** 手元に Blob があれば、その場で prepare する。できたら true */
  function prepareNow(file) {
    if (file === preparedFile) return true;
    const blob = blobCache.get(file);
    if (!blob) return false;
    audio.prepare(file, blob);
    preparedFile = file;
    return true;
  }

  // ---- 再生の状態 ----
  let list = [];          // 再生する例文
  let index = 0;          // 今の文
  let rep = 0;            // 今の文の何回目か（0 始まり）
  let state = 'idle';     // 'playing' | 'gap' | 'paused' | 'ended' | 'idle'
  let playToken = 0;      // 再生を始め直すたびに増やす（古いコールバックを捨てるため）
  let doneToken = -1;     // 終わりの処理をした playToken（二重に進まないように）
  let gapTimer = 0;
  let fallbackTimer = 0;
  let failures = 0;       // 続けて音声が見つからなかった数
  let setupToken = 0;
  let showEn = true;      // 初期は英文だけ表示
  let showJa = false;
  let ui = null;          // 再生画面の要素

  function clearTimers() {
    if (gapTimer) clearTimeout(gapTimer);
    if (fallbackTimer) clearTimeout(fallbackTimer);
    gapTimer = 0;
    fallbackTimer = 0;
  }

  /** 再生を止める（画面の状態は呼び出し側で決める） */
  function halt() {
    playToken += 1;
    clearTimers();
    audio.stop();
  }

  function quit() {
    halt();
    setupToken += 1;
    state = 'idle';
    if (typeof onExit === 'function') onExit();
  }

  function save() {
    canSave = saveListeningSettings(settings);
  }

  // ======================================================
  // 範囲と再生のしかたを選ぶ画面
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
    halt();
    state = 'idle';
    ui = null;
    const stages = listStages(sentences);
    const bounds = idBounds(sentences);

    if (!bounds) {
      root.replaceChildren(el('div', { class: 'study' },
        el('div', { class: 'study-body' },
          el('p', { class: 'kicker', text: '例文リスニング' }),
          el('div', { class: 'card' }, el('p', { text: '例文がありません。データパックを確認してください。' })),
        ),
        el('div', { class: 'study-bottom' },
          el('button', { type: 'button', class: 'btn', onclick: quit }, 'ホームに戻る')),
      ));
      return;
    }

    // 範囲
    const stageSelect = el('select', { class: 'select', id: 'listen-stage' },
      stages.map((s) => {
        const o = new Option(`ステージ ${s.stage}（例文 ${s.from}〜${s.to}）`, String(s.stage));
        return o;
      }));
    stageSelect.value = String(settings.stage);
    stageSelect.addEventListener('change', () => { settings.stage = Number(stageSelect.value); changed(); });

    const numInput = (id, value) => el('input', {
      type: 'number', id, class: 'num-input', inputmode: 'numeric', min: bounds.min, max: bounds.max, step: 1, value,
    });
    const fromInput = numInput('listen-from', settings.from);
    const toInput = numInput('listen-to', settings.to);
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
      el('label', { class: 'field-label', for: 'listen-stage', text: 'ステージ（50 文ごと）' }),
      stageSelect);
    const idsBox = el('div', {},
      el('p', { class: 'field-label', text: `例文の番号（${bounds.min}〜${bounds.max}）` }),
      el('div', { class: 'range-row' },
        fromInput, el('label', { for: 'listen-from', text: 'から' }),
        toInput, el('label', { for: 'listen-to', text: 'まで' }),
      ));
    const showRangeKind = () => {
      stageBox.hidden = settings.rangeKind !== 'stage';
      idsBox.hidden = settings.rangeKind !== 'ids';
    };
    showRangeKind();

    const rangeKindGroup = radioGroup('listen-range-kind', '範囲の選び方',
      [['stage', 'ステージで選ぶ'], ['ids', '番号で選ぶ']], settings.rangeKind,
      (v) => { settings.rangeKind = v; showRangeKind(); changed(); });

    // 再生のしかた
    const modeGroup = radioGroup('listen-mode', '流す音声',
      MODES.map((m) => [m, MODE_LABELS[m]]), settings.mode,
      (v) => { settings.mode = v; changed(); });

    const gapSelect = el('select', { class: 'select', id: 'listen-gap' },
      GAP_CHOICES.map((g) => new Option(`${g} 秒`, String(g))));
    gapSelect.value = String(settings.gap);
    gapSelect.addEventListener('change', () => { settings.gap = Number(gapSelect.value); changed(); });

    const repeatSelect = el('select', { class: 'select', id: 'listen-repeat' },
      REPEAT_CHOICES.map((n) => new Option(`${n} 回`, String(n))));
    repeatSelect.value = String(settings.repeat);
    repeatSelect.addEventListener('change', () => { settings.repeat = Number(repeatSelect.value); changed(); });

    const loopCheck = el('input', { type: 'checkbox', checked: settings.loop });
    loopCheck.addEventListener('change', () => { settings.loop = loopCheck.checked; changed(); });

    // 下：要約と開始ボタン
    const summary = el('p', { class: 'listen-summary', 'aria-live': 'polite' });
    const skipped = el('p', { class: 'muted small' });
    const saveNote = el('p', { class: 'muted small' });
    const notice = el('p', { class: 'error', role: 'alert', hidden: true });
    const startBtn = el('button', { type: 'button', class: 'btn btn-primary btn-start', disabled: true }, '音声を準備中…');
    let playable = [];

    startBtn.addEventListener('click', () => {
      if (!playable.length) return;
      // await をはさまずに再生を始める（iPhone 対策）
      list = playable;
      index = 0;
      rep = 0;
      failures = 0;
      setupToken += 1;
      renderPlayer();
      playCurrent();
    });

    function refresh() {
      const range = selectRange(sentences, settings);
      playable = playableList(range, settings.mode);
      const label = settings.rangeKind === 'stage'
        ? `ステージ ${settings.stage}`
        : `例文 ${settings.from}〜${settings.to}`;
      const time = formatDuration(estimateSeconds(playable, settings.mode, settings.repeat, settings.gap));
      summary.textContent = `${label}：${playable.length} 文（1 周 ${time}）`;
      const missing = range.length - playable.length;
      skipped.textContent = missing > 0 ? `音声の区切りがない例文 ${missing} 文は飛ばします。` : '';
      saveNote.textContent = canSave ? '' : 'この画面では設定を保存できません（プライベートブラウズなど）。';

      // 最初の文の音声を先に用意しておく（ボタンの処理の中で再生を始めるため）
      const tok = ++setupToken;
      const first = playable[0];
      if (!first) {
        startBtn.disabled = true;
        startBtn.textContent = '再生できる例文がありません';
        return;
      }
      const ready = () => { startBtn.disabled = false; startBtn.textContent = '▶ 再生を始める'; };
      if (prepareNow(first.file)) { ready(); return; }
      startBtn.disabled = true;
      startBtn.textContent = '音声を準備中…';
      fetchBlob(first.file).then((blob) => {
        if (tok !== setupToken) return;
        if (!blob) {
          startBtn.textContent = '音声が見つかりません';
          notice.textContent = `例文 ${first.id} の音声が見つかりません。データパックを入れ直してください。`;
          notice.hidden = false;
          return;
        }
        keepOnly([first.file]);
        prepareNow(first.file);
        notice.hidden = true;
        ready();
      });
    }

    function changed() {
      save();
      refresh();
    }

    root.replaceChildren(el('div', { class: 'study listen' },
      el('div', { class: 'study-body' },
        el('p', { class: 'kicker', text: '例文リスニング' }),
        el('div', { class: 'card' },
          el('h3', { text: '範囲' }),
          rangeKindGroup,
          stageBox,
          idsBox,
        ),
        el('div', { class: 'card' },
          el('h3', { text: '再生のしかた' }),
          modeGroup,
          el('div', { class: 'select-row' },
            el('div', {},
              el('label', { class: 'field-label', for: 'listen-gap', text: '文と文の間' }),
              gapSelect),
            el('div', {},
              el('label', { class: 'field-label', for: 'listen-repeat', text: '1 文のくり返し' }),
              repeatSelect),
          ),
          el('label', { class: 'check-row' }, loopCheck, el('span', { text: '最後まで行ったら最初に戻る（ループ）' })),
        ),
        notice,
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
  // 再生中の画面
  // ======================================================

  function toggleButton(labelOn, labelOff, isOn, onToggle) {
    const b = el('button', { type: 'button', class: 'btn btn-toggle' });
    const paint = (on) => {
      b.textContent = on ? labelOn : labelOff;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    };
    paint(isOn);
    b.addEventListener('click', () => paint(onToggle()));
    return b;
  }

  function renderPlayer() {
    const number = el('span', { class: 'listen-number' });
    const count = el('span', { class: 'study-count' });
    const bar = el('div', { class: 'progress-bar' });
    const progress = el('div', {
      class: 'progress study-progress', role: 'progressbar', 'aria-label': '範囲の中の位置', 'aria-valuemin': 1,
    }, bar);
    const status = el('p', { class: 'listen-status', 'aria-live': 'polite' });
    const en = el('p', { class: 'sentence-en', lang: 'en' });
    const ja = el('p', { class: 'sentence-ja' });
    const notice = el('p', { class: 'error', role: 'alert', hidden: true });
    const pauseBtn = el('button', { type: 'button', class: 'btn btn-primary btn-start', onclick: onPauseClick });
    const prevBtn = el('button', { type: 'button', class: 'btn', onclick: () => go(-1) }, '◀ 前の文');
    const nextBtn = el('button', { type: 'button', class: 'btn', onclick: () => go(1) }, '次の文 ▶');

    const enToggle = toggleButton('英文を隠す', '英文を表示', showEn, () => { showEn = !showEn; updatePlayer(); return showEn; });
    const jaToggle = toggleButton('和訳を隠す', '和訳を表示', showJa, () => { showJa = !showJa; updatePlayer(); return showJa; });

    const modeText = `${MODE_LABELS[settings.mode]}・間 ${settings.gap} 秒・${settings.repeat} 回ずつ${settings.loop ? '・ループ' : ''}`;

    root.replaceChildren(el('div', { class: 'study listen' },
      el('div', { class: 'study-head' },
        count,
        progress,
        el('button', { type: 'button', class: 'btn btn-quit', onclick: quit }, 'やめる'),
      ),
      notice,
      el('div', { class: 'study-body' },
        el('div', { class: 'card' },
          el('div', { class: 'listen-head' }, number, status),
          en,
          ja,
          el('div', { class: 'btn-row' }, enToggle, jaToggle),
        ),
        el('p', { class: 'muted small', text: modeText }),
        el('p', { class: 'muted small', text: 'iPhone では、画面を消す（ロックする）と再生が止まることがあります。止まったら「再開」を押してください。' }),
      ),
      el('div', { class: 'study-bottom' },
        el('div', { class: 'btn-row' }, prevBtn, nextBtn),
        pauseBtn,
        el('button', { type: 'button', class: 'btn btn-subtle', onclick: renderSetup }, '範囲・再生のしかたを変える'),
      ),
    ));
    ui = { number, count, bar, progress, status, en, ja, notice, pauseBtn, prevBtn, nextBtn };
    window.scrollTo(0, 0);
    updatePlayer();
  }

  function showNotice(msg) {
    if (!ui) return;
    ui.notice.textContent = msg;
    ui.notice.hidden = !msg;
  }

  function updatePlayer() {
    if (!ui || !list.length) return;
    const s = list[index];
    const total = list.length;
    ui.number.textContent = `例文 ${s.id}`;
    ui.count.textContent = `${index + 1} / ${total}`;
    ui.bar.style.width = `${Math.round(((index + 1) / total) * 100)}%`;
    ui.progress.setAttribute('aria-valuemax', String(total));
    ui.progress.setAttribute('aria-valuenow', String(index + 1));

    const repText = settings.repeat > 1 ? `（${rep + 1} / ${settings.repeat} 回目）` : '';
    if (state === 'playing') ui.status.textContent = `${MODE_PLAYING[settings.mode]}を再生中${repText}`;
    else if (state === 'gap') ui.status.textContent = `次の音声を待っています${repText}`;
    else if (state === 'ended') ui.status.textContent = '最後まで再生しました';
    else ui.status.textContent = '一時停止中';

    if (showEn) {
      ui.en.textContent = s.en || '（英文がありません）';
      ui.en.classList.toggle('muted', !s.en);
    } else {
      ui.en.textContent = '（英文は隠しています）';
      ui.en.classList.add('muted');
    }
    ui.ja.hidden = !showJa;
    ui.ja.textContent = s.ja || '（和訳がありません）';

    const active = state === 'playing' || state === 'gap';
    ui.pauseBtn.textContent = active ? '❚❚ 一時停止' : state === 'ended' ? '▶ 最初から再生' : '▶ 再開';
    ui.prevBtn.disabled = !settings.loop && index === 0;
    ui.nextBtn.disabled = !settings.loop && index === total - 1;
  }

  // ---- 再生の進行 ----

  /** 今の文・今のくり返しを最初から再生する。手元に音声があれば、その場で再生を始める */
  function playCurrent() {
    clearTimers();
    const s = list[index];
    const range = segmentFor(s, settings.mode);
    playToken += 1;
    const my = playToken;
    state = 'playing';
    updatePlayer();
    preloadAround();

    const run = () => {
      const p = audio.playSegment(range[0], range[1], { onFinish: () => segmentDone(my) });
      p.then(() => {
        if (my !== playToken) {
          // 読み込みを待つ間に一時停止された場合は、遅れて始まった音を止める
          if (state !== 'playing') audio.stop();
          return;
        }
        failures = 0;
        // 画面が非表示で終了秒の見張りが止まっても進めるように、予備のタイマーを置く
        const ms = (range[1] - range[0] + FALLBACK_MARGIN) * 1000;
        fallbackTimer = setTimeout(() => {
          fallbackTimer = 0;
          if (my !== playToken || doneToken === my) return;
          audio.stop();
          segmentDone(my);
        }, ms);
      }, (e) => {
        if (my !== playToken) return;
        console.warn(e);
        halt();
        state = 'paused';
        updatePlayer();
        showNotice(MSG_PLAY_FAILED);
      });
    };

    if (prepareNow(s.file)) { run(); return; }
    fetchBlob(s.file).then((blob) => {
      if (my !== playToken) return;
      if (!blob) { onMissing(s); return; }
      prepareNow(s.file);
      run();
    });
  }

  /** 音声が見つからない文は飛ばす（全部見つからないときは止める） */
  function onMissing(s) {
    failures += 1;
    if (failures >= list.length) {
      halt();
      state = 'paused';
      updatePlayer();
      showNotice('音声が見つかりません。データパックを入れ直してください。');
      return;
    }
    showNotice(`例文 ${s.id} の音声が見つからないため、飛ばしました。`);
    const nx = nextStep({ index, rep: settings.repeat - 1 }, { count: list.length, repeat: settings.repeat, loop: settings.loop });
    if (!nx) { finish(); return; }
    index = nx.index;
    rep = nx.rep;
    playCurrent();
  }

  /** 1 区間が終わった（終了秒の見張り、または予備のタイマーから） */
  function segmentDone(my) {
    if (my !== playToken || doneToken === my) return;
    doneToken = my;
    clearTimers();
    const nx = nextStep({ index, rep }, { count: list.length, repeat: settings.repeat, loop: settings.loop });
    if (!nx) { finish(); return; }
    index = nx.index;
    rep = nx.rep;
    state = 'gap';
    updatePlayer();
    preloadAround();
    gapTimer = setTimeout(() => {
      gapTimer = 0;
      if (my === playToken && state === 'gap') playCurrent();
    }, settings.gap * 1000);
  }

  function finish() {
    halt();
    state = 'ended';
    updatePlayer();
  }

  /** 今の文と次の文の音声を読み込んでおく */
  function preloadAround() {
    if (!list.length) return;
    const cur = list[index].file;
    const nextIdx = nextStep({ index, rep: settings.repeat - 1 }, { count: list.length, repeat: settings.repeat, loop: settings.loop });
    const nxt = nextIdx ? list[nextIdx.index].file : null;
    keepOnly([cur, nxt, preparedFile].filter(Boolean));
    fetchBlob(cur);
    if (nxt) fetchBlob(nxt);
  }

  function onPauseClick() {
    showNotice('');
    if (state === 'playing' || state === 'gap') {
      halt();
      state = 'paused';
      updatePlayer();
      return;
    }
    if (state === 'ended') { index = 0; rep = 0; }
    failures = 0;
    playCurrent(); // ボタンの処理の中で再生を始める
  }

  /** 前の文・次の文 */
  function go(delta) {
    showNotice('');
    const wasActive = state === 'playing' || state === 'gap';
    index = moveIndex(index, delta, list.length, settings.loop);
    rep = 0;
    if (wasActive) { playCurrent(); return; }
    // 止まっているときは移動だけ（「再開」ですぐ鳴らせるように音声を用意しておく）
    halt();
    state = 'paused';
    updatePlayer();
    preloadAround();
    const s = list[index];
    const at = index;
    fetchBlob(s.file).then((blob) => {
      if (blob && state === 'paused' && index === at) prepareNow(s.file);
    });
  }

  renderSetup();
}
