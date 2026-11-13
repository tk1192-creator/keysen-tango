// 今日の学習（復習 → 新規）の画面
//
// 使い方：startToday(root, { words, sentencesById, getAudioBlob, onExit })
//   root          … 描画先の要素
//   words         … 全単語（db.getAllWords の結果）
//   sentencesById … 例文の Map（id → sentence）。普通のオブジェクトでもよい
//   getAudioBlob  … ファイル名 → Blob（db.getAudioBlob）
//   onExit        … 終了・中断したときに呼ぶ（ホームに戻す）
//
// js/API.md の範囲で、この画面で決めたこと：
// - 1 日のメニューは srs.buildDailyMenu で作り、復習 → 新規の順に出す。
// - 新規の語は「出会う」カードを 1 枚見せてから、箱 0 の問題（意味 4 択）を出す。
// - 答えるたびに srs.applyAnswer → store.saveRecord、store.logAnswer で 1 問ずつ保存する。
//   この回の中では、読み込んだ学習記録（progress）もメモリ上で更新して使う
//   （記録を保存できない環境でも、この回は最後まで回せるように）。
// - 不正解の語は、その回の最後にもう一度だけ出す。2 回目の結果も記録するが、新規の数には数えない。
// - 穴埋め（cloze）とスペル（spell）では、答える前に「単語の発音」を出さない（答えがわかってしまうため）。
//   答えた後の画面では出す。
// - スペルの「わからない」は不正解として記録する。
// - 例文の音声は、カード・問題を表示した時点で prepare() し、ボタンでは playSegment() だけを呼ぶ（iPhone 対策）。

import { todayStr, applyAnswer, buildDailyMenu } from '../srs.js';
import { loadProgress, loadSettings, saveRecord, logAnswer, dayLog, streak } from '../store.js';
import { makeQuestion, makeChoice, findForm, checkSpelling } from '../quiz.js';
import { prepare, playSegment, speakWord, stop } from '../audio.js';

const DEFAULT_SETTINGS = { newPerDay: 10, dailyGoal: 20 };
const MSG_PLAY_FAILED = '音声を再生できませんでした。マナーモードや音量を確認して、もう一度押してください。';
const MSG_SAVE_FAILED = '学習の記録を保存できませんでした。この回の結果は、アプリを閉じると消えます。';

// ---------- 小さな道具 ----------

/** 例外が出たら fallback を返す（記録が読めない環境でも画面を止めないため） */
function safe(fn, fallback) {
  try { return fn(); } catch (e) { console.warn(e); return fallback; }
}

/**
 * 要素を作る。props の class / text / on○○ は特別扱い、それ以外は属性
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

/** 見出し語（＋未確認の印、品詞） */
function headword(word, { big = true, showPos = true } = {}) {
  return el('div', { class: big ? 'headword-row' : 'headword-row headword-row-small' },
    el('span', { class: 'headword', lang: 'en', text: word.word || '' }),
    word.verified !== true ? el('span', { class: 'badge-unverified', title: 'まだ本と照合していない語です', text: '未確認' }) : null,
    showPos && word.pos ? el('span', { class: 'pos', text: word.pos }) : null,
  );
}

/** 例文（見出し語を太字） */
function boldSentence(sentence, word) {
  const p = el('p', { class: 'sentence-en', lang: 'en' });
  if (!sentence || !sentence.en) return null;
  const hit = word.form ? safe(() => findForm(sentence.en, word.form), null) : null;
  if (hit) p.append(hit.before, el('strong', { text: hit.target }), hit.after);
  else p.textContent = sentence.en;
  return p;
}

/** 空欄つきの例文 */
function blankSentence(parts) {
  return el('p', { class: 'sentence-en', lang: 'en' },
    parts.before || '',
    el('span', { class: 'blank', role: 'img', 'aria-label': '空欄' }),
    parts.after || '',
  );
}

/** 和訳 */
function jaSentence(sentence) {
  if (!sentence || !sentence.ja) return null;
  return el('p', { class: 'sentence-ja', text: sentence.ja });
}

// ---------- 画面本体 ----------

export async function startToday(root, ctx) {
  const { words = [], sentencesById, getAudioBlob, onExit } = ctx || {};
  const wordsById = new Map(words.map((w) => [w.id, w]));
  const getSentence = (id) => {
    if (id == null || !sentencesById) return undefined;
    return sentencesById instanceof Map ? sentencesById.get(id) : sentencesById[id];
  };
  const sentenceOf = (word) => getSentence(Array.isArray(word.sentenceIds) ? word.sentenceIds[0] : undefined);

  // 1 日のメニュー
  const today = todayStr();
  const progress = { ...safe(() => loadProgress(), {}) };
  const settings = { ...DEFAULT_SETTINGS, ...safe(() => loadSettings(), {}) };
  const newDoneToday = safe(() => dayLog(today).newWords, 0) || 0;
  const menu = buildDailyMenu(words, progress, { date: today, newPerDay: settings.newPerDay, newDoneToday });
  const queue = [
    ...menu.reviews.map((id) => ({ id, isNew: false, retry: false })),
    ...menu.news.map((id) => ({ id, isNew: true, retry: false })),
  ].filter((it) => wordsById.has(it.id));

  let index = 0;          // いま出している queue の位置
  let answered = 0;       // この回に答えた数（もう一度の分を含む）
  let correctCount = 0;
  const missed = [];      // この回にまちがえた語の id（重複なし）
  let saveFailed = false;
  let renderToken = 0;    // 画面を描き直したら増やす（古い非同期処理を捨てるため）
  let preparedFile = null;
  let noticeEl = null;

  // ---- 音声 ----

  /** 例文の音声を用意する（表示した時点で呼ぶ）。用意できたら true */
  async function loadAudio(file, token) {
    if (file === preparedFile) return true;
    try {
      const blob = await getAudioBlob(file);
      if (token !== renderToken) return false; // もう別の画面になっている
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
      // await をはさまずに呼ぶ（iPhone で再生を止められないように）
      playSegment(seg[0], seg[1]).catch(() => showNotice(MSG_PLAY_FAILED));
    });
    return btn;
  }

  /** 「単語の発音」ボタン（speechSynthesis が使えない端末では出さない） */
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
    const ok = window.confirm('今日の学習を中断して、ホームに戻りますか？\n（ここまでに答えた分は保存されています）');
    if (ok) quit();
  }

  /** 新しい画面を描き始める（古い音声・発音を止める） */
  function beginScreen() {
    renderToken += 1;
    stop();
    cancelSpeech();
  }

  /** 上部（何問目か・進捗・中断ボタン）＋本体＋下寄せのボタン */
  function mount(body, bottom, { showHead = true } = {}) {
    const total = queue.length;
    const pos = Math.min(index + 1, total);
    const pct = total ? Math.round((index / total) * 100) : 0;
    noticeEl = el('p', { class: 'error', role: 'alert', hidden: true });
    if (saveFailed) { noticeEl.textContent = MSG_SAVE_FAILED; noticeEl.hidden = false; }
    const head = !showHead ? null : el('div', { class: 'study-head' },
      el('span', { class: 'study-count', text: `${pos} / ${total}` }),
      el('div', {
        class: 'progress study-progress', role: 'progressbar',
        'aria-label': '今日のメニューの進み具合', 'aria-valuemin': 0, 'aria-valuemax': total, 'aria-valuenow': index,
      }, el('div', { class: 'progress-bar', style: `width:${pct}%` })),
      el('button', { type: 'button', class: 'btn btn-quit', onclick: onQuitClick }, '中断'),
    );
    root.replaceChildren(el('div', { class: 'study' },
      head,
      noticeEl,
      el('div', { class: 'study-body' }, body),
      el('div', { class: 'study-bottom' }, bottom),
    ));
    window.scrollTo(0, 0);
  }

  // ---- 進行 ----

  function next() {
    if (index >= queue.length) { renderEnd(); return; }
    const item = queue[index];
    if (item.isNew && !item.retry) renderMeet(item);
    else renderQuestion(item);
  }

  function goNext() {
    index += 1;
    next();
  }

  /** 答えを記録する */
  function record(item, correct) {
    const rec = applyAnswer(progress[item.id], correct, today);
    progress[item.id] = rec;
    try {
      saveRecord(item.id, rec);
      logAnswer(today, { correct, isNew: item.isNew && !item.retry });
    } catch (e) {
      console.warn(e);
      if (!saveFailed) { saveFailed = true; showNotice(MSG_SAVE_FAILED); }
    }
    answered += 1;
    if (correct) correctCount += 1;
    if (!correct) {
      if (!item.retry) queue.push({ id: item.id, isNew: item.isNew, retry: true });
      if (!missed.includes(item.id)) missed.push(item.id);
    }
  }

  // ---- 新しい語との「出会う」カード ----

  function renderMeet(item) {
    beginScreen();
    const word = wordsById.get(item.id);
    const sentence = sentenceOf(word);
    const body = [
      el('p', { class: 'kicker', text: '新しい語' }),
      el('div', { class: 'card' },
        headword(word),
        boldSentence(sentence, word),
        buttonRow(listenButton(sentence, { primary: true }), speakButton(word)),
        jaSentence(sentence),
        el('dl', { class: 'meaning-box' },
          el('dt', { text: 'この例文での意味' }),
          el('dd', { class: 'meaning', text: word.meaning || '-' }),
        ),
      ),
    ];
    const bottom = el('button', {
      type: 'button', class: 'btn btn-primary btn-next', onclick: () => renderQuestion(item),
    }, '覚えた、問題へ');
    mount(body, bottom);
  }

  // ---- 問題 ----

  function makeQ(word, sentence) {
    const rec = progress[word.id];
    const box = rec && Number.isInteger(rec.box) ? rec.box : 0;
    let q = null;
    if (sentence) q = safe(() => makeQuestion(word, sentence, words, box), null);
    if (!q) q = safe(() => makeChoice(word, words), null); // 例文が無い・作れないときは意味 4 択
    return q;
  }

  function renderQuestion(item) {
    const word = wordsById.get(item.id);
    const sentence = sentenceOf(word);
    const q = makeQ(word, sentence);
    if (!q) {
      // 問題が作れない語（データの不備）は飛ばす
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

  /** 4 つの選択肢ボタン。押したら onAnswer(correct) */
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

  /** 答えた後：本体を「答え合わせ」に差し替え、下に「次へ」を足す */
  function showFeedback(item, word, sentence, correct, { answerText = '', extraBottom = null } = {}) {
    const study = root.querySelector('.study');
    const bodyEl = study.querySelector('.study-body');
    const bottomEl = study.querySelector('.study-bottom');
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
      !correct && !item.retry ? el('p', { class: 'muted small', text: 'この語は、最後にもう一度出します。' }) : null,
    );
    bodyEl.replaceChildren(card);
    if (extraBottom) bottomEl.replaceChildren(extraBottom);
    // 不正解の語を最後に足したときは、上部の「何問目 / 全体」の全体も増やす
    const countEl = study.querySelector('.study-count');
    if (countEl) countEl.textContent = `${Math.min(index + 1, queue.length)} / ${queue.length}`;
    const isLast = index + 1 >= queue.length;
    const nextBtn = el('button', { type: 'button', class: 'btn btn-primary btn-next', onclick: goNext },
      isLast ? '結果を見る' : '次へ');
    bottomEl.append(nextBtn);
    window.scrollTo(0, 0);
    nextBtn.focus({ preventScroll: true });
  }

  // 意味 4 択（箱 0〜1）
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

  // リスニング穴埋め（箱 2〜3）
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

  // スペル入力（箱 4〜5）
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
    const days = safe(() => streak(today), 0) || 0;
    const log = safe(() => dayLog(today), null);
    const goal = settings.dailyGoal;
    const body = [];
    if (answered === 0) {
      body.push(el('div', { class: 'card' },
        el('h2', { text: '今日の分は終わっています' }),
        el('p', { text: '期限が来た復習も、新しい語もありません。また明日やりましょう。' }),
        el('p', { class: 'streak-line' }, '連続学習 ', el('strong', { text: String(days) }), ' 日'),
      ));
    } else {
      body.push(el('div', { class: 'card' },
        el('h2', { text: '今日の学習が終わりました' }),
        el('p', { class: 'score' },
          el('strong', { class: 'score-num', text: String(correctCount) }),
          ` / ${answered} 問 正解`,
        ),
        el('p', { class: 'streak-line' }, '連続学習 ', el('strong', { text: String(days) }), ' 日'),
        log && goal ? el('p', { class: 'muted', text: `今日の合計 ${log.answered} 問（目標 ${goal} 問）` }) : null,
      ));
      if (missed.length) {
        body.push(el('div', { class: 'card' },
          el('h3', { text: 'まちがえた語' }),
          el('ul', { class: 'missed-list' }, missed.map((id) => {
            const w = wordsById.get(id);
            return el('li', {},
              el('span', { lang: 'en', class: 'missed-word', text: w.word || '' }),
              el('span', { class: 'muted', text: w.meaning || '' }),
            );
          })),
        ));
      }
    }
    const bottom = el('button', { type: 'button', class: 'btn btn-primary btn-next', onclick: quit }, 'ホームに戻る');
    mount(body, bottom, { showHead: false });
  }

  next();
}
