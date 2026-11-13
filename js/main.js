// 画面遷移と、データパックの取り込み画面・ホーム・今日の学習・設定
import { getPackInfo, importPack, getAllWords, getAllSentences, getAudioBlob, PackError } from './db.js';
import { stop } from './audio.js';
import { todayStr, buildDailyMenu, stageSummary } from './srs.js';
import { loadProgress, loadSettings, saveSettings, dayLog, streak, isAvailable } from './store.js';
import { startToday } from './modes/today.js';
import { startListening } from './modes/listening.js';
import { startCompose } from './modes/compose.js';
import { startDictation } from './modes/dictation.js';
import { startWeak, countWeakWords } from './modes/weak.js';
import { startWordList } from './modes/wordlist.js';

const $ = (id) => document.getElementById(id);
const SCREENS = ['loading', 'setup', 'home', 'study', 'listening', 'mode', 'settings'];
const DEFAULT_SETTINGS = { newPerDay: 10, dailyGoal: 20 };
const NEW_PER_DAY_CHOICES = Array.from({ length: 16 }, (_, i) => i + 5); // 5〜20
const DAILY_GOAL_CHOICES = [10, 15, 20, 25, 30, 40, 50, 60];

function show(name) {
  for (const s of SCREENS) $(`screen-${s}`).hidden = s !== name;
  $('btn-settings').hidden = name !== 'home';
  window.scrollTo(0, 0);
}

function currentScreen() {
  return SCREENS.find((s) => !$(`screen-${s}`).hidden) || null;
}

/** 例外が出たら fallback を返す（記録が読めない環境でも画面を止めないため） */
function safe(fn, fallback) {
  try { return fn(); } catch (e) { console.warn(e); return fallback; }
}

function fmtDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('ja-JP', { dateStyle: 'medium', timeStyle: 'short' });
}

// ---------- 単語・例文（IndexedDB から一度だけ読む） ----------
let data = null; // { words, sentencesById }

async function loadData() {
  if (data) return data;
  const [words, sentences] = await Promise.all([getAllWords(), getAllSentences()]);
  data = { words, sentencesById: new Map(sentences.map((s) => [s.id, s])) };
  return data;
}

// ---------- はじめに（取り込み） ----------
function setImportBusy(busy) {
  $('pack-file').disabled = busy;
  $('pack-file').closest('label').classList.toggle('disabled', busy);
}

async function onPackSelected(ev) {
  const file = ev.target.files && ev.target.files[0];
  ev.target.value = ''; // 同じファイルを選び直せるように
  if (!file) return;
  $('import-error').hidden = true;
  $('import-progress').hidden = false;
  setImportBusy(true);
  try {
    await importPack(file, ({ done, total, message }) => {
      $('import-message').textContent = message;
      const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
      $('import-bar').style.width = `${pct}%`;
    });
    data = null; // 新しいデータパックを読み直す
    await openHome();
  } catch (e) {
    const msg = e instanceof PackError ? e.message : `取り込みに失敗しました（${e.message || e}）`;
    $('import-error').textContent = msg;
    $('import-error').hidden = false;
    $('import-progress').hidden = true;
  } finally {
    setImportBusy(false);
  }
}

// ---------- ホーム ----------
async function openHome() {
  const info = await getPackInfo();
  if (!info) { show('setup'); return; }
  const { words } = await loadData();
  $('home-title').textContent = info.title || 'データパック';
  $('home-sentences').textContent = info.counts.sentences;
  $('home-words').textContent = info.counts.words;
  $('home-error').hidden = true;
  renderHome(words);
  show('home');
}

function renderHome(words) {
  $('home-storage-warning').hidden = safe(() => isAvailable(), false);

  const today = todayStr();
  const progress = safe(() => loadProgress(), {});
  const settings = { ...DEFAULT_SETTINGS, ...safe(() => loadSettings(), {}) };
  const log = { answered: 0, correct: 0, newWords: 0, ...safe(() => dayLog(today), {}) };

  // 今日の残り
  const menu = buildDailyMenu(words, progress, {
    date: today, newPerDay: settings.newPerDay, newDoneToday: log.newWords || 0,
  });
  $('home-reviews').textContent = menu.reviews.length;
  $('home-news').textContent = menu.news.length;
  const remaining = menu.reviews.length + menu.news.length;
  $('btn-start-today').disabled = remaining === 0;
  $('home-done-message').hidden = remaining !== 0;

  // 今日の目標までの進み具合
  const goal = Math.max(1, settings.dailyGoal || DEFAULT_SETTINGS.dailyGoal);
  const done = log.answered || 0;
  const pct = Math.min(100, Math.round((done / goal) * 100));
  $('home-goal-text').textContent = done >= goal ? `${done} / ${goal} 問（達成）` : `${done} / ${goal} 問`;
  $('home-goal-bar').style.width = `${pct}%`;
  const bar = $('home-goal-progress');
  bar.setAttribute('aria-valuemax', String(goal));
  bar.setAttribute('aria-valuenow', String(Math.min(done, goal)));

  // 連続学習日数
  $('home-streak').textContent = safe(() => streak(today), 0) || 0;

  // ステージ別の達成率
  const stages = stageSummary(words, progress);
  $('home-stages').replaceChildren(...stages.map(renderStage));

  // 未確認の語
  $('home-unverified').textContent = words.filter((w) => w.verified !== true).length;

  // 苦手な語の数（苦手復習のボタンに出す）
  const weakCount = safe(() => countWeakWords(words, progress), 0) || 0;
  $('home-weak-desc').textContent = weakCount
    ? `まちがえた語だけを出題する（苦手な語 ${weakCount} 語）`
    : 'まちがえた語だけを出題する（いまは苦手な語はありません）';
}

function renderStage(st) {
  const li = document.createElement('li');
  li.className = 'stage';
  const pct = st.total ? Math.round((st.rate || 0) * 100) : 0;

  const head = document.createElement('div');
  head.className = 'stage-head';
  const name = document.createElement('span');
  name.className = 'stage-name';
  name.textContent = `ステージ ${st.stage}`;
  const range = document.createElement('span');
  range.className = 'stage-range muted';
  range.textContent = `例文 ${st.from}〜${st.to}`;
  const count = document.createElement('span');
  count.className = 'stage-count';
  count.textContent = st.total ? `${st.learned} / ${st.total} 語` : '語なし';
  head.append(name, range, count);

  const bar = document.createElement('div');
  bar.className = 'progress stage-progress';
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-label', `ステージ ${st.stage} の達成率`);
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  bar.setAttribute('aria-valuenow', String(pct));
  const fill = document.createElement('div');
  fill.className = 'progress-bar';
  fill.style.width = `${pct}%`;
  bar.append(fill);

  li.append(head, bar);
  return li;
}

// ---------- 今日の学習 ----------
async function onStartToday() {
  $('home-error').hidden = true;
  try {
    const d = await loadData();
    show('study');
    $('btn-settings').hidden = true;
    await startToday($('study-root'), {
      words: d.words,
      sentencesById: d.sentencesById,
      getAudioBlob,
      onExit: onStudyExit,
    });
  } catch (e) {
    console.error(e);
    stop();
    $('study-root').replaceChildren();
    await openHome();
    $('home-error').textContent = `今日の学習を始められませんでした（${e.message || e}）。`;
    $('home-error').hidden = false;
  }
}

function onStudyExit() {
  stop();
  $('study-root').replaceChildren();
  openHome().catch((e) => {
    $('home-error').textContent = `ホームを表示できませんでした（${e.message || e}）。`;
    $('home-error').hidden = false;
  });
}

// ---------- 例文リスニング ----------
async function onStartListening() {
  $('home-error').hidden = true;
  try {
    const d = await loadData();
    const sentences = [...d.sentencesById.values()].sort((a, b) => a.id - b.id);
    show('listening');
    await startListening($('listening-root'), {
      sentences,
      getAudioBlob,
      onExit: onListeningExit,
    });
  } catch (e) {
    console.error(e);
    stop();
    $('listening-root').replaceChildren();
    await openHome();
    $('home-error').textContent = `例文リスニングを始められませんでした（${e.message || e}）。`;
    $('home-error').hidden = false;
  }
}

function onListeningExit() {
  stop();
  $('listening-root').replaceChildren();
  openHome().catch((e) => {
    $('home-error').textContent = `ホームを表示できませんでした（${e.message || e}）。`;
    $('home-error').hidden = false;
  });
}

// ---------- 瞬間英作文・ディクテーション・苦手復習・単語一覧 ----------
// どのモードも同じ画面（screen-mode）の中に描く。入口の形は js/MODES.md のとおり
async function onStartMode(startFn, label) {
  $('home-error').hidden = true;
  try {
    const d = await loadData();
    const sentences = [...d.sentencesById.values()].sort((a, b) => a.id - b.id);
    show('mode');
    await startFn($('mode-root'), {
      words: d.words,
      sentences,
      sentencesById: d.sentencesById,
      getAudioBlob,
      onExit: onModeExit,
    });
  } catch (e) {
    console.error(e);
    stop();
    $('mode-root').replaceChildren();
    await openHome();
    $('home-error').textContent = `${label}を始められませんでした（${e.message || e}）。`;
    $('home-error').hidden = false;
  }
}

function onModeExit() {
  stop();
  $('mode-root').replaceChildren();
  openHome().catch((e) => {
    $('home-error').textContent = `ホームを表示できませんでした（${e.message || e}）。`;
    $('home-error').hidden = false;
  });
}

// ---------- 設定 ----------
function fillSelect(sel, values, current, unit) {
  const list = values.includes(current) ? values : [...values, current].sort((a, b) => a - b);
  sel.replaceChildren(...list.map((v) => new Option(`${v} ${unit}`, String(v))));
  sel.value = String(current);
}

function renderStudySettings() {
  const ok = safe(() => isAvailable(), false);
  const settings = { ...DEFAULT_SETTINGS, ...safe(() => loadSettings(), {}) };
  fillSelect($('set-new-per-day'), NEW_PER_DAY_CHOICES, settings.newPerDay, '語');
  fillSelect($('set-daily-goal'), DAILY_GOAL_CHOICES, settings.dailyGoal, '問');
  $('set-new-per-day').disabled = !ok;
  $('set-daily-goal').disabled = !ok;
  $('set-study-message').textContent = ok ? '' : 'この画面では設定を保存できません（プライベートブラウズなど）。';
}

function onStudySettingChange(key, sel) {
  const value = Number(sel.value);
  try {
    saveSettings({ [key]: value });
    $('set-study-message').textContent = '保存しました。';
  } catch (e) {
    $('set-study-message').textContent = `保存できませんでした（${e.message || e}）。`;
  }
}

async function openSettings() {
  const info = await getPackInfo();
  renderStudySettings();
  $('set-title').textContent = info ? (info.title || '-') : '-';
  $('set-counts').textContent = info ? `例文 ${info.counts.sentences}・単語 ${info.counts.words}・音声 ${info.counts.audio}` : '-';
  $('set-created').textContent = info ? fmtDate(info.created) : '-';
  $('set-imported').textContent = info ? fmtDate(info.importedAt) : '-';
  show('settings');
}

function onReimport() {
  const ok = window.confirm('データパックを入れ直します。いまのデータパックは、新しいものに置き換わります。よろしいですか？\n（学習の記録は消えません）');
  if (!ok) return;
  $('import-error').hidden = true;
  $('import-progress').hidden = true;
  show('setup');
}

// ---------- 起動 ----------
async function start() {
  $('pack-file').addEventListener('change', onPackSelected);
  $('btn-settings').addEventListener('click', openSettings);
  $('btn-back').addEventListener('click', openHome);
  $('btn-reimport').addEventListener('click', onReimport);
  $('btn-start-today').addEventListener('click', onStartToday);
  $('btn-start-listening').addEventListener('click', onStartListening);
  $('btn-start-compose').addEventListener('click', () => onStartMode(startCompose, '瞬間英作文'));
  $('btn-start-dictation').addEventListener('click', () => onStartMode(startDictation, 'ディクテーション'));
  $('btn-start-weak').addEventListener('click', () => onStartMode(startWeak, '苦手復習'));
  $('btn-start-wordlist').addEventListener('click', () => onStartMode(startWordList, '単語一覧'));
  $('set-new-per-day').addEventListener('change', (ev) => onStudySettingChange('newPerDay', ev.target));
  $('set-daily-goal').addEventListener('change', (ev) => onStudySettingChange('dailyGoal', ev.target));
  // 日をまたいで開き直したときに、ホームの数字を今日の分に直す
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && currentScreen() === 'home' && data) {
      safe(() => renderHome(data.words), null);
    }
  });
  try {
    await openHome();
  } catch (e) {
    show('setup');
    $('import-error').textContent = `この端末ではデータを保存できないようです（${e.message || e}）。プライベートブラウズを使っている場合は、通常の画面で開いてください。`;
    $('import-error').hidden = false;
  }
}

start();
