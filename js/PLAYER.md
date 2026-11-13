# 聞き流し（マイリスニング）の取り決め

単語を「日本語の意味 → 英単語 → 例文」のように自動で順に再生し、耳だけで覚えるモード。
2 つの担当が並行して作る：① `js/player.js`（再生の仕組み、純粋なロジック）② 画面（`js/modes/mylisten.js` ほか）。
CLAUDE.md・js/API.md・js/MODES.md が上位のルール。教材の文章をコード・テストに書かない。

## 用語・前提（決定済み）
- **単語の並び**：`srs.orderNewWords(words)` の順（本の番号順。番号の無い語は例文の位置）。
- **番号（No.）**：上の並びの先頭から 1, 2, 3 …（`seqNo`）。bookNo があっても、当面は表示も番号入力もこの通し番号を使う。
- **Section**：通し番号を「N 語ずつ」区切ったもの。N は設定で 20 / 30 / 50 / 100 / 150 / 200（初期 50）。Section 1 = No.1〜N。
- **音声**：
  - 日本語の意味 → 日本語 TTS（speechSynthesis、ja-JP）
  - 英単語 → 英語 TTS（en-US）。"..." や "～" は読まない
  - 例文 → 代表の例文（`sentenceIds[0]`）の mp3 の `seg.en1`（audio.js の区間再生）
  - 例文訳の読み上げ → 同じ mp3 の `seg.ja`（本物の音声）。区間が無ければ日本語 TTS で和訳を読む
  - 例文に出てこない語（`sentenceIds` が空）→ 例文系のステップは飛ばす（エラーにしない）
  - mp3 が無い・読めない → 例文の英文を英語 TTS で読む（止めない）
- **画面ロック**：iPhone では TTS がロック中に止まるため対応しない。再生中は Screen Wake Lock（`navigator.wakeLock.request('screen')`）で画面を消さない。使えない環境では何もしない。ページが非表示から戻ったら取り直す。
- **学習記録（kk.progress.v1）の箱・期限は変えない**。このモードの記録は `kk.mylisten.v1` に保存。

## ステップとパターン（JSON で保存できる形）
```js
// ステップ：{ type, sec?, when? }
// type: 'showJa' | 'speakJa' | 'showEn' | 'speakEn' | 'showSentence' | 'playSentence'
//       | 'showSentenceJa' | 'speakSentenceJa' | 'wait'
// sec: wait の秒数。数値か、設定のキー名の文字列（'gapThink' | 'gapNext'）
// when: 設定のキー名（'speakJa' | 'speakSentenceJa'）。その設定が false のときは飛ばす
export const PRESETS = [
  { id: 'ja-en-sentence', name: '日→英→例文', steps: [
    { type: 'showJa' }, { type: 'speakJa', when: 'speakJa' }, { type: 'wait', sec: 'gapThink' },
    { type: 'showEn' }, { type: 'speakEn' },
    { type: 'showSentence' }, { type: 'playSentence' },
    { type: 'showSentenceJa' }, { type: 'speakSentenceJa', when: 'speakSentenceJa' },
    { type: 'wait', sec: 'gapNext' } ] },
  { id: 'en-ja', name: '英→日', steps: [
    { type: 'showEn' }, { type: 'speakEn' }, { type: 'wait', sec: 'gapThink' },
    { type: 'showJa' }, { type: 'speakJa', when: 'speakJa' }, { type: 'wait', sec: 'gapNext' } ] },
  { id: 'word-only', name: '単語のみ', steps: [
    { type: 'showEn' }, { type: 'speakEn' }, { type: 'showJa' }, { type: 'speakJa', when: 'speakJa' },
    { type: 'wait', sec: 'gapNext' } ] },
  { id: 'sentence-only', name: '例文のみ', steps: [
    { type: 'playSentence' }, { type: 'wait', sec: 'gapNext' } ] },   // 文字は出さない
];
```

## js/player.js（純粋なロジック。DOM・audio.js・speechSynthesis を直接使わない）
```js
export const PRESETS                                   // 上のとおり
export const DEFAULT_SETTINGS = { presetId: 'ja-en-sentence', sectionSize: 50, gapThink: 2, gapNext: 1.5,
  speakJa: true, speakSentenceJa: false, rate: 1.0, repeat: 'off' /* 'off'|'one'|'range' */, shuffle: false,
  range: { kind: 'all' } /* {kind:'all'} | {kind:'section', section} | {kind:'nos', from, to} | {kind:'notyet'} */ }
export function normalizeSettings(obj): settings      // 範囲外を補正（rate 0.75〜1.5、gap 0〜10 秒、sectionSize は 20/30/50/100/150/200。export const SECTION_SIZES に持つ）
export function numberWords(words): Array<{ no, word }> // orderNewWords の順に No.1〜
export function sectionOf(no, sectionSize): number
export function sectionRange(section, sectionSize, total): { from, to }
export function buildPlaylist(numbered, settings, marks, { startNo, rng }): number[]  // 再生する No. の配列
//  - range に応じて No. を選ぶ（notyet は marks[wordId] === 'notyet' の語。marks が無い語は含めない）
//  - startNo があれば「その No. から範囲の最後まで」（startNo が範囲外なら範囲の先頭から）
//  - shuffle なら startNo の語を先頭にして、残りをシャッフル
export function resolveSteps(preset, settings, word, sentence): Array<{ type, sec? }>
//  - when が false の設定のステップ、例文の無い語の例文系ステップを除き、sec を数値に解決
export function createPlayer({ drivers, onState }): Player
//  drivers = { speak(text, lang, rate) → Promise（読み終わりで解決）, playSegment(file, start, end, rate) → Promise,
//              wait(ms) → Promise, cancel() /* 今の音・TTS・待ちを即止める */ }
//  Player = {
//    load(playlist: number[], items: Map<no, {word, sentence}>, preset, settings),
//    play(), pause(), resume(), toggle(),
//    next(), prev(), jumpTo(no),                       // 今の音を止めてから、その語の最初のステップへ
//    setRate(r), setRepeat(mode), setShuffle(bool),    // shuffle の切り替えは「今の語を先頭に、残りを並べ直す」
//    getState(): { status: 'idle'|'playing'|'paused'|'ended', index, no, stepIndex, shown: Set<type>, total }
//  }
//  - ステップは順に await。音は終わったら次へ（重ならない）。pause は今のステップを cancel して、
//    resume でそのステップの頭からやり直す（音の途中からではなくステップの最初から）。
//  - 単語を移る（next/prev/jumpTo/自動の次）ときは drivers.cancel() してから。古い非同期は世代番号で捨てる。
//  - repeat 'one'：同じ語を繰り返す。'range'：最後まで行ったら先頭に戻る（shuffle なら並べ直す）。'off'：最後で ended。
//  - onState(state) を状態が変わるたびに呼ぶ（画面はこれで描き直す）。shown は「今の語で表示済みの show 系ステップ」。
export function loadMyListen(storage?) / saveMyListen(data, storage?)
//  kk.mylisten.v1 = { version: 1, settings, marks: { wordId: 'known'|'notyet' }, last: { wordId, no, at } }
//  読み書きは try/catch。壊れていたら既定値。
```

### player.js の実装で決めたこと（追記。詳しくは js/player.js 先頭のコメント）
- 追加の export：`MYLISTEN_KEY`（'kk.mylisten.v1'）、`speakableEn(text)`（"..." "～" などを除いた発音用の文字）、
  `REPEAT_MODES`、`RANGE_KINDS`、`RATE_MIN` / `RATE_MAX`、`GAP_MIN` / `GAP_MAX`。
- `createPlayer({ drivers, onState, rng })`：rng は省略可（Math.random）。`load` の preset は PRESETS のオブジェクトか id。
- `getState()` には取り決めの項目に加えて `stepType`・`rate`・`repeat`・`shuffle`・`playlist`（コピー）が入る。
  onState は各ステップを始める直前（show 系は shown に足した後）、語の移動・一時停止・終了のときに呼ぶ。
- drivers の Promise は「読み終わり／区間の終わり／待ち終わり」で解決すること。cancel() 後に解決・reject のどちらでもよい
  （古い呼び出しは世代番号で捨てる）。reject したステップは飛ばして次へ進む。
- playSentence：seg.en1 が無い・playSegment が失敗 → sentence.en を en-US の TTS。speakSentenceJa：seg.ja が無い・失敗 →
  sentence.ja を ja-JP の TTS。ファイル名は `sentence.file` を playSegment の第 1 引数に渡す（Blob の用意は画面側の driver）。
- 例文の無い語で、残るステップが wait だけになるとき（例文のみのパターン）は、その語を待たずに飛ばす。
  プレイリスト全体がそうなら空回りせず ended。
- 移動：playing 中は新しい語から続けて再生、paused / idle 中は止まったまま位置だけ移る（ended なら idle に戻る）。
  next は最後の語で repeat 'range' なら先頭へ、それ以外は ended。prev は先頭の語ならその語の最初から。jumpTo は無い No. なら false。
- setShuffle(true) は今の語を先頭に残りをシャッフル、false は No. の小さい順に戻す（今の語の位置へ）。今のステップは止めない。
- loadMyListen は既定値 `{ version: 1, settings, marks: {}, last: null }`。saveMyListen は保存できたら true、できなければ false。

## 画面（js/modes/mylisten.js、js/modes/mylisten-list.js）
- 入口：`startMyListen(root, ctx, { startWordId?, autoResume? })`。ctx は js/MODES.md のとおり。
- 設定画面：パターン、範囲（全体 / Section / 番号の範囲 / 「まだ」だけ）、Section の大きさ、間隔 2 つ、日本語読み上げ、例文訳の読み上げ、速度、「▶ 再生を始める」（タップで開始）。設定は kk.mylisten.v1 に保存。
- 再生画面：
  - 上部：「Section 3 ／ 12 / 50」と進み具合バー（タップで単語リストを開く）、番号入力（「125」→ No.125 へ）、やめる
  - 中央の大きなカード：日本語の意味／英単語（No. と未確認の印）／例文（見出し語を太字）／例文訳。表示済みのものは残す
  - 下部：前へ・再生/一時停止・次へ（大きく）、速度（0.75 / 1.0 / 1.25 / 1.5）、リピート（オフ / 1単語 / 範囲）、シャッフル
  - 仕分け：「覚えた」「まだ」を 1 タップで記録（押した方を目立たせる）
  - 最後に再生した語を kk.mylisten.v1.last に保存（語が変わるたび）
  - 再生中は Wake Lock。やめる・一時停止・終了で解放
- 単語リスト（下から出るシート）：Section ごとの見出し（タップでその Section へジャンプ）、検索（英語・日本語）、行に No.・英単語・意味・仕分けの印、
  再生中の語と前回止めた語に色、開いたらその位置へ自動スクロール、行タップ＝ここから再生、行の右端「︙」＝メニュー（ここから再生／この単語だけリピート／この Section の最初から再生）。
  1,700 語でも重くならないよう、表示は分けて描く（今の単語一覧の工夫をまねる）。
- ホーム：「ほかの学習」に「聞き流し」。前回の位置があれば「続きから再生（No.125 ○○ から）」ボタンをホームの上の方に。
- 単語一覧（wordlist.js）の詳細に「▶ ここから聞き流し」。
