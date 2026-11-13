// quiz.js — 問題を作る（純粋な関数だけ。DOM・localStorage には触らない）
//
// 取り決め（js/API.md の js/quiz.js）どおりの名前・引数・戻り値で作る。
// 取り決めで決まっていなかった点は、次のように決めた。
//
// 【共通】
// - rng は Math.random と同じ形（引数なし、0 以上 1 未満の数を返す）。テストでは固定の乱数を渡す。
//   万一 1 以上を返しても配列の範囲を超えないように丸める。
// - 出題形式の規則（箱 0〜1 → choice、2〜3 → cloze、4〜5 → spell）は srs.js を import せず、
//   この中に小さく持つ（typeForBox）。箱が数でないときは 0、範囲外は 0〜5 に丸める。
// - 「同じ見出し語」は word を前後の空白・連続空白・大文字小文字を無視して比べる（多義語の別項目を除くため）。
//   自分自身（同じ id）も当然除く。
//
// 【findForm】
// - 探す順番：①大文字小文字を区別・語の境目で一致 → ②区別しない・語の境目 → ③区別・境目なし → ④区別しない・境目なし。
//   最初に見つかった順番の、いちばん前の位置を使う。
// - 「語の境目」：form の先頭が英字・数字なら直前が英字・数字でないこと、form の末尾が英字・数字なら直後が英字・数字でないこと。
//   （form の端が記号のとき、例："How about ...?" 由来の "?" などは境目を問わない）
// - 大文字小文字を区別しない探し方では、’ ‘ と ' も同じ文字とみなす（入力ミスの吸収）。
// - target は例文の中の実際の文字列（大文字小文字が form と違うことがある。例：文頭の "Look"）。
// - form が空・例文が文字列でないときは null。
//
// 【makeChoice】
// - 不正解の候補：別の id、別の見出し語、意味が空でなく、正解の意味と違う語。意味の文字列（前後の空白を除く）で重複を除く。
// - 同じ品詞の候補から乱数で 3 つ選び、足りなければ他の品詞から乱数で補う。正解は乱数で決めた位置に入れる。
// - 候補が足りない（語が 4 未満など）ときは、出せるだけの数の選択肢で返す（最少で正解 1 つだけ）。
//
// 【makeCloze】
// - 例文に form が見つからないときは null を返す（makeQuestion では choice に切り替えるので null にはならない）。
// - 正解の選択肢は word.form そのもの（例文中の表記が大文字小文字で違っても form を使う）。
// - 不正解の候補：別の id、別の見出し語、form が空でなく、正解と大文字小文字を無視して違うもの。
//   同じ品詞から「見た目の近さ」の点数が小さい順に 3 つ（点数が同じものの順は乱数）。足りなければ他の品詞から同じく補う。
//   見た目の近さの点数 = 長さの差 + 語尾（-ing / -ed / -s / なし）が違えば 3 + 語数が違えば 2 + 先頭の大文字小文字が違えば 2。
//   熟語の語尾は先頭の語で判定する（"picked them up" → -ed）。
// - 正解が文頭にあり大文字で始まるときは、不正解も先頭を大文字にそろえる（大文字だけで答えが分からないように）。
//   そろえた後で、大文字小文字を無視して重複・正解と同じものを除く。
//
// 【makeSpell】
// - 例文に form が見つからないときは null を返す（makeQuestion では choice に切り替える）。
// - hint は form の先頭 1 文字（取り決めどおり）。
//
// 【checkSpelling】
// - 比べる前に両方を次のように整える：NFKC 正規化（全角英字・全角空白を半角に）、’ ‘ ` ´ → '、“ ” → "、
//   小文字化、前後の空白を除く、連続した空白を 1 つに、末尾の . ? !（とその前の空白）を除く。
// - 整えた結果が空のとき（何も入力していないとき）は不正解。
//
// 【makeQuestion】
// - cloze / spell になる箱でも、sentence が無い、または form が例文に見つからないときは choice にする。

const WORD_CHAR = /[\p{L}\p{N}]/u;

// 箱の番号から出題形式を決める（srs.questionType と同じ規則）
function typeForBox(box) {
  let b = Number(box);
  if (!Number.isFinite(b)) b = 0;
  b = Math.min(5, Math.max(0, Math.floor(b)));
  if (b <= 1) return 'choice';
  if (b <= 3) return 'cloze';
  return 'spell';
}

// 0 以上 n 未満の整数を乱数で返す
function randInt(rng, n) {
  const i = Math.floor(rng() * n);
  return Math.min(n - 1, Math.max(0, i));
}

// 配列をコピーして並べ替える（Fisher–Yates）
function shuffled(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(rng, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 見出し語の比較用キー
function headKey(s) {
  return String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// 1 文字ずつ、大文字小文字と ’ ' の違いをなくす（文字数が変わらないように 1 文字単位で変換する）
function foldChars(s) {
  let out = '';
  for (const ch of s) {
    let c = ch === '’' || ch === '‘' ? "'" : ch;
    const lower = c.toLowerCase();
    c = lower.length === c.length ? lower : c;
    out += c;
  }
  return out;
}

function isWordChar(ch) {
  return ch !== undefined && ch !== '' && WORD_CHAR.test(ch);
}

// text の中で pattern が一致する位置を前から順に調べ、境目の条件を満たす最初の位置を返す
function searchIndex(text, pattern, needBoundary) {
  const firstIsWord = isWordChar(pattern[0]);
  const lastIsWord = isWordChar(pattern[pattern.length - 1]);
  let from = 0;
  while (from <= text.length - pattern.length) {
    const i = text.indexOf(pattern, from);
    if (i < 0) return -1;
    if (!needBoundary) return i;
    const okStart = !firstIsWord || !isWordChar(text[i - 1]);
    const okEnd = !lastIsWord || !isWordChar(text[i + pattern.length]);
    if (okStart && okEnd) return i;
    from = i + 1;
  }
  return -1;
}

/**
 * 例文の中の form の位置で 3 つに分ける。
 * @returns {{before: string, target: string, after: string} | null}
 */
export function findForm(sentenceEn, form) {
  if (typeof sentenceEn !== 'string' || typeof form !== 'string' || form === '') return null;
  // foldChars は 1 文字単位の変換なので、たいていは文字数が変わらない。変わる場合は区別しない探し方を使わない
  const foldedText = foldChars(sentenceEn);
  const foldedForm = foldChars(form);
  const canFold = foldedText.length === sentenceEn.length && foldedForm.length === form.length;

  const tries = [
    [sentenceEn, form, true],
    canFold ? [foldedText, foldedForm, true] : null,
    [sentenceEn, form, false],
    canFold ? [foldedText, foldedForm, false] : null,
  ];
  for (const t of tries) {
    if (!t) continue;
    const i = searchIndex(t[0], t[1], t[2]);
    if (i >= 0) {
      return {
        before: sentenceEn.slice(0, i),
        target: sentenceEn.slice(i, i + form.length),
        after: sentenceEn.slice(i + form.length),
      };
    }
  }
  return null;
}

// 不正解の候補になれる別の語（自分・同じ見出し語を除く）
function otherWords(word, allWords) {
  const myKey = headKey(word.word);
  return (Array.isArray(allWords) ? allWords : []).filter(
    (w) => w && w.id !== word.id && headKey(w.word) !== myKey,
  );
}

// 正解を乱数の位置に入れて options と answerIndex を作る
function placeAnswer(answer, wrongs, rng) {
  const options = wrongs.slice();
  const answerIndex = randInt(rng, options.length + 1);
  options.splice(answerIndex, 0, answer);
  return { options, answerIndex };
}

/**
 * 意味の 4 択（英→日）を作る。
 * @returns {{type: 'choice', wordId: string, prompt: string, options: string[], answerIndex: number}}
 */
export function makeChoice(word, allWords, rng = Math.random) {
  const answer = String(word.meaning ?? '').trim();
  const others = otherWords(word, allWords).filter((w) => {
    const m = String(w.meaning ?? '').trim();
    return m !== '' && m !== answer;
  });
  const samePos = shuffled(others.filter((w) => w.pos === word.pos), rng);
  const otherPos = shuffled(others.filter((w) => w.pos !== word.pos), rng);

  const wrongs = [];
  const seen = new Set([answer]);
  for (const w of [...samePos, ...otherPos]) {
    if (wrongs.length >= 3) break;
    const m = String(w.meaning).trim();
    if (seen.has(m)) continue;
    seen.add(m);
    wrongs.push(m);
  }
  const { options, answerIndex } = placeAnswer(answer, wrongs, rng);
  return { type: 'choice', wordId: word.id, prompt: word.word, options, answerIndex };
}

// 語尾の種類（熟語は先頭の語で判定）
function endingOf(form) {
  const first = String(form).trim().split(/\s+/)[0].toLowerCase();
  if (first.endsWith('ing')) return 'ing';
  if (first.endsWith('ed')) return 'ed';
  if (first.endsWith('s') && !first.endsWith('ss')) return 's';
  return '';
}

function wordCount(form) {
  return String(form).trim().split(/\s+/).length;
}

function startsUpper(s) {
  const c = String(s).charAt(0);
  return c !== c.toLowerCase();
}

// 見た目の近さ（小さいほど近い）
function lookScore(cand, answer) {
  let score = Math.abs(cand.length - answer.length);
  if (endingOf(cand) !== endingOf(answer)) score += 3;
  if (wordCount(cand) !== wordCount(answer)) score += 2;
  if (startsUpper(cand) !== startsUpper(answer)) score += 2;
  return score;
}

// 点数の小さい順に並べる（点数が同じものの順は乱数）
function byLook(words, answer, rng) {
  return shuffled(words, rng)
    .map((w, i) => ({ w, i, s: lookScore(String(w.form), answer) }))
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .map((x) => x.w);
}

// 正解が文頭にあるか（前に文字が無い、または前が文末記号・引用符で終わる）
function isSentenceStart(before) {
  const b = before.trim();
  return b === '' || /[.!?"“]$/.test(b);
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * リスニング穴埋め（form の 4 択）を作る。form が例文に見つからないときは null。
 * @returns {{type: 'cloze', wordId: string, parts: {before: string, after: string}, options: string[], answerIndex: number} | null}
 */
export function makeCloze(word, sentence, allWords, rng = Math.random) {
  const answer = String(word.form ?? '');
  const found = findForm(sentence?.en, answer);
  if (!found) return null;

  const answerKey = answer.toLowerCase();
  const others = otherWords(word, allWords).filter((w) => {
    const f = String(w.form ?? '');
    return f !== '' && f.toLowerCase() !== answerKey;
  });
  const samePos = byLook(others.filter((w) => w.pos === word.pos), answer, rng);
  const otherPos = byLook(others.filter((w) => w.pos !== word.pos), answer, rng);

  const upper = startsUpper(answer) && isSentenceStart(found.before);
  const wrongs = [];
  const seen = new Set([answerKey]);
  for (const w of [...samePos, ...otherPos]) {
    if (wrongs.length >= 3) break;
    let f = String(w.form);
    if (upper) f = capitalize(f);
    const key = f.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    wrongs.push(f);
  }
  const { options, answerIndex } = placeAnswer(answer, wrongs, rng);
  return {
    type: 'cloze',
    wordId: word.id,
    parts: { before: found.before, after: found.after },
    options,
    answerIndex,
  };
}

/**
 * スペル入力（日→英）を作る。form が例文に見つからないときは null。
 * @returns {{type: 'spell', wordId: string, meaning: string, parts: {before: string, after: string}, answer: string, hint: string} | null}
 */
export function makeSpell(word, sentence) {
  const answer = String(word.form ?? '');
  const found = findForm(sentence?.en, answer);
  if (!found) return null;
  return {
    type: 'spell',
    wordId: word.id,
    meaning: word.meaning,
    parts: { before: found.before, after: found.after },
    answer,
    hint: answer[0],
  };
}

// スペル比較用に整える
function normalizeSpelling(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .replace(/[’‘`´]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[\s.?!]+$/, '');
}

/**
 * 入力されたスペルが正しいか。大文字小文字・空白・’ と '・末尾の . ? ! は無視する。
 */
export function checkSpelling(input, answer) {
  const a = normalizeSpelling(input);
  if (a === '') return false;
  return a === normalizeSpelling(answer);
}

/**
 * 箱の番号に応じて問題を作る。form が例文に見つからない語は choice にする。
 */
export function makeQuestion(word, sentence, allWords, box, rng = Math.random) {
  const type = typeForBox(box);
  if (type === 'cloze') {
    const q = makeCloze(word, sentence, allWords, rng);
    if (q) return q;
  } else if (type === 'spell') {
    const q = makeSpell(word, sentence);
    if (q) return q;
  }
  return makeChoice(word, allWords, rng);
}
