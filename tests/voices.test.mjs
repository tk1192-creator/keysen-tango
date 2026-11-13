// js/voices.js のテスト（声の一覧は自作のダミー）
import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreVoice, listVoices, pickVoice, loadVoicePref, saveVoicePref, prefKeyOf } from '../js/voices.js';

const V = (name, lang, extra = {}) => ({ name, lang, voiceURI: `uri:${name}`, localService: true, default: false, ...extra });
const voices = [
  V('Kyoko', 'ja-JP'),
  V('Kyoko (Enhanced)', 'ja-JP'),
  V('O-ren（プレミアム）', 'ja-JP'),
  V('Hattori', 'ja-JP'),
  V('Samantha', 'en-US'),
  V('Samantha (Enhanced)', 'en-US'),
  V('Bubbles', 'en-US'),
  V('Daniel', 'en-GB'),
  V('Google 日本語', 'ja-JP', { localService: false }),
];

test('品質の高い声ほど点数が高い（プレミアム > 拡張 > 標準）。冗談用の声は除く', () => {
  assert.ok(scoreVoice(voices[2]) > scoreVoice(voices[1]));
  assert.ok(scoreVoice(voices[1]) > scoreVoice(voices[0]));
  assert.ok(scoreVoice(voices[6]) < 0);
});

test('listVoices：同じ言語をよい順に、次に同じ言語の別の地域。冗談用は入らない', () => {
  const en = listVoices(voices, 'en-US').map((v) => v.name);
  assert.deepEqual(en, ['Samantha (Enhanced)', 'Samantha', 'Daniel']);
  const ja = listVoices(voices, 'ja-JP').map((v) => v.name);
  assert.equal(ja[0], 'O-ren（プレミアム）');
  assert.equal(ja.length, 5);
});

test('pickVoice：設定の声があればそれ、無ければ品質の高い声', () => {
  assert.equal(pickVoice(voices, 'ja-JP').name, 'O-ren（プレミアム）');
  assert.equal(pickVoice(voices, 'ja-JP', 'uri:Hattori').name, 'Hattori');
  assert.equal(pickVoice(voices, 'ja-JP', 'uri:Samantha').name, 'O-ren（プレミアム）', '別の言語の声は使わない');
  assert.equal(pickVoice(voices, 'ja-JP', 'uri:無い声').name, 'O-ren（プレミアム）');
  assert.equal(pickVoice([], 'ja-JP'), null);
  assert.equal(pickVoice(voices, 'fr-FR'), null);
});

test('設定の保存と読み込み。壊れたデータや保存できない環境でも落ちない', () => {
  const m = new Map();
  const storage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v) };
  assert.deepEqual(loadVoicePref(storage), { ja: null, en: null });
  assert.equal(saveVoicePref({ ja: 'uri:Hattori' }, storage), true);
  assert.deepEqual(loadVoicePref(storage), { ja: 'uri:Hattori', en: null });
  m.set('kk.voice.v1', '{壊れた');
  assert.deepEqual(loadVoicePref(storage), { ja: null, en: null });
  const broken = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } };
  assert.deepEqual(loadVoicePref(broken), { ja: null, en: null });
  assert.equal(saveVoicePref({ en: 'a' }, broken), false);
});

test('prefKeyOf', () => {
  assert.equal(prefKeyOf('ja-JP'), 'ja');
  assert.equal(prefKeyOf('en-US'), 'en');
});
