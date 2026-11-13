// srs.js — 復習スケジュール（ライトナー方式、箱0〜5）
//
// 純粋な関数だけを置く（DOM・localStorage・ネットワークには触らない）。
// 入力の words / progress / rec は書き換えず、常に新しいオブジェクト・配列を返す。
// 仕様の元：CLAUDE.md 7章（学習設計）、js/API.md「js/srs.js」。
//
// ■ 日付の扱い
//   - 日付は端末のローカル日付の文字列 "YYYY-MM-DD"。
//   - 計算は new Date(年, 月-1, 日, 12時) のように年月日の数値で組み立て、正午を基準にする。
//     UTC 解釈（new Date("YYYY-MM-DD") は UTC 0時になる）や夏時間の 23/25 時間の日でずれないようにするため。
//   - 月末・年末・うるう年の繰り上がりは Date の日付あふれ処理に任せる（2028-02-28 + 1 = 2028-02-29）。
//
// ■ 取り決め（API.md）に書かれていなかった点の決め方
//   1. addDays：形式が "YYYY-MM-DD" でない、または存在しない日付（2026-02-30 など）は RangeError を投げる。
//      n は整数のみ（小数・NaN は RangeError）。負の数は過去の日付になる。
//   2. todayStr：無効な Date を渡されたら RangeError を投げる。
//   3. applyAnswer：
//      - 正解なら correct + 1（取り決めでは明記なし。記録の correct は正解回数とみなした）。
//      - correct は真偽値として扱う（!!correct）。
//      - 記録の box が範囲外・数値でないときは 0〜5 に丸める（NaN・負 → 0、5 超 → 5、小数は切り捨て）。
//      - 記録に first が無い（6章の古い形の記録）ときは、分かっている最も古い日として last を使い、
//        last も無ければ dateStr を入れる。
//      - 記録にある未知の項目（将来の拡張など）はそのまま引き継ぐ。
//      - すでに mastered の語にもう一度正解した場合も、答える前が box 5 なので mastered = true のまま。
//        due はほかと同じ規則（box 5 → 30 日後）で更新する。
//   4. questionType：box が 1 以下（負・NaN を含む）は choice、2〜3 は cloze、4 以上は spell。
//   5. isDue：記録に due が無い（壊れた記録）ときは「期限が来ている」とみなし true（復習で拾い直すため）。
//   6. buildDailyMenu：
//      - 対象は words に含まれる語だけ（progress にだけある id は無視する）。同じ id が重複していたら 1 回だけ数える。
//      - reviews の並び：due が古い順 → box が小さい順 → id 順（最後の id 順は結果を毎回同じにするため）。
//      - news：orderNewWords の順（9. を参照）。bookNo の無いデータでは、sentenceIds が無い語は最後に回す。
//      - オプションの既定値：date = todayStr()、newPerDay = 10（CLAUDE.md 7章の初期値）、newDoneToday = 0。
//        件数は max(0, floor(newPerDay - newDoneToday))。
//      - id の比較は文字列の大小（"w0001" のようなゼロ埋めの id を想定）。
//   7. stageOf：1 以上の整数でない sentenceId は 0（ステージなし）を返す（画面を止めないため例外は投げない）。
//   8. stageSummary：
//      - 語のステージは代表の例文（sentenceIds[0]）で決める。代表の例文が無効な語は数えない。
//        例文にない語（sentenceIds が空）は relatedSentenceIds[0] で決める（9. を参照）。
//      - ステージ 1 から「代表の例文番号の最大値が属するステージ」まで、途中に語が無いステージも
//        total 0 で含めて連番で返す。
//      - from = (stage-1)*50+1。to = stage*50 だが、語の sentenceIds（2 つ目以降も含む）に出てくる
//        最大の例文番号で頭打ちにする（562 文なら最後のステージは 551〜562）。
//      - mastered は rec.mastered === true の語の数。total 0 のステージの rate は 0。
//   9. 本の番号（bookNo）と例文にない語（2026-11-13 追加。項目が無い語は今までどおり動く）
//      - bookNo は 1 以上の整数（数字だけの文字列 "87" も数として読む）。それ以外は「無し」。
//      - 例文にない語：sentenceIds が無い、または空の配列。出題は意味 4 択だけ（画面側で扱う）。
//      - 語のステージを決める例文（stageSentenceId）：代表の例文が有効ならそれ。
//        sentenceIds が無い・空の語は relatedSentenceIds[0]（有効なら）。どちらも無ければ null（数えない）。
//      - 新しい語の順番（orderNewWords）：
//        ① bookNo のある語は bookNo の小さい順（同じなら id 順）。
//        ② bookNo の無い語は、代表の例文（sentenceIds[0]）を sentenceIds のどこかに含む bookNo のある語の
//           うち最小の bookNo（「よりどころ」）の直後に置く。同じよりどころの語どうしは、例文番号順 → id 順。
//        ③ よりどころが見つからない語（その例文に bookNo のある語がいない）は、
//           「その例文より前（同じ例文を含む）に代表の例文がある bookNo のある語のうち、最大の bookNo」の直後に、
//           例文番号順 → id 順で置く（前に 1 語も無ければ先頭）。本の番号の入力が途中でも、例文の順が大きく崩れないため。
//        ④ 例文も bookNo も無い語は最後（id 順）。
//        bookNo の語が 1 つも無いときは ③④だけになり、今までの順（例文番号順 → id 順、例文の無い語は最後）と同じ。
//        よりどころは「まだ学習していない語」だけでなく、words 全体から探す（学習済みの語の後ろにも置けるように）。

/** 箱0〜5 の次回までの日数（書き換えられないよう凍結） */
export const INTERVALS = Object.freeze([0, 1, 3, 7, 14, 30]);

/** 箱の最大値 */
const MAX_BOX = INTERVALS.length - 1;

/** 1 ステージあたりの例文数 */
const STAGE_SIZE = 50;

/** 1 日の新規語数の既定値（CLAUDE.md 7章） */
const DEFAULT_NEW_PER_DAY = 10;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// ---------------------------------------------------------------------------
// 内部の小道具
// ---------------------------------------------------------------------------

/** 数値を 2 桁・4 桁のゼロ埋め文字列にする */
function pad(n, width) {
  return String(n).padStart(width, '0');
}

/** Date をローカル日付の "YYYY-MM-DD" にする */
function formatLocal(date) {
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)}`;
}

/**
 * "YYYY-MM-DD" を検査して年月日の数値に分ける。
 * 形式が違う・存在しない日付なら RangeError。
 */
function parseDateStr(dateStr) {
  const m = typeof dateStr === 'string' ? DATE_RE.exec(dateStr) : null;
  if (!m) {
    throw new RangeError(`日付の形式が正しくありません（"YYYY-MM-DD" が必要）：${String(dateStr)}`);
  }
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  // 正午で組み立てて、往復で同じ日付になるかを確かめる（2026-02-30 などを弾く）
  const dt = new Date(y, mo - 1, d, 12, 0, 0, 0);
  dt.setFullYear(y); // 0〜99 年が 1900 年代に読み替えられるのを防ぐ
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) {
    throw new RangeError(`存在しない日付です：${dateStr}`);
  }
  return { y, mo, d };
}

/** box を 0〜5 の整数に丸める */
function normalizeBox(box) {
  const n = Math.trunc(Number(box));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, MAX_BOX);
}

/** 0 以上の整数でなければ 0 にする（回数の項目用） */
function count(n) {
  const v = Math.trunc(Number(n));
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** 文字列の大小で比べる（ゼロ埋めの id 用） */
function compareStr(a, b) {
  const sa = String(a);
  const sb = String(b);
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return 0;
}

/** 有効な例文番号（1 以上の整数）か */
function isValidSentenceId(id) {
  return Number.isInteger(id) && id >= 1;
}

/** 語の代表の例文番号。無ければ null */
function representativeSentenceId(word) {
  const ids = word && Array.isArray(word.sentenceIds) ? word.sentenceIds : [];
  return isValidSentenceId(ids[0]) ? ids[0] : null;
}

/** 例文番号の配列の先頭（有効なら）。無ければ null */
function firstValidHead(ids) {
  return Array.isArray(ids) && isValidSentenceId(ids[0]) ? ids[0] : null;
}

/** progress から語の記録を取る（自身のプロパティだけを見る） */
function recordOf(progress, id) {
  if (!progress || !Object.prototype.hasOwnProperty.call(progress, id)) return undefined;
  const rec = progress[id];
  return rec == null ? undefined : rec;
}

// ---------------------------------------------------------------------------
// 公開する関数
// ---------------------------------------------------------------------------

/**
 * ローカル日付の "YYYY-MM-DD" を返す。
 * @param {Date} [date=new Date()]
 * @returns {string}
 */
export function todayStr(date = new Date()) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new RangeError('todayStr には有効な Date を渡してください');
  }
  return formatLocal(date);
}

/**
 * 日付に n 日を足す（n が負なら引く）。
 * @param {string} dateStr "YYYY-MM-DD"
 * @param {number} n 整数
 * @returns {string} "YYYY-MM-DD"
 */
export function addDays(dateStr, n) {
  const { y, mo, d } = parseDateStr(dateStr);
  if (!Number.isInteger(n)) {
    throw new RangeError(`addDays の日数は整数で指定してください：${String(n)}`);
  }
  // 正午基準で日付あふれ（月末・年末・うるう年）を Date に任せる。夏時間でも日がずれない
  const dt = new Date(y, mo - 1, d + n, 12, 0, 0, 0);
  return formatLocal(dt);
}

/**
 * 1 回の回答を記録に反映した新しい記録を返す（rec は書き換えない）。
 * @param {object|undefined} rec { box, due, correct, wrong, last, first, mastered }
 * @param {boolean} correct 正解なら true
 * @param {string} dateStr 回答した日 "YYYY-MM-DD"
 * @returns {{box:number, due:string, correct:number, wrong:number, last:string, first:string, mastered:boolean}}
 */
export function applyAnswer(rec, correct, dateStr) {
  parseDateStr(dateStr); // 先に日付を検査する
  const isCorrect = !!correct;
  const prev = rec && typeof rec === 'object' ? rec : undefined;

  const prevBox = prev ? normalizeBox(prev.box) : 0;
  const prevCorrect = prev ? count(prev.correct) : 0;
  const prevWrong = prev ? count(prev.wrong) : 0;
  const first = prev ? (prev.first ?? prev.last ?? dateStr) : dateStr;

  let box;
  let mastered;
  if (isCorrect) {
    // 答える前が箱5で正解ならマスター（箱は5のまま）
    mastered = prevBox === MAX_BOX ? true : !!(prev && prev.mastered);
    box = Math.min(prevBox + 1, MAX_BOX);
  } else {
    box = 0;
    mastered = false;
  }

  return {
    ...(prev || {}), // 未知の項目は引き継ぐ
    box,
    due: addDays(dateStr, INTERVALS[box]),
    correct: prevCorrect + (isCorrect ? 1 : 0),
    wrong: prevWrong + (isCorrect ? 0 : 1),
    last: dateStr,
    first,
    mastered,
  };
}

/**
 * 箱に応じた出題形式。
 * @param {number} box
 * @returns {'choice'|'cloze'|'spell'} 箱0〜1：choice、2〜3：cloze、4〜5：spell
 */
export function questionType(box) {
  const b = normalizeBox(box);
  if (b <= 1) return 'choice';
  if (b <= 3) return 'cloze';
  return 'spell';
}

/**
 * 復習の期限が来ているか。
 * @param {object|undefined} rec
 * @param {string} dateStr
 * @returns {boolean} rec があり、mastered でなく、due <= dateStr
 */
export function isDue(rec, dateStr) {
  if (!rec || typeof rec !== 'object') return false;
  if (rec.mastered === true) return false;
  if (typeof rec.due !== 'string' || !DATE_RE.test(rec.due)) return true; // 壊れた記録は拾い直す
  return rec.due <= dateStr; // ゼロ埋めの "YYYY-MM-DD" は文字列比較で日付順になる
}

/**
 * 本の番号（1 以上の整数）。無い・不正なら null。数字だけの文字列も数として読む。
 * @param {object} word
 * @returns {number|null}
 */
export function bookNoOf(word) {
  if (!word) return null;
  let n = word.bookNo;
  if (typeof n === 'string' && /^\s*\d+\s*$/.test(n)) n = Number(n);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/**
 * 例文にない語か（sentenceIds が無い、または空）。
 * @param {object} word
 * @returns {boolean}
 */
export function isNoSentenceWord(word) {
  return !word || !Array.isArray(word.sentenceIds) || word.sentenceIds.length === 0;
}

/**
 * 関連例文の番号（relatedSentenceIds の最初の有効な番号）。無ければ null。
 * @param {object} word
 * @returns {number|null}
 */
export function relatedSentenceId(word) {
  if (!word || !Array.isArray(word.relatedSentenceIds)) return null;
  for (const id of word.relatedSentenceIds) {
    if (isValidSentenceId(id)) return id;
  }
  return null;
}

/**
 * 語のステージを決める例文番号。代表の例文。例文にない語は relatedSentenceIds[0]。無ければ null。
 * @param {object} word
 * @returns {number|null}
 */
export function stageSentenceId(word) {
  const rep = representativeSentenceId(word);
  if (rep !== null) return rep;
  if (isNoSentenceWord(word)) return firstValidHead(word && word.relatedSentenceIds);
  return null;
}

/**
 * 新しい語を出す順番に並べた id の配列（words 全体を並べる。重複した id は 1 回だけ）。
 * 決め方はファイル先頭の「9.」を参照。
 * @param {Array<object>} words
 * @returns {string[]}
 */
export function orderNewWords(words) {
  const list = [];
  const seen = new Set();
  for (const w of Array.isArray(words) ? words : []) {
    if (!w || w.id == null || seen.has(w.id)) continue;
    seen.add(w.id);
    list.push(w);
  }

  // 例文番号 → その例文に出てくる bookNo のある語の最小の bookNo
  const minBookBySentence = new Map();
  for (const w of list) {
    const no = bookNoOf(w);
    if (no === null || !Array.isArray(w.sentenceIds)) continue;
    for (const sid of w.sentenceIds) {
      if (!isValidSentenceId(sid)) continue;
      const cur = minBookBySentence.get(sid);
      if (cur === undefined || no < cur) minBookBySentence.set(sid, no);
    }
  }

  // 本の番号の入力が途中でも順番が大きく変わらないよう、
  // 例文の中に bookNo のある語がいない語は「その例文より前（同じ例文を含む）に代表の例文がある
  // bookNo のある語のうち、最大の bookNo」の直後に置く。前に 1 語も無ければ先頭（本の番号 0 の直後）。
  const numbered = list
    .map((w) => ({ no: bookNoOf(w), sid: representativeSentenceId(w) }))
    .filter((x) => x.no !== null && x.sid !== null)
    .sort((a, b) => a.sid - b.sid);
  const prefixMax = [];  // [代表の例文番号, そこまでの最大の bookNo]
  let runMax = 0;
  for (const x of numbered) {
    runMax = Math.max(runMax, x.no);
    prefixMax.push([x.sid, runMax]);
  }
  const anchorBefore = (sid) => {
    let lo = 0, hi = prefixMax.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (prefixMax[mid][0] <= sid) { ans = prefixMax[mid][1]; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  };

  // 並べ替えのキー：[まとまり, 本の位置, 種類（0=bookNo の語, 1=その直後）, 例文番号, id]
  const items = list.map((w) => {
    const no = bookNoOf(w);
    const sid = representativeSentenceId(w);
    if (no !== null) return { id: w.id, group: 0, pos: no, kind: 0, sid: sid ?? Infinity };
    if (sid === null) return { id: w.id, group: 2, pos: 0, kind: 0, sid: Infinity };
    const anchor = minBookBySentence.get(sid);
    if (anchor !== undefined) return { id: w.id, group: 0, pos: anchor, kind: 1, sid };
    return { id: w.id, group: 0, pos: anchorBefore(sid), kind: 1, sid };
  });
  const cmpNum = (a, b) => (a === b ? 0 : a < b ? -1 : 1);
  items.sort((a, b) => cmpNum(a.group, b.group) || cmpNum(a.pos, b.pos) || cmpNum(a.kind, b.kind)
    || (a.group === 0 && a.kind === 0 ? 0 : cmpNum(a.sid, b.sid)) || compareStr(a.id, b.id));
  return items.map((x) => x.id);
}

/**
 * 1 日のメニュー（復習と新規）を作る。
 * @param {Array<object>} words
 * @param {object} progress { [wordId]: rec }
 * @param {{date?:string, newPerDay?:number, newDoneToday?:number}} [opts]
 * @returns {{reviews:string[], news:string[]}}
 */
export function buildDailyMenu(words, progress, options) {
  const opts = options || {};
  const date = opts.date ?? todayStr();
  parseDateStr(date);
  const newPerDay = Number.isFinite(Number(opts.newPerDay)) && opts.newPerDay !== null
    ? Number(opts.newPerDay)
    : DEFAULT_NEW_PER_DAY;
  const newDoneToday = Number.isFinite(Number(opts.newDoneToday)) ? Number(opts.newDoneToday) : 0;
  const newLimit = Math.max(0, Math.floor(newPerDay - newDoneToday));

  const list = Array.isArray(words) ? words : [];
  const seen = new Set();
  const dueItems = [];
  const newIds = new Set();

  for (const w of list) {
    if (!w || w.id == null || seen.has(w.id)) continue;
    seen.add(w.id);
    const rec = recordOf(progress, w.id);
    if (rec === undefined) {
      newIds.add(w.id);
    } else if (isDue(rec, date)) {
      dueItems.push({
        id: w.id,
        due: typeof rec.due === 'string' ? rec.due : '', // due 無しは最も古い扱い
        box: normalizeBox(rec.box),
      });
    }
  }

  dueItems.sort((a, b) => compareStr(a.due, b.due) || a.box - b.box || compareStr(a.id, b.id));
  // 新規：本の番号順（orderNewWords）で並べ、記録の無い語だけを取る
  const news = orderNewWords(list).filter((id) => newIds.has(id));

  return {
    reviews: dueItems.map((x) => x.id),
    news: news.slice(0, newLimit),
  };
}

/**
 * 例文番号のステージ（50 文ごと）。1〜50 → 1、51〜100 → 2 …
 * @param {number} sentenceId
 * @returns {number} 無効な番号なら 0
 */
export function stageOf(sentenceId) {
  if (!isValidSentenceId(sentenceId)) return 0;
  return Math.ceil(sentenceId / STAGE_SIZE);
}

/**
 * ステージごとの達成状況。
 * @param {Array<object>} words
 * @param {object} progress
 * @returns {Array<{stage:number, from:number, to:number, total:number, learned:number, mastered:number, rate:number}>}
 */
export function stageSummary(words, progress) {
  const list = Array.isArray(words) ? words : [];
  const seen = new Set();
  let maxRepId = 0;
  let maxAnyId = 0;
  const items = [];

  for (const w of list) {
    if (!w || w.id == null || seen.has(w.id)) continue;
    seen.add(w.id);
    if (Array.isArray(w.sentenceIds)) {
      for (const sid of w.sentenceIds) {
        if (isValidSentenceId(sid) && sid > maxAnyId) maxAnyId = sid;
      }
    }
    const rep = stageSentenceId(w); // 例文にない語は関連例文で決める
    if (rep === null) continue;
    if (rep > maxAnyId) maxAnyId = rep;
    if (rep > maxRepId) maxRepId = rep;
    items.push({ stage: stageOf(rep), rec: recordOf(progress, w.id) });
  }

  const stageCount = stageOf(maxRepId); // 語が無ければ 0
  const result = [];
  for (let s = 1; s <= stageCount; s++) {
    result.push({
      stage: s,
      from: (s - 1) * STAGE_SIZE + 1,
      to: Math.min(s * STAGE_SIZE, maxAnyId),
      total: 0,
      learned: 0,
      mastered: 0,
      rate: 0,
    });
  }

  for (const { stage, rec } of items) {
    const row = result[stage - 1];
    row.total += 1;
    const isMastered = !!rec && rec.mastered === true;
    if (isMastered) row.mastered += 1;
    if (isMastered || (!!rec && normalizeBox(rec.box) >= 3)) row.learned += 1;
  }

  for (const row of result) {
    row.rate = row.total > 0 ? row.learned / row.total : 0;
  }
  return result;
}
