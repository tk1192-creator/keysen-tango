# フェーズ5「今日の学習」部品の取り決め

並行して作る 4 つの部品（srs.js / store.js / quiz.js / 画面）の約束ごと。各部品はこの取り決めどおりの名前・引数・戻り値で作る。
決まっていない細部は、各担当がこの方針の範囲で決めてよい（決めたことはファイル先頭のコメントに書く）。
CLAUDE.md 7章（学習設計）が上位のルール。

## 共通
- ES モジュール、ビルドなし、外部ライブラリなし。コメントと UI 文言は日本語、名前は英語。
- 日付は端末のローカル日付の文字列 `"YYYY-MM-DD"`。
- 単語（word）と例文（sentence）の形は CLAUDE.md 6章のとおり。**出題には `sentenceIds[0]`（代表の例文）だけを使う。**
- テストは `tests/*.test.mjs`（`node --test tests/` で実行。node:test と node:assert を使う）。教材の文章は使わず、自作のダミーで書く。

## js/srs.js（復習スケジュール、純粋な関数だけ）
```js
export const INTERVALS = [0, 1, 3, 7, 14, 30];       // 箱0〜5 の次回までの日数
export function todayStr(date = new Date()): string    // ローカル日付 "YYYY-MM-DD"
export function addDays(dateStr, n): string
export function applyAnswer(rec | undefined, correct: boolean, dateStr): rec
//  rec = { box, due, correct, wrong, last, first, mastered }
//  - 初めて答える語（rec が undefined）は box 0 から始めたものとして扱う。first = dateStr
//  - 正解：box = min(box + 1, 5)。ただし答える前が box 5 で正解なら mastered = true（box は 5 のまま）
//  - 不正解：box = 0、wrong + 1、mastered = false
//  - due = addDays(dateStr, INTERVALS[新しい box])（box 0 は当日）。last = dateStr
export function questionType(box): 'choice' | 'cloze' | 'spell'   // 0〜1 / 2〜3 / 4〜5
export function isDue(rec, dateStr): boolean            // rec があり、mastered でなく、due <= dateStr
export function buildDailyMenu(words, progress, { date, newPerDay, newDoneToday }): { reviews: string[], news: string[] }
//  - reviews：isDue の語の id。due が古い順、同じなら box が小さい順
//  - news：progress に記録のない語の id を、代表の例文番号（sentenceIds[0]）の小さい順、同じなら id 順に、
//          max(0, newPerDay - newDoneToday) 件
export function stageOf(sentenceId): number             // 50 文ごと：1〜50 → 1、51〜100 → 2 …（562 文で 12 ステージ）
export function stageSummary(words, progress): Array<{ stage, from, to, total, learned, mastered, rate }>
//  - learned：box >= 3 または mastered の語の数（「覚えた」とみなす）
//  - rate：learned / total（0〜1）
```

## js/store.js（localStorage の学習記録）
```js
// キー：'kk.progress.v1'（CLAUDE.md 6章の形に first / mastered を足したもの）
//       'kk.settings.v1' { newPerDay: 10, dailyGoal: 20 }（newPerDay は 5〜20）
//       'kk.log.v1'      { "YYYY-MM-DD": { answered, correct, newWords } }
export function setStorage(storageLike)       // テスト用に localStorage の代わりを差し込む（getItem/setItem/removeItem）
export function loadProgress(): object        // 無ければ {}
export function getRecord(wordId): rec | undefined
export function saveRecord(wordId, rec)       // 1 語ずつ即保存（アプリが途中で閉じられても残る）
export function loadSettings(): { newPerDay, dailyGoal }   // 既定値で補う
export function saveSettings(partial)
export function logAnswer(dateStr, { correct: boolean, isNew: boolean })
export function dayLog(dateStr): { answered, correct, newWords }
export function streak(dateStr): number       // 連続学習日数。今日 answered>0 なら今日から、まだなら昨日から数える
export function exportAll(): string           // 3 キーをまとめた JSON（バックアップ用）
export function importAll(jsonString)         // 形を検査してから書き戻す。不正なら Error（日本語メッセージ）
// localStorage が使えない環境（プライベートブラウズ等）では例外を握りつぶさず、
// isAvailable(): boolean で判定できるようにする
export function isAvailable(): boolean
```

## js/quiz.js（問題を作る、純粋な関数だけ）
```js
export function findForm(sentenceEn, form): { before, target, after } | null
//  例文の中の form の位置（最初の一致。できれば語の境目で一致するもの）で 3 つに分ける。太字表示と空欄に使う
export function makeChoice(word, allWords, rng = Math.random)
//  → { type: 'choice', wordId, prompt: word.word, options: string[4], answerIndex }
//  - options は意味（meaning）。不正解の 3 つは「同じ品詞の別の語」の意味から選ぶ（足りなければ他の品詞から）
//  - 正解と同じ文字列、同じ見出し語の別の意味は選ばない。4 つは互いに重複しない
export function makeCloze(word, sentence, allWords, rng = Math.random)
//  → { type: 'cloze', wordId, parts: { before, after }, options: string[4], answerIndex }
//  - 空欄にするのは word.form。options は form の候補（正解 = word.form）
//  - 不正解は同じ品詞の別の語の form から（見た目が近いもの＝語尾が同じ・長さが近いものを優先してよい）
export function makeSpell(word, sentence)
//  → { type: 'spell', wordId, meaning, parts: { before, after }, answer: word.form, hint: word.form[0] }
export function checkSpelling(input, answer): boolean
//  大文字小文字・前後の空白・連続した空白・’ と ' の違い・末尾の . ? ! は無視して比べる
export function makeQuestion(word, sentence, allWords, box, rng = Math.random)
//  srs.questionType(box) に応じて上の 3 つを呼び分ける。form が例文に見つからない語は choice にする
```

## 画面（js/modes/today.js ほか）
- `js/modes/today.js`：`export async function startToday(root, ctx)`。root は描画先の要素、
  ctx = `{ words, sentencesById, getAudioBlob, onExit }`（words と例文は main.js が db.js から読んで渡す）
- ホーム（main.js / index.html）：今日の残り件数（復習・新規）、今日の目標までの進捗バー、連続学習日数、
  ステージ別の達成率、「今日の学習を始める」ボタン、未確認の語の数。
- 出題画面：例文（choice のときは見出し語を太字）、「例文を聞く」（代表の例文の英語区間 seg.en1）、
  「単語の発音」（speechSynthesis。word.word の "..." や "～" は読まない）、未確認の語（verified=false）には小さな印。
- 回答後：正誤、例文全体（見出し語を太字）、和訳、「次へ」。不正解の語は、その回の最後にもう一度出す（1 回だけ）。
- 終了画面：今日の結果（正解数／問題数）、連続学習日数、ホームへ戻るボタン。
- 音声：audio.js の `prepare(key, blob)` を問題を表示した時点で呼び、ボタンでは `playSegment(start, end)` だけを呼ぶ（iPhone 対策）。
