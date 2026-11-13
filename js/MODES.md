# 学習モードの作り方（フェーズ6 の取り決め）

各モードは 1 ファイル（`js/modes/<name>.js`）。並行して作るため、共有ファイル（index.html・js/main.js・css/style.css・sw.js）は**各担当は変更しない**。つなぎ込みはまとめて行う。

## 入口の形
```js
export async function start<Name>(root, ctx)
// root：描画先の要素（この中だけに描く。document 全体や他の要素に触らない）
// ctx = {
//   words,          // 全単語（配列）
//   sentences,      // 全例文（id の小さい順の配列）
//   sentencesById,  // Map（id → 例文）
//   getAudioBlob,   // (fileName) => Promise<Blob>
//   onExit,         // 終わったら呼ぶ（ホームに戻る）
// }
```
- 画面の部品の作り方は `js/modes/today.js` を手本にする（`el()` などは各ファイルにコピーしてよい）。
- 上部に「やめる」ボタン（押したら `audio.stop()` してから `onExit()`）。
- 音声：`js/audio.js` の `prepare(file, blob)` を表示した時点で呼び、ボタンの処理の中では `playSegment(start, end)` だけを呼ぶ（iPhone 対策）。区間は `sentence.seg`（en1 / ja / en2 / en3、秒）。
- audio.js は読み込むと `new Audio()` を作るので、node のテストで import できない。**画面に依存しない関数（範囲の計算、採点、絞り込みなど）は別に export し**、audio.js は `start<Name>` の中で `await import('../audio.js')` する（`js/modes/listening.js` が手本）。
- 範囲の選び方は、ステージ（50 文ごと、`srs.stageOf`）か、例文番号の「から〜まで」。`js/modes/listening.js` の画面と言葉をそろえる。
- 学習記録（`js/store.js`）：`loadProgress()` で箱などを読んでよい。**箱（box）・期限（due）を変えてよいのは「今日の学習」だけ**。各モードの成績は、モードごとの localStorage キー（`kk.<name>.v1`）に保存する（読み書きは try/catch）。
- CSS はモード専用のファイル `css/<name>.css` に書く。既存の CSS 変数（--bg, --surface, --text, --muted, --line, --primary, --ok, --error など）とクラス（.card, .btn, .btn-primary, .progress など）を使い、見た目を今日の学習・例文リスニングとそろえる。
- ボタンは高さ 52px 以上・文字 18px 以上・下寄せ。正誤は色だけでなく ○ × の文字でも示す。未確認の語（verified !== true）には小さく「未確認」。
- テスト：`tests/<name>.test.mjs`（node:test）。自作のダミーデータだけ。`node --test tests\<name>.test.mjs` が通ること。
- 教材の文章をコードやテストに書かない。data\private を読まない。ネットワークを使わない。サーバーを起動しない。
