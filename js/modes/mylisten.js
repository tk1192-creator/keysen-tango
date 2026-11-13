// 聞き流し（マイリスニング）の画面：設定画面と再生画面
//
// 使い方：startMyListen(root, ctx, { startWordId?, autoResume? })
//   root … 描画先の要素（この中だけに描く）
//   ctx  … js/MODES.md のとおり（words, sentencesById, getAudioBlob, onExit）
//   startWordId … その語から再生する（設定画面を出さず「▶ ここから再生」だけの画面を出す）
//   autoResume  … 前回の語（kk.mylisten.v1 の last）から同じように再生する
//
// 再生の仕組みは js/player.js（取り決めは js/PLAYER.md）。この画面は drivers（音を出す部分）と表示を受け持つ。
//
// この画面で決めたこと：
// - player.js と audio.js は startMyListen の中で動的 import する（node のテストで、このファイルの
//   画面に依存しない関数を読めるように。audio.js は読み込むと Audio 要素を作るため）。
// - drivers：
//   - speak：speechSynthesis。onend で解決、onerror で reject。iOS で onend が来ないことがあるので、
//     speakTimeoutMs（文字数×0.25 秒＋2 秒を rate で割る）で打ち切って解決する。声（voice）は lang に合うものを選び、
//     無ければ lang だけ指定して読ませる（止めない）。"..." や "～" は読まない。speechSynthesis が無ければすぐ解決。
//   - playSegment：audio.js の prepare / playSegment。終わり（onFinish）で解決、音声が無い・再生できなければ reject
//     （player が英語 TTS に切り替える）。区間の前後に SEG_PAD 秒の余白。速さは audio.setRate。
//     画面が消えて終了秒の見張りが止まったとき用に、区間の長さ÷速さ＋FALLBACK_MARGIN 秒の予備タイマーで解決する。
//     Blob は ctx.getAudioBlob で取り、次の語の分を前もって読む（手元には今・次・用意済みの 3 つだけ置く）。
//     audio.prepare は今の音を止めるので、次の語の分は Blob を取るだけで、prepare は再生する直前にする。
//   - wait：setTimeout。
//   - cancel：音・TTS・待ちを止め、待っている Promise はすべて解決する（古い分は player が世代番号で捨てる）。
// - iPhone 対策：「▶ 再生を始める」「▶ ここから再生」のタップの処理の中で、await をはさまずに
//   player.load（中で drivers.cancel が呼ばれる）→ ① 音量 0 の空の読み上げ（TTS の解錠）
//   ② 用意しておいた mp3 を 0 秒〜0 秒だけ再生（Audio 要素の解錠）→ player.play を呼ぶ。
//   最初に流す語の mp3 は画面を出した時点で prepare しておく。
// - 再生リストは player の状態（getState().playlist。シャッフル後の実際の順）を正とし、先読みと移動の判断に使う。
// - Wake Lock：再生中だけ navigator.wakeLock.request('screen')。一時停止・やめる・終了で解放。
//   画面が非表示から戻ったとき、再生中なら取り直す。使えない環境では何もしない。
// - 番号入力：「125」「No.125」（全角も可）。範囲外は近い端の番号へ移り、そのことを知らせる。
//   今の再生範囲に無い番号へ移るときは、範囲をその番号の Section に変えて（保存して）その番号から再生する。
// - 単語リストの見出しタップ＝今の範囲のまま、その Section の先頭へ（範囲に無ければ Section に変える）。
//   メニュー「この Section の最初から再生」＝範囲をその Section にして先頭から。
// - 仕分け（覚えた／まだ）は 1 タップで記録。押してある方をもう一度押すと取り消す。
// - 最後に再生した語は、語が変わるたびに kk.mylisten.v1.last に保存する。学習記録（kk.progress.v1）は変えない。

import { findForm } from '../quiz.js';
import { openListSheet, sectionOfNo } from './mylisten-list.js';

export const RATE_CHOICES = Object.freeze([0.75, 1, 1.25, 1.5]);
export const GAP_CHOICES = Object.freeze([0, 0.5, 1, 1.5, 2, 3, 5]);
export const REPEAT_LABELS = Object.freeze({ off: 'オフ', one: '1単語', range: '範囲' });
export const SEG_PAD = 0.1;          // 区間の前後の余白（秒）
export const FALLBACK_MARGIN = 1.0;  // 予備タイマーを区間の長さより何秒遅らせるか
const MSG_NO_DATA = '単語がありません。データパックを確認してください。';

// ---------- DOM を使わない部分（テスト対象） ----------

/** 読み上げる文字列（"..." "…" "～" "〜" "~" は読まない） */
export function cleanSpeechText(text) {
  return String(text == null ? '' : text)
    .replace(/\.{2,}|…|～|〜|~/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 読み上げの打ち切り時間（ミリ秒）：（文字数×0.25 秒＋2 秒）÷ rate */
export function speakTimeoutMs(text, rate = 1) {
  const r = Number(rate) > 0 ? Number(rate) : 1;
  const len = String(text == null ? '' : text).length;
  return Math.round(((len * 0.25 + 2) / r) * 1000);
}

/** lang に合う声を選ぶ（完全一致 → 言語だけ一致。'_' と '-' の違いは無視）。無ければ null */
export function pickVoice(voices, lang) {
  const list = Array.isArray(voices) ? voices.filter(Boolean) : [];
  const norm = (s) => String(s || '').replace(/_/g, '-').toLowerCase();
  const want = norm(lang);
  if (!want) return null;
  const base = want.split('-')[0];
  const exact = list.filter((v) => norm(v.lang) === want);
  const pickLocal = (arr) => arr.find((v) => v.localService) || arr[0] || null;
  if (exact.length) return pickLocal(exact);
  return pickLocal(list.filter((v) => norm(v.lang).split('-')[0] === base));
}

/**
 * 番号入力を読む。「125」「No.125」「no 125」（全角も可）
 * @returns {{ no: number, message: string } | { error: string }}
 *   範囲外のときは近い端の番号と、そのことを知らせる message
 */
export function parseNoInput(text, total) {
  if (!Number.isInteger(total) || total < 1) return { error: '単語がありません。' };
  const t = String(text == null ? '' : text).normalize('NFKC').trim().toLowerCase();
  if (!t) return { error: '番号を入れてください。' };
  const m = /^(?:no\.?\s*)?(-?\d+)$/.exec(t);
  if (!m) return { error: `番号は数字で入れてください（1〜${total}）。` };
  const n = Number(m[1]);
  if (n < 1) return { no: 1, message: `No.${n} はありません。No.1 へ移ります（1〜${total}）。` };
  if (n > total) return { no: total, message: `No.${n} はありません。いちばん後ろの No.${total} へ移ります。` };
  return { no: n, message: '' };
}

/** 長い語を短くする（ボタンに入れるため） */
export function shorten(text, max = 18) {
  const s = String(text == null ? '' : text);
  const chars = [...s];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : s;
}

/**
 * 前回の位置の表示
 * @param {{wordId}} last kk.mylisten.v1 の last
 * @param {Array<{no, word}>} numbered player.numberWords の結果
 * @returns {{ no, wordId, word, label } | null}  語が見つからなければ null
 */
export function formatResumeLabel(last, numbered) {
  if (!last || typeof last !== 'object' || last.wordId == null) return null;
  const id = String(last.wordId);
  const hit = (Array.isArray(numbered) ? numbered : []).find((x) => x && x.word && String(x.word.id) === id);
  if (!hit) return null;
  const w = shorten(hit.word.word || '');
  return { no: hit.no, wordId: hit.word.id, word: hit.word.word || '', label: `続きから再生（No.${hit.no} ${w} から）` };
}

/** 上部の「Section 3 ／ 12 / 50」。pos は Section の中の何語目、size はその Section の語数 */
export function progressInfo(no, sectionSize, total) {
  const size = Math.max(1, Math.trunc(Number(sectionSize)) || 1);
  if (!Number.isInteger(no) || no < 1) return { section: 0, pos: 0, size: 0, text: '' };
  const section = sectionOfNo(no, size);
  const from = (section - 1) * size + 1;
  const to = Number.isInteger(total) && total > 0 ? Math.min(section * size, total) : section * size;
  const pos = no - from + 1;
  const count = Math.max(1, to - from + 1);
  return { section, pos, size: count, text: `Section ${section} ／ ${pos} / ${count}` };
}

/**
 * ある No. へ移るときのやり方
 * @param {number} no
 * @param {Iterable<number>} playlist 今の再生リスト（No. の並び）
 * @returns {{ kind: 'jump' } | { kind: 'reload', range: { kind: 'section', section } }}
 */
export function planJump(no, playlist, sectionSize) {
  const set = playlist instanceof Set ? playlist : new Set(playlist || []);
  if (set.has(no)) return { kind: 'jump' };
  return { kind: 'reload', range: { kind: 'section', section: sectionOfNo(no, sectionSize) } };
}

/** 次に流れそうな No.（音声を前もって読むため）。無ければ null */
export function nextPreloadNo(playlist, no, repeat = 'off') {
  const list = Array.isArray(playlist) ? playlist : [];
  if (repeat === 'one') return null;
  const i = list.indexOf(no);
  if (i < 0) return list[0] ?? null;
  if (i + 1 < list.length) return list[i + 1];
  return repeat === 'range' ? (list[0] ?? null) : null;
}

/** 仕分けを付ける（同じものをもう一度押したら外す）。新しいオブジェクトを返す */
export function setMark(marks, wordId, value) {
  const out = { ...(marks && typeof marks === 'object' ? marks : {}) };
  const key = String(wordId);
  if (value !== 'known' && value !== 'notyet') { delete out[key]; return out; }
  if (out[key] === value) delete out[key];
  else out[key] = value;
  return out;
}

/** 範囲の説明 */
export function describeRange(range, sectionSize, total) {
  const r = range && typeof range === 'object' ? range : { kind: 'all' };
  const size = Math.max(1, Math.trunc(Number(sectionSize)) || 1);
  if (r.kind === 'section') {
    const from = (r.section - 1) * size + 1;
    const to = Math.min(r.section * size, total || r.section * size);
    return `Section ${r.section}（No.${from}〜${to}）`;
  }
  if (r.kind === 'nos') return `No.${r.from}〜${r.to}`;
  if (r.kind === 'notyet') return '「まだ」の語だけ';
  return `全体（No.1〜${total}）`;
}

/** 間隔の選択肢（今の値が一覧に無ければ足す） */
export function gapOptions(current) {
  const c = Number(current);
  const list = [...GAP_CHOICES];
  if (Number.isFinite(c) && !list.includes(c)) list.push(c);
  return list.sort((a, b) => a - b);
}

// ---------- 画面の部品 ----------

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

function safe(fn, fallback) {
  try { return fn(); } catch (e) { console.warn(e); return fallback; }
}

function canSpeak() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance === 'function';
}

/** 速さの表示（1 → "1.0"、0.75 → "0.75"、1.5 → "1.5"） */
export function rateText(r) {
  const n = Number(r);
  if (!Number.isFinite(n)) return '1.0';
  return Number.isInteger(n) ? n.toFixed(1) : String(n);
}

// ---------- 画面本体 ----------

export async function startMyListen(root, ctx, opts = {}) {
  const { words = [], sentencesById, getAudioBlob, onExit } = ctx || {};
  const [audio, P] = await Promise.all([import('../audio.js'), import('../player.js')]);
  const { startWordId = null, autoResume = false } = opts || {};

  const getSentence = (id) => {
    if (id == null || !sentencesById) return undefined;
    return sentencesById instanceof Map ? sentencesById.get(id) : sentencesById[id];
  };

  // ---- 単語の並びと再生に渡す items ----
  const numbered = P.numberWords(Array.isArray(words) ? words : []);
  const total = numbered.length;
  const items = new Map();
  const noById = new Map();
  for (const x of numbered) {
    const sid = Array.isArray(x.word.sentenceIds) ? x.word.sentenceIds[0] : undefined;
    items.set(x.no, { word: x.word, sentence: getSentence(sid) });
    noById.set(String(x.word.id), x.no);
  }

  // ---- 保存（kk.mylisten.v1） ----
  const store = safe(() => P.loadMyListen(), null) || {};
  let settings = P.normalizeSettings(store.settings || {});
  let marks = store.marks && typeof store.marks === 'object' ? { ...store.marks } : {};
  let last = store.last || null;
  const lastNoAtOpen = last && noById.has(String(last.wordId)) ? noById.get(String(last.wordId)) : null;
  let canSave = true;

  function persist() {
    const ok = safe(() => P.saveMyListen({ version: 1, settings, marks, last }), false);
    canSave = ok !== false;
  }

  const presetOf = () => P.PRESETS.find((p) => p.id === settings.presetId) || P.PRESETS[0];

  // ======================================================
  // drivers（音を出す部分）
  // ======================================================
  const blobCache = new Map();  // file → Blob
  const loading = new Map();    // file → Promise<Blob|null>
  let preparedFile = null;
  const pendings = new Set();   // 待っている Promise（cancel で解決する）
  const utterances = new Set(); // 読み上げ中の発話（途中で消されて onend が来なくなるのを防ぐため持っておく）

  function fetchBlob(file) {
    if (!file || typeof getAudioBlob !== 'function') return Promise.resolve(null);
    if (blobCache.has(file)) return Promise.resolve(blobCache.get(file));
    if (loading.has(file)) return loading.get(file);
    const p = Promise.resolve()
      .then(() => getAudioBlob(file))
      .then((b) => { loading.delete(file); if (b) blobCache.set(file, b); return b || null; },
        (e) => { loading.delete(file); console.warn(e); return null; });
    loading.set(file, p);
    return p;
  }

  function keepOnly(files) {
    for (const k of [...blobCache.keys()]) if (!files.includes(k)) blobCache.delete(k);
  }

  /** 手元に Blob があれば、その場で prepare。できたら true */
  function prepareNow(file) {
    if (file && file === preparedFile) return true;
    const blob = blobCache.get(file);
    if (!blob) return false;
    audio.prepare(file, blob);
    preparedFile = file;
    return true;
  }

  /** 待ちを 1 つ作る。settle(fn) は 1 回だけ効く。cancel では解決される */
  function makePending(resolve) {
    const entry = { done: false, timer: 0 };
    entry.settle = (fn) => {
      if (entry.done) return;
      entry.done = true;
      if (entry.timer) clearTimeout(entry.timer);
      pendings.delete(entry);
      fn();
    };
    entry.cancel = () => entry.settle(resolve);
    pendings.add(entry);
    return entry;
  }

  let voicesCache = [];
  function voices() {
    if (!canSpeak()) return [];
    const v = safe(() => speechSynthesis.getVoices(), []) || [];
    if (v.length) voicesCache = v;
    return voicesCache;
  }
  if (canSpeak()) {
    voices();
    try { speechSynthesis.addEventListener('voiceschanged', voices); } catch { /* 古い環境 */ }
  }

  const drivers = {
    speak(text, lang, rate = 1) {
      return new Promise((resolve, reject) => {
        const t = cleanSpeechText(text);
        if (!t || !canSpeak()) { resolve(); return; }
        const entry = makePending(resolve);
        const u = new SpeechSynthesisUtterance(t);
        u.lang = lang || 'en-US';
        const v = pickVoice(voices(), u.lang);
        if (v) u.voice = v;
        const r = Number(rate) > 0 ? Number(rate) : 1;
        u.rate = Math.min(2, Math.max(0.5, r));
        const done = (fn) => { utterances.delete(u); entry.settle(fn); };
        u.onend = () => done(resolve);
        u.onerror = (ev) => done(() => reject(new Error(`読み上げに失敗しました（${(ev && ev.error) || '不明'}）`)));
        utterances.add(u);
        // iOS で onend が来ないことがあるので、上限の時間で打ち切る
        entry.timer = setTimeout(() => {
          if (entry.done) return;
          done(resolve);
          try { speechSynthesis.cancel(); } catch { /* 無視 */ }
        }, speakTimeoutMs(t, r));
        try {
          if (speechSynthesis.paused) speechSynthesis.resume();
          speechSynthesis.speak(u);
        } catch (e) {
          done(() => reject(e));
        }
      });
    },

    playSegment(file, start, end, rate = 1) {
      return new Promise((resolve, reject) => {
        const entry = makePending(resolve);
        const s = Math.max(0, Number(start) - SEG_PAD);
        const e = Number(end) + SEG_PAD;
        if (!file || !Number.isFinite(s) || !Number.isFinite(e) || e <= s) {
          entry.settle(() => reject(new Error('音声の区間がありません')));
          return;
        }
        const r = Number(rate) > 0 ? Number(rate) : 1;
        const run = () => {
          if (entry.done) return;
          audio.setRate(r);
          let p;
          try {
            p = audio.playSegment(s, e, { onFinish: () => entry.settle(resolve) });
          } catch (err) {
            entry.settle(() => reject(err));
            return;
          }
          Promise.resolve(p).then(() => {
            if (entry.done) { return; }
            // 画面が消えて終了秒の見張りが止まっても進めるための予備
            entry.timer = setTimeout(() => {
              if (entry.done) return;
              audio.stop();
              entry.settle(resolve);
            }, ((e - s) / r + FALLBACK_MARGIN) * 1000);
          }, (err) => entry.settle(() => reject(err)));
        };
        if (prepareNow(file)) { run(); return; }
        fetchBlob(file).then((blob) => {
          if (entry.done) return;
          if (!blob) { entry.settle(() => reject(new Error(`音声が見つかりません（${file}）`))); return; }
          prepareNow(file);
          run();
        });
      });
    },

    wait(ms) {
      return new Promise((resolve) => {
        const entry = makePending(resolve);
        entry.timer = setTimeout(() => entry.settle(resolve), Math.max(0, Number(ms) || 0));
      });
    },

    cancel() {
      // 先に待ちを解決してから止める（止めたことで来る onerror などは無視される）
      for (const entry of [...pendings]) entry.cancel();
      utterances.clear();
      audio.stop();
      if (canSpeak()) { try { speechSynthesis.cancel(); } catch { /* 無視 */ } }
    },
  };

  /** iPhone：タップの処理の中で TTS と Audio 要素を使えるようにする */
  function unlockMedia() {
    if (canSpeak()) {
      try {
        const u = new SpeechSynthesisUtterance(' ');
        u.volume = 0;
        speechSynthesis.speak(u);
      } catch { /* 無視 */ }
    }
    if (preparedFile) {
      try {
        const p = audio.playSegment(0, 0);
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch { /* 無視 */ }
    }
  }

  // ======================================================
  // Wake Lock
  // ======================================================
  let wakeLock = null;
  let wakeRequesting = false;
  let wantWake = false;

  async function acquireWake() {
    wantWake = true;
    if (wakeLock || wakeRequesting || typeof navigator === 'undefined' || !navigator.wakeLock || typeof navigator.wakeLock.request !== 'function') return;
    if (document.visibilityState !== 'visible') return;
    wakeRequesting = true;
    try {
      const lock = await navigator.wakeLock.request('screen');
      wakeRequesting = false;
      if (!wantWake || !alive) { lock.release().catch(() => {}); return; }
      wakeLock = lock;
      lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; });
    } catch {
      // 使えない・断られた：何もしない
      wakeRequesting = false;
    }
  }

  function releaseWake() {
    wantWake = false;
    if (wakeLock) {
      const lock = wakeLock;
      wakeLock = null;
      lock.release().catch(() => {});
    }
  }

  function onVisibility() {
    if (document.visibilityState === 'visible' && wantWake) acquireWake();
  }
  document.addEventListener('visibilitychange', onVisibility);

  // ======================================================
  // 再生（player）
  // ======================================================
  let alive = true;
  let playlist = [];         // 今の再生リスト（No.）
  let playlistSet = new Set();
  let ui = null;             // 再生画面の要素
  let sheet = null;          // 単語リスト
  let shownNo = null;        // 最後に表示した語の No.
  let lastState = null;

  const player = P.createPlayer({ drivers, onState });

  function onState(state) {
    if (!alive || !state) return;
    lastState = state;
    if (Array.isArray(state.playlist) && (state.playlist.length !== playlist.length || state.playlist[0] !== playlist[0]
      || state.playlist[state.playlist.length - 1] !== playlist[playlist.length - 1])) {
      playlist = state.playlist;
      playlistSet = new Set(playlist);
    }
    if (state.status === 'playing') acquireWake(); else releaseWake();
    if (state.no != null && state.no !== shownNo) {
      shownNo = state.no;
      const it = items.get(state.no);
      if (it) {
        last = { wordId: String(it.word.id), no: state.no, at: new Date().toISOString() };
        persist();
      }
      preloadAround(state.no);
      if (sheet) sheet.update({ currentNo: state.no });
    }
    paintPlayer();
  }

  function preloadAround(no) {
    const cur = items.get(no);
    const nx = items.get(nextPreloadNo(playlist, no, settings.repeat));
    const curFile = cur && cur.sentence ? cur.sentence.file : null;
    const nxFile = nx && nx.sentence ? nx.sentence.file : null;
    keepOnly([curFile, nxFile, preparedFile].filter(Boolean));
    if (curFile) fetchBlob(curFile);
    if (nxFile) fetchBlob(nxFile);
  }

  function ensurePlaying() {
    const st = safe(() => player.getState(), null);
    if (!st || st.status === 'playing') return;
    if (st.status === 'paused') player.resume(); else player.play();
  }

  /** 再生リストを作り直して、startNo から再生する（タップの処理の中から呼ぶ） */
  function loadAndPlay(startNo) {
    const list = P.buildPlaylist(numbered, settings, marks, { startNo, rng: Math.random });
    if (!list.length) return false;
    playlist = list;
    playlistSet = new Set(list);
    shownNo = null;
    player.load(playlist, items, presetOf(), settings); // 今の再生は load の中で止まる
    player.play();
    return true;
  }

  /** No. へ移る（範囲に無ければ、その Section に範囲を変える） */
  function goToNo(no, message = '') {
    const plan = planJump(no, playlistSet, settings.sectionSize);
    if (plan.kind === 'jump' && player.jumpTo(no) !== false) {
      ensurePlaying();
      showNotice(message);
      return;
    }
    if (plan.kind === 'jump') plan.range = { kind: 'section', section: sectionOfNo(no, settings.sectionSize) };
    settings = P.normalizeSettings({ ...settings, range: plan.range });
    persist();
    const ok = loadAndPlay(no);
    showNotice([message, ok ? `今の範囲に無いので、範囲を Section ${plan.range.section} に変えました。` : '再生できる語がありません。']
      .filter(Boolean).join(' '));
  }

  function playSection(section) {
    settings = P.normalizeSettings({ ...settings, range: { kind: 'section', section } });
    persist();
    const r = P.sectionRange(section, settings.sectionSize, total);
    if (!loadAndPlay(r.from)) showNotice('再生できる語がありません。');
    else showNotice(`範囲を Section ${section} にしました。`);
  }

  function jumpSection(section) {
    const r = P.sectionRange(section, settings.sectionSize, total);
    const inRange = playlist.filter((no) => no >= r.from && no <= r.to);
    if (inRange.length) goToNo(Math.min(...inRange));
    else playSection(section);
  }

  function repeatOne(no) {
    if (settings.repeat !== 'one') {
      settings = { ...settings, repeat: 'one' };
      player.setRepeat('one');
      persist();
    }
    goToNo(no);
  }

  function quit() {
    if (!alive) return;
    if (sheet) sheet.close();
    safe(() => player.pause(), null);
    drivers.cancel();
    releaseWake();
    alive = false;
    persist();
    document.removeEventListener('visibilitychange', onVisibility);
    if (canSpeak()) { try { speechSynthesis.removeEventListener('voiceschanged', voices); } catch { /* 無視 */ } }
    if (typeof onExit === 'function') onExit();
  }

  function showNotice(msg) {
    if (!ui) return;
    ui.notice.textContent = msg || '';
    ui.notice.hidden = !msg;
  }

  // ======================================================
  // 最初の音声の用意（ボタンを押す前に prepare しておく）
  // ======================================================
  let prepToken = 0;

  /** 再生リストの先頭のほうで、例文の音声がある語の mp3 を prepare する。終わったら解決 */
  function prepareFirst(list) {
    const tok = ++prepToken;
    const firstWithAudio = list.slice(0, 20).map((no) => items.get(no)).find((it) => it && it.sentence && it.sentence.file);
    if (!firstWithAudio) return Promise.resolve();
    const file = firstWithAudio.sentence.file;
    if (prepareNow(file)) return Promise.resolve();
    return fetchBlob(file).then((blob) => {
      if (tok !== prepToken || !blob) return;
      keepOnly([file]);
      prepareNow(file);
    });
  }

  /** 開始ボタン（押せるのは音声の用意が済んでから） */
  function startButton(label, getList, onStart) {
    const btn = el('button', { type: 'button', class: 'btn btn-primary ml-start', disabled: true }, '音声を準備中…');
    let list = [];
    const refresh = () => {
      list = getList();
      if (!list.length) {
        btn.disabled = true;
        btn.textContent = '再生できる語がありません';
        return;
      }
      btn.disabled = true;
      btn.textContent = '音声を準備中…';
      const tok = prepToken + 1;
      prepareFirst(list).then(() => {
        if (tok !== prepToken) return;
        btn.disabled = false;
        btn.textContent = label;
      });
    };
    btn.addEventListener('click', () => {
      if (!list.length) return;
      // ここから await をはさまずに再生を始める（iPhone 対策。解錠は beginWith の中）
      onStart(list);
    });
    return { btn, refresh };
  }

  /** 用意した再生リストで始める（タップの処理の中から） */
  function beginWith(list) {
    lastState = null;
    playlist = list;
    playlistSet = new Set(list);
    shownNo = null;
    renderPlayer();
    player.load(playlist, items, presetOf(), settings);
    unlockMedia(); // load の cancel より後、play より前
    player.play();
  }

  // ======================================================
  // 設定画面
  // ======================================================

  function radioGroup(name, legend, options, current, onChange, cls = 'choice-row') {
    return el('fieldset', { class: 'choice-group' },
      el('legend', { class: 'field-label', text: legend }),
      el('div', { class: cls },
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

  function selectField(id, label, options, current, onChange) {
    const sel = el('select', { class: 'select', id }, options.map(([v, t]) => new Option(t, String(v))));
    sel.value = String(current);
    sel.addEventListener('change', () => onChange(sel.value));
    return el('div', { class: 'ml-field' }, el('label', { class: 'field-label', for: id, text: label }), sel);
  }

  function checkRow(label, checked, onChange) {
    const input = el('input', { type: 'checkbox', checked });
    input.addEventListener('change', () => onChange(input.checked));
    return el('label', { class: 'check-row' }, input, el('span', { text: label }));
  }

  function renderSetup(message = '') {
    if (sheet) sheet.close();
    safe(() => player.pause(), null);
    drivers.cancel();
    releaseWake();
    ui = null;

    if (!total) {
      root.replaceChildren(el('div', { class: 'study mylisten' },
        el('div', { class: 'study-body' },
          el('p', { class: 'kicker', text: '聞き流し' }),
          el('div', { class: 'card' }, el('p', { text: MSG_NO_DATA }))),
        el('div', { class: 'study-bottom' }, el('button', { type: 'button', class: 'btn', onclick: quit }, 'ホームに戻る'))));
      return;
    }

    const sectionCount = () => Math.max(1, Math.ceil(total / settings.sectionSize));
    const range = () => settings.range || { kind: 'all' };
    const setRange = (r) => { settings = P.normalizeSettings({ ...settings, range: r }); };

    // パターン
    const presetGroup = radioGroup('ml-preset', 'パターン', P.PRESETS.map((p) => [p.id, p.name]), settings.presetId,
      (v) => { settings = P.normalizeSettings({ ...settings, presetId: v }); changed(); }, 'choice-row choice-row-2');

    // 範囲
    const sectionBox = el('div', {});
    const nosBox = el('div', {});
    const notyetNote = el('p', { class: 'muted small' });

    function paintSectionBox() {
      const r = range();
      const cur = r.kind === 'section' ? r.section : 1;
      const opts = [];
      for (let s = 1; s <= sectionCount(); s++) {
        const sr = P.sectionRange(s, settings.sectionSize, total);
        opts.push([s, `Section ${s}（No.${sr.from}〜${sr.to}）`]);
      }
      sectionBox.replaceChildren(selectField('ml-section', 'Section', opts, Math.min(cur, sectionCount()),
        (v) => { setRange({ kind: 'section', section: Number(v) }); changed(); }));
    }

    function paintNosBox() {
      const r = range();
      const numInput = (id, value) => el('input', {
        type: 'number', id, class: 'num-input', inputmode: 'numeric', min: 1, max: total, step: 1, value,
      });
      const fromInput = numInput('ml-from', r.kind === 'nos' ? r.from : 1);
      const toInput = numInput('ml-to', r.kind === 'nos' ? r.to : Math.min(total, settings.sectionSize));
      const onChange = () => {
        let f = Math.trunc(Number(fromInput.value)) || 1;
        let t = Math.trunc(Number(toInput.value)) || total;
        f = Math.min(Math.max(f, 1), total);
        t = Math.min(Math.max(t, 1), total);
        if (f > t) [f, t] = [t, f];
        fromInput.value = String(f);
        toInput.value = String(t);
        setRange({ kind: 'nos', from: f, to: t });
        changed();
      };
      fromInput.addEventListener('change', onChange);
      toInput.addEventListener('change', onChange);
      nosBox.replaceChildren(
        el('p', { class: 'field-label', text: `番号の範囲（1〜${total}）` }),
        el('div', { class: 'range-row' },
          fromInput, el('label', { for: 'ml-from', text: 'から' }),
          toInput, el('label', { for: 'ml-to', text: 'まで' })));
    }

    function showRangeKind() {
      const k = range().kind;
      sectionBox.hidden = k !== 'section';
      nosBox.hidden = k !== 'nos';
      const n = numbered.filter((x) => marks[x.word.id] === 'notyet').length;
      notyetNote.hidden = k !== 'notyet';
      notyetNote.textContent = n ? `「まだ」にした語：${n} 語` : 'まだ「まだ」にした語はありません。再生画面で「まだ」を押すと、ここで選べます。';
    }

    const rangeGroup = radioGroup('ml-range', '範囲',
      [['all', '全体'], ['section', 'Section'], ['nos', '番号の範囲'], ['notyet', '「まだ」だけ']], range().kind,
      (k) => {
        if (k === 'section') setRange({ kind: 'section', section: 1 });
        else if (k === 'nos') setRange({ kind: 'nos', from: 1, to: Math.min(total, settings.sectionSize) });
        else setRange({ kind: k });
        paintSectionBox();
        paintNosBox();
        showRangeKind();
        changed();
      }, 'choice-row choice-row-2');

    const sizeField = selectField('ml-section-size', 'Section の大きさ', P.SECTION_SIZES.map((n) => [n, `${n} 語`]), settings.sectionSize,
      (v) => {
        const r = range();
        settings = P.normalizeSettings({ ...settings, sectionSize: Number(v) });
        if (r.kind === 'section') setRange({ kind: 'section', section: Math.min(r.section, sectionCount()) });
        paintSectionBox();
        changed();
      });

    // 間隔・読み上げ・速度
    const gapThinkField = selectField('ml-gap-think', '考える間', gapOptions(settings.gapThink).map((g) => [g, `${g} 秒`]), settings.gapThink,
      (v) => { settings = P.normalizeSettings({ ...settings, gapThink: Number(v) }); changed(); });
    const gapNextField = selectField('ml-gap-next', '次の語までの間', gapOptions(settings.gapNext).map((g) => [g, `${g} 秒`]), settings.gapNext,
      (v) => { settings = P.normalizeSettings({ ...settings, gapNext: Number(v) }); changed(); });
    const speakJaRow = checkRow('日本語の意味を読み上げる', settings.speakJa === true,
      (b) => { settings = P.normalizeSettings({ ...settings, speakJa: b }); changed(); });
    const speakSjaRow = checkRow('例文の訳を読み上げる', settings.speakSentenceJa === true,
      (b) => { settings = P.normalizeSettings({ ...settings, speakSentenceJa: b }); changed(); });
    const rateGroup = radioGroup('ml-rate', '速さ', RATE_CHOICES.map((r) => [r, `${rateText(r)} 倍`]),
      RATE_CHOICES.includes(settings.rate) ? settings.rate : null,
      (v) => { settings = P.normalizeSettings({ ...settings, rate: v }); changed(); }, 'choice-row ml-row-4');

    const summary = el('p', { class: 'listen-summary', 'aria-live': 'polite' });
    const saveNote = el('p', { class: 'muted small' });
    const noticeEl = el('p', { class: 'error', role: 'alert', hidden: !message, text: message });

    const start = startButton('▶ 再生を始める',
      () => P.buildPlaylist(numbered, settings, marks, { rng: Math.random }),
      (list) => beginWith(list));

    function refresh() {
      const n = P.buildPlaylist(numbered, settings, marks, { rng: () => 0 }).length;
      summary.textContent = `${describeRange(range(), settings.sectionSize, total)}：${n} 語`;
      saveNote.textContent = canSave ? '' : 'この画面では設定を保存できません（プライベートブラウズなど）。';
      start.refresh();
    }

    function changed() {
      persist();
      refresh();
    }

    paintSectionBox();
    paintNosBox();
    showRangeKind();

    root.replaceChildren(el('div', { class: 'study listen mylisten' },
      el('div', { class: 'study-head' },
        el('p', { class: 'kicker ml-kicker', text: '聞き流し' }),
        el('button', { type: 'button', class: 'btn btn-quit', onclick: quit }, 'やめる')),
      noticeEl,
      el('div', { class: 'study-body' },
        el('div', { class: 'card' },
          el('h3', { text: '再生のしかた' }),
          presetGroup,
          el('div', { class: 'select-row' }, gapThinkField, gapNextField),
          speakJaRow,
          speakSjaRow,
          rateGroup),
        el('div', { class: 'card' },
          el('h3', { text: '範囲' }),
          rangeGroup,
          sectionBox,
          nosBox,
          notyetNote,
          sizeField),
        el('p', { class: 'muted small', text: '画面を消す（ロックする）と、iPhone では読み上げが止まります。再生中は画面がつけたままになります。' })),
      el('div', { class: 'study-bottom' },
        summary,
        saveNote,
        start.btn)));
    window.scrollTo(0, 0);
    refresh();
  }

  // ======================================================
  // 「▶ ここから再生」だけの画面（単語一覧から・続きから）
  // ======================================================

  function renderQuickStart(no, title) {
    ui = null;
    const it = items.get(no);
    // その語が今の範囲に無ければ、その語の Section を範囲にする（保存は始めたとき）
    let useSettings = settings;
    const inRange = P.buildPlaylist(numbered, settings, marks, { rng: () => 0 }).includes(no);
    if (!inRange) useSettings = P.normalizeSettings({ ...settings, range: { kind: 'section', section: sectionOfNo(no, settings.sectionSize) } });

    const start = startButton('▶ ここから再生',
      () => P.buildPlaylist(numbered, useSettings, marks, { startNo: no, rng: Math.random }),
      (list) => {
        if (useSettings !== settings) { settings = useSettings; persist(); }
        beginWith(list);
      });

    root.replaceChildren(el('div', { class: 'study listen mylisten' },
      el('div', { class: 'study-head' },
        el('p', { class: 'kicker ml-kicker', text: title }),
        el('button', { type: 'button', class: 'btn btn-quit', onclick: quit }, 'やめる')),
      el('div', { class: 'study-body' },
        el('div', { class: 'card ml-card' },
          el('p', { class: 'ml-card-no', text: `No.${no}` }),
          el('p', { class: 'ml-en', lang: 'en', text: it.word.word || '' }),
          el('p', { class: 'ml-ja', text: it.word.meaning || '' })),
        el('p', { class: 'muted small', text: `パターン：${presetOf().name}・範囲：${describeRange(useSettings.range, useSettings.sectionSize, total)}・速さ ${rateText(settings.rate)} 倍` }),
        inRange ? null : el('p', { class: 'muted small', text: 'この語は今の範囲に入っていないので、この語の Section を再生します。' })),
      el('div', { class: 'study-bottom' },
        start.btn,
        el('button', { type: 'button', class: 'btn btn-subtle', onclick: () => renderSetup() }, '設定を変える'))));
    window.scrollTo(0, 0);
    start.refresh();
  }

  // ======================================================
  // 再生画面
  // ======================================================

  function segButtons(name, options, current, onPick) {
    const wrap = el('div', { class: 'ml-seg', role: 'group', 'aria-label': name });
    const btns = options.map(([value, label]) => {
      const b = el('button', { type: 'button', class: 'ml-seg-btn', 'data-value': String(value) }, label);
      b.addEventListener('click', () => { onPick(value); paint(value); });
      return b;
    });
    const paint = (v) => btns.forEach((b, i) => b.setAttribute('aria-pressed', options[i][0] === v ? 'true' : 'false'));
    paint(current);
    wrap.append(...btns);
    return { wrap, paint };
  }

  function renderPlayer() {
    const progressText = el('span', { class: 'ml-progress-text' });
    const bar = el('div', { class: 'progress-bar' });
    const progressBtn = el('button', {
      type: 'button', class: 'ml-progress-btn', 'aria-label': '単語のリストを開く',
      onclick: openSheet,
    }, el('span', { class: 'ml-progress-top' }, progressText, el('span', { class: 'ml-list-hint', text: '☰ リスト' })),
    el('div', { class: 'progress ml-progress' }, bar));

    const noInput = el('input', {
      type: 'text', class: 'ml-no-input', inputmode: 'numeric', enterkeyhint: 'go', autocomplete: 'off',
      placeholder: 'No.', 'aria-label': '移りたい番号（No.）',
    });
    const noForm = el('form', { class: 'ml-no-form' },
      noInput,
      el('button', { type: 'submit', class: 'btn ml-no-go' }, '移動'));
    noForm.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const r = parseNoInput(noInput.value, total);
      if (r.error) { showNotice(r.error); return; }
      noInput.value = '';
      noInput.blur();
      goToNo(r.no, r.message);
    });

    const notice = el('p', { class: 'error', role: 'alert', hidden: true });
    const status = el('p', { class: 'listen-status ml-status', 'aria-live': 'polite' });

    // カード
    const cardNo = el('span', { class: 'ml-card-no' });
    const badge = el('span', { class: 'badge-unverified', title: 'まだ本と照合していない語です', text: '未確認', hidden: true });
    const markBadge = el('span', { class: 'ml-card-mark' });
    const ja = el('p', { class: 'ml-ja' });
    const en = el('p', { class: 'ml-en', lang: 'en' });
    const sentence = el('p', { class: 'sentence-en ml-sentence', lang: 'en' });
    const sentenceJa = el('p', { class: 'sentence-ja ml-sentence-ja' });
    const onlySentenceNote = el('p', { class: 'muted small', hidden: true, text: '例文のみ：文字は出しません。' });

    // 仕分け
    const knownBtn = el('button', { type: 'button', class: 'btn ml-mark-btn ml-mark-known', onclick: () => onMark('known') }, '○ 覚えた');
    const notyetBtn = el('button', { type: 'button', class: 'btn ml-mark-btn ml-mark-notyet', onclick: () => onMark('notyet') }, '△ まだ');

    // 速さ・リピート・シャッフル
    const rateSeg = segButtons('速さ', RATE_CHOICES.map((r) => [r, `${rateText(r)}x`]), settings.rate, (r) => {
      settings = { ...settings, rate: r };
      player.setRate(r);
      persist();
    });
    const repeatSeg = segButtons('リピート', Object.entries(REPEAT_LABELS), settings.repeat, (m) => {
      settings = { ...settings, repeat: m };
      player.setRepeat(m);
      persist();
    });
    const shuffleBtn = el('button', { type: 'button', class: 'ml-seg-btn ml-shuffle' }, '🔀 シャッフル');
    const paintShuffle = () => shuffleBtn.setAttribute('aria-pressed', settings.shuffle ? 'true' : 'false');
    paintShuffle();
    shuffleBtn.addEventListener('click', () => {
      settings = { ...settings, shuffle: !settings.shuffle };
      player.setShuffle(settings.shuffle);
      paintShuffle();
      persist();
    });

    // 操作
    const prevBtn = el('button', { type: 'button', class: 'btn ml-ctrl', 'aria-label': '前の語', onclick: () => { showNotice(''); player.prev(); } }, '⏮');
    const playBtn = el('button', { type: 'button', class: 'btn btn-primary ml-ctrl ml-play', onclick: onPlayClick });
    const nextBtn = el('button', { type: 'button', class: 'btn ml-ctrl', 'aria-label': '次の語', onclick: () => { showNotice(''); player.next(); } }, '⏭');

    const wrap = el('div', { class: 'study mylisten ml-player' },
      el('div', { class: 'ml-top' },
        el('div', { class: 'ml-top-row' },
          progressBtn,
          el('button', { type: 'button', class: 'btn btn-quit', onclick: quit }, 'やめる')),
        noForm),
      notice,
      el('div', { class: 'study-body' },
        el('div', { class: 'card ml-card' },
          el('div', { class: 'ml-card-head' }, cardNo, badge, markBadge, status),
          ja, en, sentence, sentenceJa, onlySentenceNote)),
      el('div', { class: 'study-bottom' },
        el('div', { class: 'btn-row ml-marks' }, knownBtn, notyetBtn),
        el('div', { class: 'ml-options' },
          el('p', { class: 'ml-opt-label', text: '速さ' }), rateSeg.wrap,
          el('p', { class: 'ml-opt-label', text: 'リピート' }),
          el('div', { class: 'ml-repeat-row' }, repeatSeg.wrap, shuffleBtn)),
        el('div', { class: 'ml-controls' }, prevBtn, playBtn, nextBtn),
        el('button', { type: 'button', class: 'btn btn-subtle', onclick: () => renderSetup() }, '設定・範囲を変える')));

    root.replaceChildren(wrap);
    ui = {
      wrap, progressText, bar, progressBtn, notice, status, cardNo, badge, markBadge, ja, en, sentence, sentenceJa,
      onlySentenceNote, knownBtn, notyetBtn, playBtn, prevBtn, nextBtn, rateSeg, repeatSeg,
    };
    window.scrollTo(0, 0);
    paintPlayer();
  }

  function has(shown, type) {
    if (shown instanceof Set) return shown.has(type);
    if (Array.isArray(shown)) return shown.includes(type);
    return false;
  }

  function paintPlayer() {
    if (!ui) return;
    const st = lastState || { status: 'idle', no: playlist[0], shown: new Set() };
    const no = st.no;
    const it = items.get(no);
    const info = progressInfo(no, settings.sectionSize, total);
    ui.progressText.textContent = info.text || '—';
    ui.bar.style.width = info.size ? `${Math.round((info.pos / info.size) * 100)}%` : '0%';

    ui.status.textContent = st.status === 'playing' ? '再生中'
      : st.status === 'paused' ? '一時停止中'
        : st.status === 'ended' ? '最後まで再生しました' : '';
    ui.playBtn.textContent = st.status === 'playing' ? '❚❚ 一時停止' : st.status === 'ended' ? '▶ 最初から' : '▶ 再生';
    ui.playBtn.setAttribute('aria-label', ui.playBtn.textContent);

    if (!it) {
      ui.cardNo.textContent = '';
      for (const k of ['ja', 'en', 'sentence', 'sentenceJa']) ui[k].hidden = true;
      return;
    }
    const w = it.word;
    const s = it.sentence;
    const shown = st.shown;
    ui.cardNo.textContent = `No.${no}`;
    ui.badge.hidden = w.verified === true;

    const mark = marks[w.id];
    ui.markBadge.textContent = mark === 'known' ? '○ 覚えた' : mark === 'notyet' ? '△ まだ' : '';
    ui.markBadge.className = `ml-card-mark ml-mark-${mark || 'none'}`;
    ui.knownBtn.setAttribute('aria-pressed', mark === 'known' ? 'true' : 'false');
    ui.notyetBtn.setAttribute('aria-pressed', mark === 'notyet' ? 'true' : 'false');

    ui.ja.hidden = !has(shown, 'showJa');
    ui.ja.textContent = w.meaning || '';
    ui.en.hidden = !has(shown, 'showEn');
    ui.en.textContent = w.word || '';

    const showS = has(shown, 'showSentence') && s && s.en;
    ui.sentence.hidden = !showS;
    if (showS && ui.sentence.dataset.no !== String(no)) {
      const hit = w.form ? safe(() => findForm(s.en, w.form), null) : null;
      if (hit) ui.sentence.replaceChildren(hit.before, el('strong', { text: hit.target }), hit.after);
      else ui.sentence.textContent = s.en;
      ui.sentence.dataset.no = String(no);
    }
    const showSja = has(shown, 'showSentenceJa') && s && s.ja;
    ui.sentenceJa.hidden = !showSja;
    ui.sentenceJa.textContent = showSja ? s.ja : '';

    const onlySentence = !presetOf().steps.some((x) => String(x.type).startsWith('show'));
    ui.onlySentenceNote.hidden = !onlySentence;
  }

  function onPlayClick() {
    showNotice('');
    const st = safe(() => player.getState(), null);
    if (!st) return;
    if (st.status === 'playing') { player.pause(); return; }
    if (st.status === 'paused') { player.resume(); return; }
    player.play(); // idle：今の語から、ended：先頭から
  }

  function onMark(value) {
    const st = lastState;
    const it = st ? items.get(st.no) : null;
    if (!it) return;
    marks = setMark(marks, it.word.id, value);
    persist();
    paintPlayer();
    if (sheet) sheet.update({ marks });
  }

  function openSheet() {
    if (sheet || !ui) return;
    sheet = openListSheet(ui.wrap, {
      numbered,
      sectionSize: settings.sectionSize,
      currentNo: lastState ? lastState.no : null,
      lastNo: lastNoAtOpen,
      marks,
      onPlayFrom: (no) => { showNotice(''); goToNo(no); },
      onRepeatOne: (no) => { showNotice(''); repeatOne(no); if (ui) ui.repeatSeg.paint('one'); },
      onPlaySection: (sec) => playSection(sec),
      onJumpSection: (sec) => { showNotice(''); jumpSection(sec); },
      onClose: () => { sheet = null; },
    });
  }

  // ======================================================
  // 始め方
  // ======================================================
  if (!total) { renderSetup(); return; }

  if (startWordId != null) {
    const no = noById.get(String(startWordId));
    if (no != null) { renderQuickStart(no, '聞き流し：ここから'); return; }
    renderSetup('選んだ語が見つかりませんでした。範囲を選んで始めてください。');
    return;
  }
  if (autoResume) {
    if (lastNoAtOpen != null) { renderQuickStart(lastNoAtOpen, '聞き流し：続きから'); return; }
    renderSetup('前回の位置が見つかりませんでした。範囲を選んで始めてください。');
    return;
  }
  renderSetup();
}
