// 苦手復習（不正解が多い語・箱 0 の語だけを出題する）
//
// 使い方：startWeak(root, { words, sentencesById, getAudioBlob, onExit })
//   root          … 描画先の要素
//   words         … 全単語（db.getAllWords の結果）
//   sentencesById … 例文の Map（id → sentence）。普通のオブジェクトでもよい
//   getAudioBlob  … ファイル名 → Blob（db.getAudioBlob）
//   onExit        … やめた・終わったときに呼ぶ（ホームに戻す）
//
// この画面で決めたこと：
// - 苦手な語：学習記録（kk.progress.v1）があり、mastered でなく、次のどれかに当てはまる語。
//     ① 箱 0　② wrong が 2 以上　③ wrong > correct
//   並び順：wrong の多い順 → 箱の小さい順 → 代表の例文番号（sentenceIds[0]）の小さい順 → id 順。
// - 出題数は 10 / 20 / すべて。苦手な語の並び順の先頭から取る。
// - 出題の形式は「箱に合わせる（初期）」「意味 4 択」「穴埋め」「スペル」。
//   形式を選んだときは quiz.makeQuestion にその形式に当たる箱（4 択 = 0、穴埋め = 2、スペル = 4）を渡す。
//   例文に form が見つからない語は、どの形式でも意味 4 択になる（quiz.js の決まり）。
// - 学習記録の箱（box）と期限（due）は変えない（変えてよいのは今日の学習だけ）。
//   store.logAnswer(今日, { correct, isNew: false }) だけは呼ぶ（今日の目標の問題数に数える）。
// - このモードでの成績は localStorage 'kk.weak.v1' に保存する（読み書きは try/catch）。
//     { version: 1, words: { "<wordId>": { correct, wrong, streak, last } }, settings: { count, format } }
//   streak は「苦手復習で続けて正解した回数」。不正解で 0 に戻す。3 以上で「克服」の印を出す。
//   「もう一度」（最後の出し直し）の答えも成績に数える。
// - 「克服」した語も、学習記録の上で苦手の条件に当てはまる間は一覧と出題に残す（印を出すだけ）。
// - 不正解の語は、その回の最後にもう一度だけ出す。
// - 穴埋め・スペルでは答える前に「単語の発音」を出さない（today.js と同じ）。スペルの「わからない」は不正解。
//
// 音声（audio.js）は読み込んだ時点で Audio 要素を作るため、node のテストで import できるように
// startWeak の中で動的 import する。DOM を使わない関数はこのファイルから export してテストする。

import { todayStr } from '../srs.js';
import { loadProgress, logAnswer } from '../store.js';
import { makeQuestion, makeChoice, findForm, checkSpelling } from '../quiz.js';

export const WEAK_KEY = 'kk.weak.v1';
export const OVERCOME_STREAK = 3;                 // 苦手復習で何回続けて正解したら「克服」か
export const COUNT_CHOICES = Object.freeze([10, 20, 'all']);
export const FORMAT_CHOICES = Object.freeze(['auto', 'choice', 'cloze', 'spell']);
export const FORMAT_BOX = Object.freeze({ choice: 0, cloze: 2, spell: 4 }); // 形式 → makeQuestion に渡す箱
export const DEFAULT_WEAK_SETTINGS = Object.freeze({ count: 10, format: 'auto' });

const FORMAT_LABELS = { auto: '箱に合わせる', choice: '意味 4 択', cloze: '穴埋め', spell: 'スペル' };
const MSG_PLAY_FAILED = '音声を再生できませんでした。マナーモードや音量を確認して、もう一度押してください。';
const MSG_SAVE_FAILED = '苦手復習の成績を保存できませんでした。この回の結果は、アプリを閉じると消えます。';

// ---------- DOM を使わない部分（テスト対象） ----------

function nonNegInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function firstSentenceId(word) {
  const id = Array.isArray(word.sentenceIds) ? Number(word.sentenceIds[0]) : NaN;
  return Number.isFinite(id) ? id : Number.POSITIVE_INFINITY;
}

/** 学習記録 1 件が「苦手」に当たるか（記録が無い・mastered は false） */
export function isWeakRecord(rec) {
  if (!rec || typeof rec !== 'object') return false;
  if (rec.mastered === true) return false;
  const box = Number(rec.box);
  const wrong = nonNegInt(rec.wrong);
  const correct = nonNegInt(rec.correct);
  return box === 0 || wrong >= 2 || wrong > correct;
}

/**
 * 苦手な語を選んで並べる。
 * opts.limit（正の整数）を渡すと先頭からその件数だけ返す。
 * 戻り値：単語オブジェクトの配列（wrong の多い順 → 箱の小さい順 → 代表の例文番号順 → id 順）
 */
export function pickWeakWords(words, progress, opts = {}) {
  const prog = progress && typeof progress === 'object' ? progress : {};
  const list = (Array.isArray(words) ? words : []).filter((w) =>
    w && w.id != null && Object.prototype.hasOwnProperty.call(prog, w.id) && isWeakRecord(prog[w.id]));
  list.sort((a, b) => {
    const ra = prog[a.id];
    const rb = prog[b.id];
    const dw = nonNegInt(rb.wrong) - nonNegInt(ra.wrong);
    if (dw) return dw;
    const db = nonNegInt(ra.box) - nonNegInt(rb.box);
    if (db) return db;
    const sa = firstSentenceId(a);
    const sb = firstSentenceId(b);
    if (sa !== sb) return sa < sb ? -1 : 1; // 例文の無い語（Infinity）は後ろ
    return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
  });
  const limit = opts && Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : null;
  return limit ? list.slice(0, limit) : list;
}

/** 苦手な語の数（ホームの「苦手な語 ○ 語」用） */
export function countWeakWords(words, progress) {
  return pickWeakWords(words, progress).length;
}

/** 形式と学習記録から、makeQuestion に渡す箱を決める（auto は学習記録の箱） */
export function boxForFormat(format, rec) {
  if (Object.prototype.hasOwnProperty.call(FORMAT_BOX, format)) return FORMAT_BOX[format];
  const box = rec && Number.isInteger(rec.box) ? rec.box : 0;
  return Math.min(Math.max(box, 0), 5);
}

/**
 * 出題リストを作る。weakWords は pickWeakWords の結果。
 * count は 10 / 20 などの数か 'all'。戻り値：[{ id, retry: false }]
 */
export function buildWeakQueue(weakWords, count) {
  const list = (Array.isArray(weakWords) ? weakWords : []).filter((w) => w && w.id != null);
  const n = count === 'all' ? list.length : (Number.isInteger(count) && count > 0 ? count : list.length);
  return list.slice(0, n).map((w) => ({ id: w.id, retry: false }));
}

/** 不正解のときの出し直しを足す（1 回だけ）。queue を直接変え、足したら true */
export function pushRetry(queue, item, correct) {
  if (correct || !item || item.retry) return false;
  queue.push({ id: item.id, retry: true });
  return true;
}

/** 設定（出題数・形式）を正しい値にそろえる */
export function normalizeWeakSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    count: COUNT_CHOICES.includes(s.count) ? s.count : DEFAULT_WEAK_SETTINGS.count,
    format: FORMAT_CHOICES.includes(s.format) ? s.format : DEFAULT_WEAK_SETTINGS.format,
  };
}

/** 成績データ全体を正しい形にそろえる（壊れた項目は捨てる） */
export function normalizeWeakData(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const words = {};
  const srcWords = src.words && typeof src.words === 'object' && !Array.isArray(src.words) ? src.words : {};
  for (const [id, st] of Object.entries(srcWords)) {
    if (!st || typeof st !== 'object') continue;
    words[id] = {
      correct: nonNegInt(st.correct),
      wrong: nonNegInt(st.wrong),
      streak: nonNegInt(st.streak),
      last: typeof st.last === 'string' ? st.last : '',
    };
  }
  return { version: 1, words, settings: normalizeWeakSettings(src.settings) };
}

function defaultStorage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

/** kk.weak.v1 を読む。無い・壊れている・使えない環境では空のデータ */
export function loadWeakData(storage = defaultStorage()) {
  try {
    if (!storage) return normalizeWeakData(null);
    const text = storage.getItem(WEAK_KEY);
    if (!text) return normalizeWeakData(null);
    return normalizeWeakData(JSON.parse(text));
  } catch {
    return normalizeWeakData(null);
  }
}

/** kk.weak.v1 に書く。書けたら true（使えない環境・容量不足では false） */
export function saveWeakData(data, storage = defaultStorage()) {
  try {
    if (!storage) return false;
    storage.setItem(WEAK_KEY, JSON.stringify(normalizeWeakData(data)));
    return true;
  } catch {
    return false;
  }
}

/** 1 問の答えを成績に足した新しいデータを返す（元のデータは変えない） */
export function applyWeakAnswer(data, wordId, correct, dateStr) {
  const base = normalizeWeakData(data);
  const cur = base.words[wordId] || { correct: 0, wrong: 0, streak: 0, last: '' };
  base.words[wordId] = correct
    ? { correct: cur.correct + 1, wrong: cur.wrong, streak: cur.streak + 1, last: dateStr || '' }
    : { correct: cur.correct, wrong: cur.wrong + 1, streak: 0, last: dateStr || '' };
  return base;
}

/** 苦手復習で 3 回続けて正解した語か（stat は data.words[id]） */
export function isOvercome(stat) {
  return !!stat && nonNegInt(stat.streak) >= OVERCOME_STREAK;
}

// ---------- 画面の道具（today.js と同じ） ----------

function safe(fn, fallback) {
  try { return fn(); } catch (e) { console.warn(e); return fallback; }
}

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

/** 単語の発音用の文字列（"..." や "～" は読まない） */
function spokenText(word) {
  return String(word.word || '')
    .replace(/\.{2,}|…|～|〜|~/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function canSpeak() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

function cancelSpeech() {
  if (canSpeak()) { try { speechSynthesis.cancel(); } catch { /* 無視 */ } }
}

function unverifiedBadge(word) {
  return word.verified !== true
    ? el('span', { class: 'badge-unverified', title: 'まだ本と照合していない語です', text: '未確認' })
    : null;
}

function overcomeBadge(stat) {
  return isOvercome(stat)
    ? el('span', { class: 'weak-badge-overcome', title: '苦手復習で 3 回続けて正解しました', text: '克服' })
    : null;
}

function headword(word, { showPos = true } = {}) {
  return el('div', { class: 'headword-row' },
    el('span', { class: 'headword', lang: 'en', text: word.word || '' }),
    unverifiedBadge(word),
    showPos && word.pos ? el('span', { class: 'pos', text: word.pos }) : null,
  );
}

function boldSentence(sentence, word) {
  if (!sentence || !sentence.en) return null;
  const p = el('p', { class: 'sentence-en', lang: 'en' });
  const hit = word.form ? safe(() => findForm(sentence.en, word.form), null) : null;
  if (hit) p.append(hit.before, el('strong', { text: hit.target }), hit.after);
  else p.textContent = sentence.en;
  return p;
}

function blankSentence(parts) {
  return el('p', { class: 'sentence-en', lang: 'en' },
    parts.before || '',
    el('span', { class: 'blank', role: 'img', 'aria-label': '空欄' }),
    parts.after || '',
  );
}

function jaSentence(sentence) {
  if (!sentence || !sentence.ja) return null;
  return el('p', { class: 'sentence-ja', text: sentence.ja });
}

// ---------- 画面本体 ----------

export async function startWeak(root, ctx) {
  const { words = [], sentencesById, getAudioBlob, onExit } = ctx || {};
  const { prepare, playSegment, speakWord, stop } = await import('../audio.js');
  const wordsById = new Map(words.filter((w) => w && w.id != null).map((w) => [w.id, w]));
  const getSentence = (id) => {
    if (id == null || !sentencesById) return undefined;
    return sentencesById instanceof Map ? sentencesById.get(id) : sentencesById[id];
  };
  const sentenceOf = (word) => getSentence(Array.isArray(word.sentenceIds) ? word.sentenceIds[0] : undefined);

  const today = todayStr();
  const progress = { ...safe(() => loadProgress(), {}) }; // 読むだけ（箱・期限は変えない）
  let weakData = loadWeakData();
  let settings = normalizeWeakSettings(weakData.settings);

  let queue = [];
  let index = 0;
  let answered = 0;
  let correctCount = 0;
  let missed = [];
  let saveFailed = false;
  let renderToken = 0;
  let preparedFile = null;
  let noticeEl = null;

  // ---- 音声 ----

  async function loadAudio(file, token) {
    if (file === preparedFile) return true;
    try {
      const blob = await getAudioBlob(file);
      if (token !== renderToken) return false;
      if (!blob) return false;
      prepare(file, blob);
      preparedFile = file;
      return true;
    } catch (e) {
      console.warn(e);
      return false;
    }
  }

  /** 「例文を聞く」ボタン（英語 1 回目の区間 seg.en1） */
  function listenButton(sentence, { primary = false } = {}) {
    const cls = primary ? 'btn btn-primary btn-listen' : 'btn btn-listen';
    const seg = sentence && sentence.seg && sentence.seg.en1;
    if (!sentence || !sentence.file || !Array.isArray(seg) || seg.length < 2) {
      return el('button', { type: 'button', class: cls, disabled: true, text: '例文の音声はありません' });
    }
    const btn = el('button', { type: 'button', class: cls, disabled: true, text: '音声を準備中…' });
    const ready = () => { btn.disabled = false; btn.textContent = '▶ 例文を聞く'; };
    if (sentence.file === preparedFile) {
      ready();
    } else {
      const token = renderToken;
      loadAudio(sentence.file, token).then((ok) => {
        if (token !== renderToken) return;
        if (ok) ready(); else btn.textContent = '音声が見つかりません';
      });
    }
    btn.addEventListener('click', () => {
      cancelSpeech();
      // await をはさまずに呼ぶ（iPhone 対策）
      playSegment(seg[0], seg[1]).catch(() => showNotice(MSG_PLAY_FAILED));
    });
    return btn;
  }

  function speakButton(word) {
    const text = spokenText(word);
    if (!text || !canSpeak()) return null;
    return el('button', {
      type: 'button', class: 'btn',
      onclick: () => { stop(); if (!speakWord(text)) showNotice('この端末では単語の発音を再生できません。'); },
    }, '単語の発音');
  }

  function buttonRow(...buttons) {
    const list = buttons.filter(Boolean);
    if (!list.length) return null;
    return el('div', { class: list.length > 1 ? 'btn-row' : 'btn-row btn-row-single' }, ...list);
  }

  // ---- 画面の枠 ----

  function showNotice(msg) {
    if (!noticeEl) return;
    noticeEl.textContent = msg;
    noticeEl.hidden = false;
  }

  function quit() {
    stop();
    cancelSpeech();
    if (typeof onExit === 'function') onExit();
  }

  function onQuitClick() {
    if (answered === 0 || window.confirm('苦手復習をやめて、ホームに戻りますか？\n（ここまでに答えた分は保存されています）')) quit();
  }

  function beginScreen() {
    renderToken += 1;
    stop();
    cancelSpeech();
  }

  /** 上部（何問目か・進捗・やめる）＋本体＋下寄せのボタン */
  function mount(body, bottom, { head = 'quiz' } = {}) {
    noticeEl = el('p', { class: 'error', role: 'alert', hidden: true });
    if (saveFailed) { noticeEl.textContent = MSG_SAVE_FAILED; noticeEl.hidden = false; }
    let headEl = null;
    if (head === 'quiz') {
      const total = queue.length;
      const pos = Math.min(index + 1, total);
      const pct = total ? Math.round((index / total) * 100) : 0;
      headEl = el('div', { class: 'study-head' },
        el('span', { class: 'study-count', text: `${pos} / ${total}` }),
        el('div', {
          class: 'progress study-progress', role: 'progressbar',
          'aria-label': '苦手復習の進み具合', 'aria-valuemin': 0, 'aria-valuemax': total, 'aria-valuenow': index,
        }, el('div', { class: 'progress-bar', style: `width:${pct}%` })),
        el('button', { type: 'button', class: 'btn btn-quit', onclick: onQuitClick }, 'やめる'),
      );
    } else if (head === 'title') {
      headEl = el('div', { class: 'study-head weak-head' },
        el('h2', { class: 'weak-title', text: '苦手復習' }),
        el('button', { type: 'button', class: 'btn btn-quit', onclick: quit }, 'やめる'),
      );
    }
    root.replaceChildren(el('div', { class: 'study weak' },
      headEl,
      noticeEl,
      el('div', { class: 'study-body' }, body),
      el('div', { class: 'study-bottom' }, bottom),
    ));
    window.scrollTo(0, 0);
  }

  // ---- 最初の画面 ----

  function radioGroup(name, legend, options, current, onChange, rowClass) {
    return el('fieldset', { class: 'choice-group' },
      el('legend', { class: 'field-label', text: legend }),
      el('div', { class: rowClass },
        options.map(([value, label]) => el('label', { class: 'choice' },
          el('input', {
            type: 'radio', name, value: String(value), checked: value === current,
            onchange: () => onChange(value),
          }),
          label,
        )),
      ),
    );
  }

  function renderStart() {
    beginScreen();
    // 「克服」した語は後ろに回す（まだ苦手な語から取り組めるように）
    const picked = pickWeakWords(words, progress);
    const overcome = (w) => isOvercome(weakData.words && weakData.words[w.id]);
    const weak = [...picked.filter((w) => !overcome(w)), ...picked.filter(overcome)];
    if (!weak.length) {
      const body = el('div', { class: 'card' },
        el('h3', { text: '苦手な語はありません' }),
        el('p', { class: 'muted', text: 'まちがえた語や、箱 0 の語があると、ここで復習できます。' }),
      );
      const bottom = el('button', { type: 'button', class: 'btn btn-primary btn-next', onclick: quit }, 'ホームに戻る');
      mount(body, bottom, { head: 'title' });
      return;
    }

    const countText = (c) => (c === 'all' ? `すべて（${weak.length}）` : `${c} 問`);
    const startBtn = el('button', { type: 'button', class: 'btn btn-primary btn-start' });
    const updateStart = () => {
      const n = buildWeakQueue(weak, settings.count).length;
      startBtn.textContent = `始める（${n} 問）`;
    };
    const setSetting = (partial) => {
      settings = normalizeWeakSettings({ ...settings, ...partial });
      weakData = { ...weakData, settings };
      saveWeakData(weakData); // 設定は保存できなくても続ける
      updateStart();
    };
    updateStart();
    startBtn.addEventListener('click', () => beginQuiz(weak));

    const list = el('ul', { class: 'weak-list' }, weak.map((w) => {
      const rec = progress[w.id] || {};
      const stat = weakData.words[w.id];
      return el('li', { class: 'weak-item' },
        el('div', { class: 'weak-item-head' },
          el('span', { class: 'weak-word', lang: 'en', text: w.word || '' }),
          unverifiedBadge(w),
          overcomeBadge(stat),
          el('span', { class: 'weak-wrong', text: `まちがい ${nonNegInt(rec.wrong)} 回` }),
        ),
        el('div', { class: 'weak-meaning muted', text: w.meaning || '' }),
      );
    }));

    const body = [
      el('div', { class: 'card' },
        el('p', { class: 'weak-summary' }, '苦手な語 ', el('strong', { class: 'weak-num', text: String(weak.length) }), ' 語'),
        el('p', { class: 'muted small', text: 'まちがいの多い順です。ここで答えても、今日の学習の予定（箱・期限）は変わりません。' }),
        radioGroup('weak-count', '出題数', COUNT_CHOICES.map((c) => [c, countText(c)]), settings.count,
          (v) => setSetting({ count: v }), 'choice-row weak-row-3'),
        radioGroup('weak-format', '出題の形式', FORMAT_CHOICES.map((f) => [f, FORMAT_LABELS[f]]), settings.format,
          (v) => setSetting({ format: v }), 'choice-row choice-row-2'),
      ),
      el('div', { class: 'card' },
        el('h3', { text: '苦手な語の一覧' }),
        list,
      ),
    ];
    mount(body, startBtn, { head: 'title' });
  }

  function beginQuiz(weak) {
    queue = buildWeakQueue(weak, settings.count);
    index = 0;
    answered = 0;
    correctCount = 0;
    missed = [];
    next();
  }

  // ---- 進行 ----

  function next() {
    if (index >= queue.length) { renderEnd(); return; }
    renderQuestion(queue[index]);
  }

  function goNext() {
    index += 1;
    next();
  }

  /** 答えを記録する（学習記録の箱・期限は変えない） */
  function record(item, correct) {
    weakData = applyWeakAnswer(weakData, item.id, correct, today);
    let ok = saveWeakData(weakData);
    try {
      logAnswer(today, { correct, isNew: false });
    } catch (e) {
      console.warn(e);
      ok = false;
    }
    if (!ok && !saveFailed) { saveFailed = true; showNotice(MSG_SAVE_FAILED); }
    answered += 1;
    if (correct) correctCount += 1;
    if (!correct && !missed.includes(item.id)) missed.push(item.id);
    pushRetry(queue, item, correct);
  }

  // ---- 問題 ----

  function makeQ(word, sentence) {
    const box = boxForFormat(settings.format, progress[word.id]);
    let q = null;
    if (sentence) q = safe(() => makeQuestion(word, sentence, words, box), null);
    if (!q) q = safe(() => makeChoice(word, words), null);
    return q;
  }

  function renderQuestion(item) {
    const word = wordsById.get(item.id);
    const sentence = word ? sentenceOf(word) : undefined;
    const q = word ? makeQ(word, sentence) : null;
    if (!q) {
      console.warn('問題を作れませんでした', item.id);
      goNext();
      return;
    }
    beginScreen();
    if (q.type === 'cloze') renderCloze(item, word, sentence, q);
    else if (q.type === 'spell') renderSpell(item, word, sentence, q);
    else renderChoice(item, word, sentence, q);
  }

  function kicker(item, text) {
    return el('p', { class: 'kicker' },
      item.retry ? el('span', { class: 'tag-retry', text: 'もう一度' }) : null,
      text,
    );
  }

  function optionButtons(q, { lang = null, onAnswer }) {
    const box = el('div', { class: 'options' });
    const buttons = q.options.map((text, i) => el('button', {
      type: 'button', class: 'btn option', lang,
      onclick: () => {
        if (box.classList.contains('answered')) return;
        box.classList.add('answered');
        const correct = i === q.answerIndex;
        buttons.forEach((b, j) => {
          b.disabled = true;
          const mark = b.querySelector('.mark');
          if (j === q.answerIndex) {
            b.classList.add('is-correct');
            mark.textContent = '○';
          } else if (j === i) {
            b.classList.add('is-wrong');
            mark.textContent = '×';
          } else {
            b.classList.add('is-dim');
          }
          if (j === i) b.setAttribute('aria-label', `${correct ? '正解' : '不正解'}：${text}`);
        });
        onAnswer(correct);
      },
    }, el('span', { class: 'mark', 'aria-hidden': 'true' }), el('span', { class: 'option-text', text })));
    box.append(...buttons);
    return box;
  }

  function showFeedback(item, word, sentence, correct, { answerText = '', extraBottom = null } = {}) {
    const study = root.querySelector('.study');
    const bodyEl = study.querySelector('.study-body');
    const bottomEl = study.querySelector('.study-bottom');
    const stat = weakData.words[word.id];
    const result = el('p', { class: correct ? 'result ok' : 'result ng' },
      el('span', { class: 'result-mark', 'aria-hidden': 'true', text: correct ? '○' : '×' }),
      correct ? '正解' : '不正解',
    );
    const card = el('div', { class: 'card' },
      result,
      !correct && answerText ? el('p', { class: 'answer-line' }, '正しい答え：', el('strong', { lang: 'en', text: answerText })) : null,
      headword(word),
      el('p', { class: 'meaning', text: word.meaning || '' }),
      boldSentence(sentence, word),
      jaSentence(sentence),
      buttonRow(listenButton(sentence), speakButton(word)),
      correct && isOvercome(stat)
        ? el('p', { class: 'weak-overcome-line' }, overcomeBadge(stat), ` 苦手復習で ${stat.streak} 回続けて正解しています。`)
        : null,
      !correct && !item.retry ? el('p', { class: 'muted small', text: 'この語は、最後にもう一度出します。' }) : null,
    );
    bodyEl.replaceChildren(card);
    if (extraBottom) bottomEl.replaceChildren(extraBottom);
    const isLast = index + 1 >= queue.length;
    const nextBtn = el('button', { type: 'button', class: 'btn btn-primary btn-next', onclick: goNext },
      isLast ? '結果を見る' : '次へ');
    bottomEl.append(nextBtn);
    window.scrollTo(0, 0);
    nextBtn.focus({ preventScroll: true });
  }

  // 意味 4 択
  function renderChoice(item, word, sentence, q) {
    const body = [
      kicker(item, '意味を選ぼう'),
      el('div', { class: 'card' },
        headword(word, { showPos: false }),
        boldSentence(sentence, word),
        buttonRow(listenButton(sentence), speakButton(word)),
      ),
    ];
    const bottom = optionButtons(q, {
      onAnswer: (correct) => {
        record(item, correct);
        showFeedback(item, word, sentence, correct, { answerText: q.options[q.answerIndex] });
      },
    });
    mount(body, bottom);
  }

  // リスニング穴埋め
  function renderCloze(item, word, sentence, q) {
    const body = [
      kicker(item, '例文を聞いて、空欄に入る語を選ぼう'),
      el('div', { class: 'card' },
        listenButton(sentence, { primary: true }),
        blankSentence(q.parts),
      ),
    ];
    const bottom = optionButtons(q, {
      lang: 'en',
      onAnswer: (correct) => {
        record(item, correct);
        showFeedback(item, word, sentence, correct, { answerText: q.options[q.answerIndex] });
      },
    });
    mount(body, bottom);
  }

  // スペル入力
  function renderSpell(item, word, sentence, q) {
    const body = [
      kicker(item, '意味に合う英語を書こう'),
      el('div', { class: 'card' },
        el('p', { class: 'meaning meaning-big', text: q.meaning || word.meaning || '' }),
        word.pos ? el('p', { class: 'pos', text: word.pos }) : null,
        blankSentence(q.parts),
        buttonRow(listenButton(sentence)),
      ),
    ];

    const input = el('input', {
      type: 'text', class: 'spell-input', lang: 'en', 'aria-label': '答えの英語',
      autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'done',
      placeholder: 'ここに入力',
    });
    const message = el('p', { class: 'muted small', 'aria-live': 'polite' });
    const hintText = el('span', { class: 'hint-text', 'aria-live': 'polite' });
    const hintBtn = el('button', {
      type: 'button', class: 'btn btn-hint',
      onclick: () => {
        hintText.replaceChildren('最初の 1 文字：', el('strong', { lang: 'en', text: q.hint || '' }));
        hintBtn.disabled = true;
        input.focus();
      },
    }, 'ヒント（最初の 1 文字）');

    let done = false;
    const finish = (correct, inputText) => {
      if (done) return;
      done = true;
      input.disabled = true;
      record(item, correct);
      const yours = el('p', { class: correct ? 'your-answer ok' : 'your-answer ng' },
        el('span', { class: 'result-mark', 'aria-hidden': 'true', text: correct ? '○' : '×' }),
        'あなたの答え：',
        el('span', { lang: 'en', text: inputText || '（わからない）' }),
      );
      showFeedback(item, word, sentence, correct, { answerText: q.answer, extraBottom: yours });
    };

    const form = el('form', {
      class: 'spell-form', novalidate: true,
      onsubmit: (ev) => {
        ev.preventDefault();
        const value = input.value;
        if (!value.trim()) {
          message.textContent = '英語を入力してから「答える」を押してください。';
          input.focus();
          return;
        }
        finish(safe(() => checkSpelling(value, q.answer), false), value.trim());
      },
    },
      el('div', { class: 'hint-row' }, hintBtn, hintText),
      input,
      message,
      el('button', { type: 'submit', class: 'btn btn-primary' }, '答える'),
      el('button', { type: 'button', class: 'btn btn-subtle', onclick: () => finish(false, '') }, 'わからない（答えを見る）'),
    );
    mount(body, form);
  }

  // ---- 終了画面 ----

  function renderEnd() {
    beginScreen();
    const body = [];
    if (answered === 0) {
      body.push(el('div', { class: 'card' },
        el('h2', { text: '出題できる語がありませんでした' }),
        el('p', { class: 'muted', text: '問題を作れない語だけでした。データパックを確認してください。' }),
      ));
    } else {
      body.push(el('div', { class: 'card' },
        el('h2', { text: '苦手復習が終わりました' }),
        el('p', { class: 'score' },
          el('strong', { class: 'score-num', text: String(correctCount) }),
          ` / ${answered} 問 正解`,
        ),
      ));
      if (missed.length) {
        body.push(el('div', { class: 'card' },
          el('h3', { text: 'まちがえた語' }),
          el('ul', { class: 'missed-list' }, missed.map((id) => {
            const w = wordsById.get(id) || {};
            return el('li', {},
              el('span', { lang: 'en', class: 'missed-word', text: w.word || '' }),
              el('span', { class: 'muted', text: w.meaning || '' }),
            );
          })),
        ));
      } else {
        body.push(el('div', { class: 'card' }, el('p', { text: 'まちがえた語はありませんでした。' })));
      }
    }
    const bottom = el('button', { type: 'button', class: 'btn btn-primary btn-next', onclick: quit }, 'ホームに戻る');
    mount(body, bottom, { head: 'none' });
  }

  renderStart();
}
