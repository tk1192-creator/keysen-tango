# データパックの形式（kk-pack v1）

アプリ本体には教材データを同梱しない。保護者が PC で作った zip（データパック）を、スマホのアプリで選んで取り込む。
作る側：`tools/build_pack.py`／読む側：`js/db.js`（取り込み画面は `js/main.js`）。

## zip の中身
```
syswords-pack.zip
├─ pack.json        … パックの情報（下記）
├─ sentences.json   … CLAUDE.md 6章の形式（配列）
├─ words.json       … CLAUDE.md 6章の形式（配列）
└─ audio/
   ├─ C115392_0001_system_jhs.mp3
   └─ …              … sentences[].file と同じ名前
```
- mp3 はすでに圧縮されているので、zip では **無圧縮（STORED）** で入れる（作成・展開が速く、スマホのメモリにもやさしい）。json は DEFLATE でよい。
- ファイル名は ASCII のみ。zip 内のパス区切りは `/`。

## pack.json
```json
{
  "format": "kk-pack",
  "version": 1,
  "created": "2026-11-13T18:30:00+09:00",
  "title": "（任意の表示名）",
  "counts": { "sentences": 562, "words": 1633, "audio": 562 }
}
```
- `format` が `kk-pack` でない、または `version` が未対応なら、取り込みを中止してエラーを表示する。
- `counts` と実際の件数が合わなければ、取り込みを中止してエラーを表示する。

## IndexedDB（アプリ側）
- データベース名 `kk-data`、バージョン 1
- オブジェクトストア
  - `meta`（キー指定なし。キー `"pack"` に pack.json の内容＋`importedAt` を保存）
  - `sentences`（keyPath `id`）
  - `words`（keyPath `id`）
  - `audio`（キー＝ファイル名、値＝`Blob`（type `audio/mpeg`））
- 取り込み直し（入れ直し）では、4 ストアを空にしてから入れる。途中で失敗したら、中途半端なデータを残さない（空に戻すか、前のデータのまま）。

## テスト用のダミーパック
- `tests/fixtures/dummy-pack.zip`：自作のダミー文 3〜5 件と、ffmpeg で作った短い音（ビープ音）の mp3。教材の文章や音声は入れない。
