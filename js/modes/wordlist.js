// 単語一覧（検索・ステージ別一覧・習得状況の色分け）
//
// 使い方：startWordList(root, { words, sentencesById, getAudioBlob, onExit })
//   root          … 描画先の要素（この中だけに描く）
//   words         … 全単語（db.getAllWords の結果）
//   sentencesById … 例文の Map（id → sentence）。普通のオブジェクトでもよい
//   getAudioBlob  … ファイル名 → Blob（db.getAudioBlob）
//   onExit        … やめたときに呼ぶ（ホームに戻す）
//
// この画面で決めたこと：
// - 学習記録（store.loadProgress）は画面を開いたときに 1 回だけ読む。読むだけで変更しない。
// - 並び順は「代表の例文番号（sentenceIds[0]）の小さい順、同じなら id 順」。代表の例文が無効な語は最後。
// - 検索：見出し語・意味のどちらかに部分一致。NFKC で全角半角をそろえ、小文字にし、連続した空白を 1 つにして比べる。
//   ～ / 〜 / ~ は同じ文字として扱う（NFKC で ～ は ~ になるため、〜 も ~ にそろえる）。
// - 習得状況（statusOf）：記録なし＝未学習、mastered＝マスター、box 3 以上＝覚えた、それ以外＝学習中。
//   「未確認の語だけ」（verified !== true）は習得状況の絞り込みの選択肢の 1 つとして扱う。
// - 品詞のまとまり（posGroupOf）：isPhrase が true、または pos が「熟語」「会話表現」なら 熟語・会話表現。
//   それ以外は pos が 名詞 / 動詞 / 形容詞 / 副詞 ならそのまとまり、ほかは「その他」。
// - ステージは代表の例文番号で決める（srs.stageOf、50 文ごと）。ステージの選択肢は、語のある最大のステージまで。
// - 重くしないために：最初は PAGE_SIZE 件だけ描き、「もっと見る」ボタンか、一覧の最後が見えたら（IntersectionObserver）
//   次の PAGE_SIZE 件を足す。検索の入力は DEBOUNCE_MS 待ってから絞り込む。正規化した文字列は語ごとにキャッシュする。
//   行のクリックは一覧の要素 1 か所で受ける（行ごとにイベントを付けない）。
// - 詳細は同じ画面の下部シートで開く（一覧のスクロール位置を保つため）。閉じるボタン・背景・Esc で閉じる。
// - 音声：audio.js は node のテストで読めないので startWordList の中で動的 import する。
//   詳細を開いた時点で prepare() し、「例文を聞く」では playSegment(seg.en1) だけを呼ぶ（iPhone 対策）。
// - 「ほかの例文（参考）」は sentenceIds の 2 つ目以降（代表と同じ番号・重複は除く）。参考表示だけ（CLAUDE.md 6章）。

import { stageOf } from '../srs.js';
import { loadProgress } from '../store.js';
import { findForm } from '../quiz.js';

export const PAGE_SIZE = 100;
export const DEBOUNCE_MS = 250;

/** 習得状況（キー → 表示の文字・印） */
export const STATUS_LABELS = Object.freeze({
  new: '未学習',
  learning: '学習中',
  learned: '覚えた',
  mastered: 'マスター',
});
export const STATUS_MARKS = Object.freeze({
  new: '－',
  learning: '△',
  learned: '○',
  mastered: '◎',
});

/** 習得状況の絞り込みの選択肢（unverified は「未確認の語だけ」） */
export const STATUS_FILTERS = Object.freeze(['all', 'new', 'learning', 'learned', 'mastered', 'unverified']);

/** 品詞の絞り込みの選択肢 */
export const POS_GROUPS = Object.freeze({
  all: 'すべて',
  noun: '名詞',
  verb: '動詞',
  adj: '形容詞',
  adv: '副詞',
  phrase: '熟語・会話表現',
  other: 'その他',
});

const POS_TO_GROUP = { 名詞: 'noun', 動詞: 'verb', 形容詞: 'adj', 副詞: 'adv', 熟語: 'phrase', 会話表現: 'phrase' };

const MSG_PLAY_FAILED = '音声を再生できませんでした。マナーモードや音量を確認して、もう一度押してください。';

// ---------- DOM を使わない部分（テスト対象） ----------

/** 検索用に文字列をそろえる（全角半角・大文字小文字・連続した空白・波線） */
export function normalizeText(s) {
  if (s == null) return '';
  return String(s)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[〜～]/g, '~')
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** 学習記録 1 件から習得状況のキーを返す：'new' | 'learning' | 'learned' | 'mastered' */
export function statusOf(rec) {
  if (!rec || typeof rec !== 'object') return 'new';
  if (rec.mastered === true) return 'mastered';
  const box = Number(rec.box);
  if (Number.isFinite(box) && box >= 3) return 'learned';
  return 'learning';
}

/** 品詞のまとまり：'noun' | 'verb' | 'adj' | 'adv' | 'phrase' | 'other' */
export function posGroupOf(word) {
  if (!word) return 'other';
  if (word.isPhrase === true) return 'phrase';
  return POS_TO_GROUP[String(word.pos || '').trim()] || 'other';
}

/** 代表の例文番号（無効なら null） */
export function representativeId(word) {
  const id = word && Array.isArray(word.sentenceIds) ? word.sentenceIds[0] : undefined;
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** 語のステージ（代表の例文で決める。無効なら 0） */
export function wordStage(word) {
  const id = representativeId(word);
  return id == null ? 0 : stageOf(id);
}

/** 「ほかの例文（参考）」の番号（2 つ目以降。代表と同じもの・重複・無効な番号は除く） */
export function otherSentenceIds(word) {
  if (!word || !Array.isArray(word.sentenceIds)) return [];
  const rep = representativeId(word);
  const seen = new Set(rep == null ? [] : [rep]);
  const out = [];
  for (const id of word.sentenceIds.slice(1)) {
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** 語のある最大のステージまでの一覧 [{ stage, from, to }] */
export function listWordStages(words) {
  let max = 0;
  for (const w of Array.isArray(words) ? words : []) max = Math.max(max, wordStage(w));
  const out = [];
  for (let s = 1; s <= max; s++) out.push({ stage: s, from: (s - 1) * 50 + 1, to: s * 50 });
  return out;
}

/** 代表の例文番号の小さい順、同じなら id 順に並べた新しい配列（代表の例文が無効な語は最後） */
export function sortWords(words) {
  const list = Array.isArray(words) ? words.filter(Boolean) : [];
  return list
    .map((w, i) => ({ w, i, rep: representativeId(w) ?? Infinity }))
    .sort((a, b) => (a.rep - b.rep) || String(a.w.id ?? '').localeCompare(String(b.w.id ?? '')) || (a.i - b.i))
    .map((x) => x.w);
}

// 語ごとの検索用文字列のキャッシュ（同じ語を何度も正規化しないため）
const searchCache = new WeakMap();
function searchKeysOf(word) {
  let k = searchCache.get(word);
  if (!k || k.src !== word.word || k.srcMeaning !== word.meaning) {
    k = { src: word.word, srcMeaning: word.meaning, word: normalizeText(word.word), meaning: normalizeText(word.meaning) };
    searchCache.set(word, k);
  }
  return k;
}

/** 絞り込みの条件を正しい形に直す（文字列だけ渡されたら検索語とみなす） */
export function normalizeQuery(query) {
  const q = typeof query === 'string' ? { text: query } : (query && typeof query === 'object' ? query : {});
  const stageNum = Number(q.stage);
  return {
    text: normalizeText(q.text),
    stage: q.stage === 'all' || q.stage == null || q.stage === '' || !Number.isInteger(stageNum) || stageNum < 1 ? 'all' : stageNum,
    status: STATUS_FILTERS.includes(q.status) ? q.status : 'all',
    pos: Object.prototype.hasOwnProperty.call(POS_GROUPS, q.pos) ? q.pos : 'all',
  };
}

/** 1 語が条件に合うか（q は normalizeQuery 済み） */
function matches(word, progress, q) {
  if (q.stage !== 'all' && wordStage(word) !== q.stage) return false;
  if (q.pos !== 'all' && posGroupOf(word) !== q.pos) return false;
  if (q.status === 'unverified') {
    if (word.verified === true) return false;
  } else if (q.status !== 'all') {
    const rec = progress && Object.prototype.hasOwnProperty.call(progress, word.id) ? progress[word.id] : undefined;
    if (statusOf(rec) !== q.status) return false;
  }
  if (q.text) {
    const k = searchKeysOf(word);
    if (!k.word.includes(q.text) && !k.meaning.includes(q.text)) return false;
  }
  return true;
}

/**
 * 絞り込む（words の順番のまま返す）
 * @param {Array} words 全単語
 * @param {object} progress 学習記録（loadProgress の結果）
 * @param {string|{text?, stage?, status?, pos?}} query
 *   stage：'all' か 1 以上の整数 / status：STATUS_FILTERS / pos：POS_GROUPS のキー
 */
export function filterWords(words, progress, query) {
  const q = normalizeQuery(query);
  const p = progress && typeof progress === 'object' ? progress : {};
  const out = [];
  for (const w of Array.isArray(words) ? words : []) {
    if (w && matches(w, p, q)) out.push(w);
  }
  return out;
}

/** 習得状況ごとの件数 { new, learning, learned, mastered, unverified, total } */
export function countByStatus(words, progress) {
  const c = { new: 0, learning: 0, learned: 0, mastered: 0, unverified: 0, total: 0 };
  const p = progress && typeof progress === 'object' ? progress : {};
  for (const w of Array.isArray(words) ? words : []) {
    if (!w) continue;
    c.total += 1;
    c[statusOf(Object.prototype.hasOwnProperty.call(p, w.id) ? p[w.id] : undefined)] += 1;
    if (w.verified !== true) c.unverified += 1;
  }
  return c;
}

/** 単語の発音用の文字列（"..." や "～" は読まない） */
export function spokenText(word) {
  return String((word && word.word) || '')
    .replace(/\.{2,}|…|～|〜|~/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 待ってから実行する（続けて呼ばれたら最後の 1 回だけ） */
export function debounce(fn, ms) {
  let timer = null;
  const wrapped = (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args); }, ms);
  };
  wrapped.cancel = () => { if (timer) clearTimeout(timer); timer = null; };
  return wrapped;
}

// ---------- 画面の部品 ----------

/** 例外が出たら fallback を返す */
function safe(fn, fallback) {
  try { return fn(); } catch (e) { console.warn(e); return fallback; }
}

/** 要素を作る（today.js と同じ形） */
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

function canSpeak() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

function cancelSpeech() {
  if (canSpeak()) { try { speechSynthesis.cancel(); } catch { /* 無視 */ } }
}

/** 習得状況の印（色＋記号＋文字） */
function statusBadge(status) {
  return el('span', { class: `wl-status wl-status-${status}` },
    el('span', { class: 'wl-status-mark', 'aria-hidden': 'true', text: STATUS_MARKS[status] }),
    STATUS_LABELS[status]);
}

function unverifiedBadge(word) {
  return word.verified !== true
    ? el('span', { class: 'badge-unverified', title: 'まだ本と照合していない語です', text: '未確認' })
    : null;
}

/** 例文（見出し語を太字） */
function boldSentence(sentence, word) {
  if (!sentence || !sentence.en) return null;
  const p = el('p', { class: 'sentence-en', lang: 'en' });
  const hit = word.form ? safe(() => findForm(sentence.en, word.form), null) : null;
  if (hit) p.append(hit.before, el('strong', { text: hit.target }), hit.after);
  else p.textContent = sentence.en;
  return p;
}

// ---------- 画面本体 ----------

export async function startWordList(root, ctx) {
  const { words = [], sentencesById, getAudioBlob, onExit } = ctx || {};
  const audio = await import('../audio.js');

  const getSentence = (id) => {
    if (id == null || !sentencesById) return undefined;
    return sentencesById instanceof Map ? sentencesById.get(id) : sentencesById[id];
  };
  const progress = { ...safe(() => loadProgress(), {}) };
  const recOf = (id) => (Object.prototype.hasOwnProperty.call(progress, id) ? progress[id] : undefined);
  const sorted = sortWords(words);
  const byId = new Map(sorted.map((w) => [String(w.id), w]));
  const stages = listWordStages(sorted);

  const state = { text: '', stage: 'all', status: 'all', pos: 'all' };
  let result = [];       // 絞り込んだ結果
  let shown = 0;         // 描いた件数
  let observer = null;
  let sheet = null;      // 開いている詳細シート
  let lastFocus = null;
  let sheetToken = 0;    // 詳細を開き直したら増やす（古い音声の読み込みを捨てるため）
  let preparedFile = null;

  // ---- 枠 ----
  const noticeEl = el('p', { class: 'error', role: 'alert', hidden: true });
  const countEl = el('p', { class: 'wl-count', 'aria-live': 'polite' });
  const listEl = el('ul', { class: 'wl-list', 'aria-label': '単語の一覧' });
  const emptyEl = el('p', { class: 'card muted', hidden: true, text: '条件に合う語はありません。検索のことばや絞り込みを変えてください。' });
  const moreBtn = el('button', { type: 'button', class: 'btn wl-more', hidden: true }, 'もっと見る');
  const sentinel = el('div', { class: 'wl-sentinel', 'aria-hidden': 'true' });

  function showNotice(msg) {
    noticeEl.textContent = msg;
    noticeEl.hidden = false;
  }

  function quit() {
    audio.stop();
    cancelSpeech();
    search.cancel();
    if (observer) observer.disconnect();
    document.removeEventListener('keydown', onKey);
    if (typeof onExit === 'function') onExit();
  }

  // ---- 絞り込みの部品 ----
  const searchInput = el('input', {
    type: 'search', class: 'wl-search', 'aria-label': '見出し語か意味で検索',
    placeholder: '見出し語・意味で検索', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off',
    spellcheck: 'false', enterkeyhint: 'search',
  });
  const search = debounce(() => { state.text = searchInput.value; apply(); }, DEBOUNCE_MS);
  searchInput.addEventListener('input', search);
  searchInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); search.cancel(); state.text = searchInput.value; apply(); searchInput.blur(); }
  });

  function selectBox(id, label, options, key) {
    const sel = el('select', { class: 'select', id },
      options.map(([value, text]) => { const o = new Option(text, String(value)); return o; }));
    sel.value = String(state[key]);
    sel.addEventListener('change', () => {
      state[key] = key === 'stage' && sel.value !== 'all' ? Number(sel.value) : sel.value;
      apply();
    });
    return el('div', { class: 'wl-field' }, el('label', { class: 'field-label', for: id, text: label }), sel);
  }

  const stageField = selectBox('wl-stage', 'ステージ',
    [['all', 'すべて'], ...stages.map((s) => [s.stage, `ステージ ${s.stage}（例文 ${s.from}〜${s.to}）`])], 'stage');
  const statusField = selectBox('wl-status', '習得状況',
    [['all', 'すべて'], ...['new', 'learning', 'learned', 'mastered'].map((k) => [k, `${STATUS_MARKS[k]} ${STATUS_LABELS[k]}`]),
      ['unverified', '未確認の語だけ']], 'status');
  const posField = selectBox('wl-pos', '品詞', Object.entries(POS_GROUPS), 'pos');

  // ---- 一覧 ----

  function rowOf(w) {
    const status = statusOf(recOf(w.id));
    const rep = representativeId(w);
    return el('li', { class: 'wl-item' },
      el('button', { type: 'button', class: `wl-row wl-row-${status}`, 'data-id': String(w.id) },
        el('span', { class: 'wl-row-top' },
          el('span', { class: 'wl-word', lang: 'en', text: w.word || '' }),
          w.pos ? el('span', { class: 'pos', text: w.pos }) : null,
          unverifiedBadge(w),
          el('span', { class: 'wl-ex', text: rep == null ? '例文 —' : `例文 ${rep}` }),
        ),
        el('span', { class: 'wl-row-bottom' },
          statusBadge(status),
          el('span', { class: 'wl-meaning', text: w.meaning || '' }),
        ),
      ));
  }

  /** 次の PAGE_SIZE 件を足す */
  function renderMore() {
    if (shown >= result.length) return;
    const frag = document.createDocumentFragment();
    const end = Math.min(shown + PAGE_SIZE, result.length);
    for (let i = shown; i < end; i++) frag.append(rowOf(result[i]));
    listEl.append(frag);
    shown = end;
    const rest = result.length - shown;
    moreBtn.hidden = rest <= 0;
    moreBtn.textContent = `もっと見る（残り ${rest.toLocaleString('ja-JP')} 語）`;
  }

  /** 条件を変えたら一覧を描き直す */
  function apply() {
    result = filterWords(sorted, progress, state);
    shown = 0;
    listEl.replaceChildren();
    // replaceChildren に null を渡すと「null」と表示されるので、空のものは除く
    countEl.replaceChildren(...[
      el('strong', { class: 'wl-count-num', text: result.length.toLocaleString('ja-JP') }), ' 語',
      result.length !== sorted.length ? el('span', { class: 'muted small', text: `（全 ${sorted.length.toLocaleString('ja-JP')} 語中）` }) : null,
    ].filter((c) => c != null));
    emptyEl.hidden = result.length > 0;
    moreBtn.hidden = true;
    renderMore();
  }

  moreBtn.addEventListener('click', renderMore);
  listEl.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.wl-row');
    if (!btn || !listEl.contains(btn)) return;
    const w = byId.get(btn.getAttribute('data-id'));
    if (w) openDetail(w, btn);
  });

  // ---- 詳細（下部シート） ----

  async function loadAudio(file, token) {
    if (file === preparedFile) return true;
    try {
      const blob = await getAudioBlob(file);
      if (token !== sheetToken || !blob) return false;
      audio.prepare(file, blob);
      preparedFile = file;
      return true;
    } catch (e) {
      console.warn(e);
      return false;
    }
  }

  function listenButton(sentence) {
    const seg = sentence && sentence.seg && sentence.seg.en1;
    if (!sentence || !sentence.file || !Array.isArray(seg) || seg.length < 2 || typeof getAudioBlob !== 'function') {
      return el('button', { type: 'button', class: 'btn btn-listen', disabled: true, text: '例文の音声はありません' });
    }
    const btn = el('button', { type: 'button', class: 'btn btn-primary btn-listen', disabled: true, text: '音声を準備中…' });
    const ready = () => { btn.disabled = false; btn.textContent = '▶ 例文を聞く'; };
    if (sentence.file === preparedFile) ready();
    else {
      const token = sheetToken;
      loadAudio(sentence.file, token).then((ok) => {
        if (token !== sheetToken) return;
        if (ok) ready(); else btn.textContent = '音声が見つかりません';
      });
    }
    btn.addEventListener('click', () => {
      cancelSpeech();
      // await をはさまずに呼ぶ（iPhone 対策）
      audio.playSegment(seg[0], seg[1]).catch(() => showNotice(MSG_PLAY_FAILED));
    });
    return btn;
  }

  function speakButton(word) {
    const text = spokenText(word);
    if (!text || !canSpeak()) return null;
    return el('button', {
      type: 'button', class: 'btn',
      onclick: () => { audio.stop(); if (!audio.speakWord(text)) showNotice('この端末では単語の発音を再生できません。'); },
    }, '単語の発音');
  }

  function recordBox(rec) {
    const status = statusOf(rec);
    if (!rec) {
      return el('div', { class: 'wl-record' },
        el('h3', { class: 'wl-sub', text: '学習記録' }),
        el('p', {}, statusBadge(status), ' まだ学習していません'));
    }
    const num = (v) => (Number.isFinite(Number(v)) ? String(Number(v)) : '0');
    return el('div', { class: 'wl-record' },
      el('h3', { class: 'wl-sub', text: '学習記録' }),
      el('dl', { class: 'info wl-info' },
        el('dt', { text: '習得状況' }), el('dd', {}, statusBadge(status)),
        el('dt', { text: '箱' }), el('dd', { text: Number.isInteger(rec.box) ? `${rec.box}（0〜5）` : '-' }),
        el('dt', { text: '次の復習日' }), el('dd', { text: rec.mastered === true ? 'なし（マスター）' : (rec.due || '-') }),
        el('dt', { text: '正解 / 不正解' }), el('dd', { text: `○ ${num(rec.correct)} 回 / × ${num(rec.wrong)} 回` }),
        rec.last ? el('dt', { text: '最後に学習した日' }) : null, rec.last ? el('dd', { text: rec.last }) : null,
      ));
  }

  function otherSentencesBox(word) {
    const ids = otherSentenceIds(word);
    if (!ids.length) return null;
    return el('div', { class: 'wl-others' },
      el('h3', { class: 'wl-sub', text: 'ほかの例文（参考）' }),
      el('ul', { class: 'wl-others-list' }, ids.map((id) => {
        const s = getSentence(id);
        return el('li', {},
          el('span', { class: 'wl-others-num', text: `例文 ${id}` }),
          s && s.en ? el('span', { lang: 'en', text: s.en }) : el('span', { class: 'muted', text: '（例文が見つかりません）' }));
      })));
  }

  function openDetail(word, fromBtn) {
    closeDetail({ restoreFocus: false });
    sheetToken += 1;
    lastFocus = fromBtn || null;
    const rep = representativeId(word);
    const sentence = getSentence(rep);
    const closeBtn = el('button', { type: 'button', class: 'btn wl-close', onclick: () => closeDetail() }, '閉じる');
    const panel = el('div', { class: 'wl-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'wl-sheet-title', tabindex: '-1' },
      el('div', { class: 'wl-sheet-body' },
        el('div', { class: 'headword-row' },
          el('span', { class: 'headword', lang: 'en', id: 'wl-sheet-title', text: word.word || '' }),
          unverifiedBadge(word),
          word.pos ? el('span', { class: 'pos', text: word.pos }) : null,
        ),
        el('p', { class: 'meaning', text: word.meaning || '-' }),
        el('h3', { class: 'wl-sub', text: rep == null ? '代表の例文' : `代表の例文（例文 ${rep}）` }),
        sentence ? boldSentence(sentence, word) : el('p', { class: 'muted', text: '例文が見つかりません。' }),
        sentence && sentence.ja ? el('p', { class: 'sentence-ja', text: sentence.ja }) : null,
        el('div', { class: 'btn-row' }, listenButton(sentence), speakButton(word)),
        recordBox(recOf(word.id)),
        otherSentencesBox(word),
      ),
      el('div', { class: 'wl-sheet-foot' }, closeBtn),
    );
    sheet = el('div', { class: 'wl-backdrop' }, panel);
    sheet.addEventListener('click', (ev) => { if (ev.target === sheet) closeDetail(); });
    root.querySelector('.wordlist').append(sheet);
    panel.focus({ preventScroll: true });
  }

  function closeDetail({ restoreFocus = true } = {}) {
    if (!sheet) return;
    sheetToken += 1;
    audio.stop();
    cancelSpeech();
    sheet.remove();
    sheet = null;
    if (restoreFocus && lastFocus && lastFocus.isConnected) lastFocus.focus({ preventScroll: true });
    lastFocus = null;
  }

  function onKey(ev) {
    if (ev.key === 'Escape' && sheet) { ev.preventDefault(); closeDetail(); }
  }
  document.addEventListener('keydown', onKey);

  // ---- 描く ----
  const head = el('div', { class: 'wl-head' },
    el('h2', { class: 'wl-title', text: '単語一覧' }),
    el('button', { type: 'button', class: 'btn btn-quit', onclick: quit }, 'やめる'),
  );
  const filters = el('div', { class: 'card wl-filters' },
    searchInput,
    el('div', { class: 'wl-selects' }, stageField, statusField, posField),
  );
  root.replaceChildren(el('div', { class: 'wordlist' },
    head,
    noticeEl,
    filters,
    countEl,
    emptyEl,
    listEl,
    moreBtn,
    sentinel,
  ));

  // 一覧の最後が見えたら次を足す（使えない環境では「もっと見る」ボタンだけ）
  if (typeof IntersectionObserver === 'function') {
    observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && shown < result.length) renderMore();
    }, { rootMargin: '400px 0px' });
    observer.observe(sentinel);
  }

  if (!sorted.length) {
    emptyEl.textContent = '単語がありません。データパックを確認してください。';
  }
  apply();
  window.scrollTo(0, 0);
}
