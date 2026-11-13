// 読み上げ（speechSynthesis）の声を選ぶ。全モード共通。
//
// - 端末に入っている声のうち、品質の高い声（「拡張」「プレミアム」「Siri」など）を優先する。
//   iPhone では 設定 → アクセシビリティ → 読み上げコンテンツ → 声 で高品質な声をダウンロードできる。
// - 設定画面で選んだ声（voiceURI）は localStorage 'kk.voice.v1' に保存し、それを最優先にする。
// - 冗談用の声（Bells、Bubbles、Zarvox など）は選ばない。
// - DOM に依存しない関数は node でテストできる（tests/voices.test.mjs）。

export const VOICE_KEY = 'kk.voice.v1';

// 冗談用・効果音のような声（macOS / iOS）。自動では選ばない
const NOVELTY = /\b(albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|deranged|hysterical|pipe organ)\b/i;

const norm = (s) => String(s || '').replace(/_/g, '-').toLowerCase();

/** 声の品質の点数（大きいほどよい） */
export function scoreVoice(v) {
  if (!v) return -Infinity;
  const name = `${v.name || ''} ${v.voiceURI || ''}`;
  if (NOVELTY.test(name)) return -100;
  let s = 0;
  if (/premium|プレミアム/i.test(name)) s += 6;
  if (/enhanced|拡張|高品質/i.test(name)) s += 5;
  if (/siri/i.test(name)) s += 4;
  if (/neural|natural/i.test(name)) s += 4;
  if (/google/i.test(name)) s += 3;            // Android Chrome の Google の声は比較的自然
  if (/compact|コンパクト|eloquence/i.test(name)) s -= 2;
  if (v.localService) s += 0.5;                // 通信なしで読める
  if (v.default) s += 0.2;
  return s;
}

/** その言語の声を、よい順に並べる */
export function listVoices(voices, lang) {
  const list = Array.isArray(voices) ? voices.filter(Boolean) : [];
  const want = norm(lang);
  const base = want.split('-')[0];
  const same = list.filter((v) => norm(v.lang) === want);
  const sameBase = list.filter((v) => norm(v.lang) !== want && norm(v.lang).split('-')[0] === base);
  const byScore = (a, b) => scoreVoice(b) - scoreVoice(a) || String(a.name).localeCompare(String(b.name));
  return [...same.sort(byScore), ...sameBase.sort(byScore)].filter((v) => scoreVoice(v) > -100);
}

/**
 * 使う声を選ぶ。preferredURI（設定で選んだ声）があればそれ、無ければ品質の高い声。
 * @returns {SpeechSynthesisVoice|null}
 */
export function pickVoice(voices, lang, preferredURI = null) {
  const list = Array.isArray(voices) ? voices.filter(Boolean) : [];
  if (preferredURI) {
    const p = list.find((v) => v.voiceURI === preferredURI);
    if (p && norm(p.lang).split('-')[0] === norm(lang).split('-')[0]) return p;
  }
  return listVoices(list, lang)[0] || null;
}

/** 設定の読み書き（{ ja: voiceURI|null, en: voiceURI|null }） */
export function loadVoicePref(storage = defaultStorage()) {
  try {
    const o = JSON.parse((storage && storage.getItem(VOICE_KEY)) || '{}');
    return { ja: typeof o.ja === 'string' ? o.ja : null, en: typeof o.en === 'string' ? o.en : null };
  } catch {
    return { ja: null, en: null };
  }
}
export function saveVoicePref(pref, storage = defaultStorage()) {
  try {
    const cur = loadVoicePref(storage);
    storage.setItem(VOICE_KEY, JSON.stringify({ ...cur, ...pref }));
    return true;
  } catch {
    return false;
  }
}
function defaultStorage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

/** 'ja-JP' → 'ja'、'en-US' → 'en'（設定のキー） */
export function prefKeyOf(lang) {
  return norm(lang).startsWith('ja') ? 'ja' : 'en';
}

// ---- ブラウザでだけ使う部分 ----

let cache = [];
/** 端末の声の一覧（読み込みが遅れる端末があるので、取れたものを覚えておく） */
export function getVoices() {
  try {
    if (typeof speechSynthesis === 'undefined') return cache;
    const v = speechSynthesis.getVoices();
    if (v && v.length) cache = v;
  } catch { /* 無視 */ }
  return cache;
}
if (typeof speechSynthesis !== 'undefined') {
  try { speechSynthesis.addEventListener('voiceschanged', getVoices); } catch { /* 古い環境 */ }
  getVoices();
}

/** 言語に合わせて、設定の声または品質の高い声を返す */
export function voiceFor(lang) {
  return pickVoice(getVoices(), lang, loadVoicePref()[prefKeyOf(lang)]);
}

/** 表示用の名前（例：「Kyoko（拡張）・ja-JP」） */
export function voiceLabel(v) {
  if (!v) return '';
  return `${v.name}${v.localService === false ? '（通信あり）' : ''}・${v.lang}`;
}
