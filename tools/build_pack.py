#!/usr/bin/env python3
"""データパック（kk-pack v1 の zip）を作る。形式は tools/PACK_FORMAT.md を参照。

使い方:
    python tools/build_pack.py --sentences data/private/sentences.json ^
        --words data/private/words.json --audio-dir data/private/audio ^
        --out data/private/syswords-pack.zip --title "キーセン単語"

    --title は任意（アプリに表示する名前）。省略すると空文字になる。

動き:
    1. 作る前に入力を検査する。
       - sentences の id の重複、file の重複、file 名が ASCII でない
       - sentences の各 file に対応する mp3 が --audio-dir にない
       - words の id の重複、sentenceIds に sentences にない番号がある
       問題があれば一覧を表示して中止する（終了コード 1、zip は作らない）。
       seg が欠けている例文などは「警告」として表示するが、作成は続ける。
    2. zip を作る。mp3 は無圧縮（ZIP_STORED）、json は ZIP_DEFLATED。
       pack.json に counts（sentences / words / audio の件数）を入れる。
    3. 作った zip を開き直し、counts と中身が一致するかを確かめて表示する。
       一致しなければ中止する（終了コード 1、既存の出力ファイルはそのまま）。
    4. --out にすでにファイルがある場合は上書きせず、
       「syswords-pack.zip.bak-20261113-183000」のような日時つきの名前に変えて残す。

入力の json は utf-8-sig で読む（BOM 付きでも読める）。
"""
from __future__ import annotations

import argparse
import json
import sys
import zipfile
from datetime import datetime
from pathlib import Path

PACK_FORMAT = "kk-pack"
PACK_VERSION = 1
SEG_KEYS = ("en1", "ja", "en2", "en3")


def load_json(path: Path):
    """json を utf-8-sig で読む（BOM の有無を問わない）。"""
    return json.loads(path.read_text(encoding="utf-8-sig"))


def is_ascii_name(name: str) -> bool:
    """zip 内のファイル名として使えるか（ASCII のみ・パス区切りなし）。"""
    return name.isascii() and "/" not in name and "\\" not in name and name not in ("", ".", "..")


def check_inputs(sentences, words, audio_dir: Path) -> tuple[list[str], list[str]]:
    """入力を検査する。戻り値は（エラーの一覧, 警告の一覧）。エラーがあれば作成しない。"""
    errors: list[str] = []
    warnings: list[str] = []
    if not isinstance(sentences, list):
        return ["sentences.json が配列になっていません"], warnings
    if not isinstance(words, list):
        return ["words.json が配列になっていません"], warnings

    # --- sentences ---
    sentence_ids: set = set()
    files: set[str] = set()
    for i, s in enumerate(sentences, start=1):
        sid = s.get("id")
        label = f"sentences {i} 件目（id={sid}）"
        if sid is None:
            errors.append(f"{label}: id がありません")
        elif sid in sentence_ids:
            errors.append(f"{label}: id {sid} が重複しています")
        sentence_ids.add(sid)

        name = s.get("file")
        if not name:
            errors.append(f"{label}: file がありません")
            continue
        if not is_ascii_name(name):
            errors.append(f"{label}: file「{name}」は ASCII のみのファイル名にしてください")
            continue
        if name in files:
            errors.append(f"{label}: file「{name}」が別の例文と重複しています")
        files.add(name)
        if not (audio_dir / name).is_file():
            errors.append(f"{label}: 音声ファイルがありません: {audio_dir / name}")

        seg = s.get("seg") or {}
        missing = [k for k in SEG_KEYS if k not in seg]
        if missing:
            warnings.append(f"{label}: seg に {', '.join(missing)} がありません")

    # --- words ---
    word_ids: set = set()
    for i, w in enumerate(words, start=1):
        wid = w.get("id")
        label = f"words {i} 件目（id={wid}）"
        if wid is None:
            errors.append(f"{label}: id がありません")
        elif wid in word_ids:
            errors.append(f"{label}: id {wid} が重複しています")
        word_ids.add(wid)

        sids = w.get("sentenceIds")
        if not isinstance(sids, list):
            errors.append(f"{label}: sentenceIds が配列になっていません")
            continue
        if not sids:
            warnings.append(f"{label}: sentenceIds が空です")
        for n in sids:
            if n not in sentence_ids:
                errors.append(f"{label}: sentenceIds の {n} が sentences にありません")
    return errors, warnings


def write_pack(sentences, words, audio_dir: Path, zip_path: Path, title: str) -> dict:
    """zip を書き出す。戻り値は pack.json の内容。"""
    files = [s["file"] for s in sentences]
    pack = {
        "format": PACK_FORMAT,
        "version": PACK_VERSION,
        "created": datetime.now().astimezone().isoformat(timespec="seconds"),
        "title": title,
        "counts": {"sentences": len(sentences), "words": len(words), "audio": len(files)},
    }

    def dump(obj) -> bytes:
        return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

    with zipfile.ZipFile(zip_path, "w") as zf:
        for name, obj in (("pack.json", pack), ("sentences.json", sentences), ("words.json", words)):
            zf.writestr(name, dump(obj), compress_type=zipfile.ZIP_DEFLATED)
        for name in files:
            zf.write(audio_dir / name, f"audio/{name}", compress_type=zipfile.ZIP_STORED)
    return pack


def verify_pack(zip_path: Path) -> tuple[dict, list[str]]:
    """zip を開き直して中身を確かめる。戻り値は（実際の件数, 問題の一覧）。"""
    problems: list[str] = []
    with zipfile.ZipFile(zip_path) as zf:
        bad = zf.testzip()
        if bad:
            problems.append(f"CRC が一致しないファイルがあります: {bad}")
        infos = {i.filename: i for i in zf.infolist()}
        for name in ("pack.json", "sentences.json", "words.json"):
            if name not in infos:
                problems.append(f"{name} がありません")
        if problems:
            return {}, problems

        pack = json.loads(zf.read("pack.json").decode("utf-8"))
        sentences = json.loads(zf.read("sentences.json").decode("utf-8"))
        words = json.loads(zf.read("words.json").decode("utf-8"))
        audio = sorted(n for n in infos if n.startswith("audio/") and n.endswith(".mp3"))
        actual = {"sentences": len(sentences), "words": len(words), "audio": len(audio)}

        if pack.get("format") != PACK_FORMAT or pack.get("version") != PACK_VERSION:
            problems.append(f"pack.json の format / version が違います: "
                            f"{pack.get('format')} / {pack.get('version')}")
        counts = pack.get("counts", {})
        for key, n in actual.items():
            if counts.get(key) != n:
                problems.append(f"counts.{key} が一致しません（pack.json: {counts.get(key)} / 実際: {n}）")

        audio_set = set(audio)
        missing = [s["file"] for s in sentences if f"audio/{s['file']}" not in audio_set]
        if missing:
            problems.append(f"sentences の file に対応する mp3 が zip にありません: {', '.join(missing[:10])}"
                            + (" ほか" if len(missing) > 10 else ""))

        for name, info in infos.items():
            if not name.isascii() or "\\" in name:
                problems.append(f"zip 内のファイル名が ASCII でないか、区切りが / ではありません: {name}")
            if name.endswith(".mp3") and info.compress_type != zipfile.ZIP_STORED:
                problems.append(f"mp3 が無圧縮（STORED）になっていません: {name}")
            if name.endswith(".json") and info.compress_type != zipfile.ZIP_DEFLATED:
                problems.append(f"json が DEFLATE になっていません: {name}")
    return actual, problems


def backup_path(out: Path) -> Path:
    """既存の出力ファイルを残すための日時つきの名前を決める（同じ名前があれば連番を付ける）。"""
    base = out.with_name(f"{out.name}.bak-{datetime.now():%Y%m%d-%H%M%S}")
    bak, n = base, 1
    while bak.exists():
        bak = base.with_name(f"{base.name}-{n}")
        n += 1
    return bak


def format_size(n: int) -> str:
    if n >= 1024 * 1024:
        return f"{n / 1024 / 1024:.1f} MB"
    return f"{n / 1024:.1f} KB"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="データパック（kk-pack v1 の zip）を作る")
    ap.add_argument("--sentences", required=True, type=Path, help="sentences.json のパス")
    ap.add_argument("--words", required=True, type=Path, help="words.json のパス")
    ap.add_argument("--audio-dir", required=True, type=Path, help="mp3 があるフォルダ")
    ap.add_argument("--out", required=True, type=Path, help="作る zip のパス")
    ap.add_argument("--title", default="", help="アプリに表示する名前（任意）")
    args = ap.parse_args(argv)

    # 入力ファイルの存在確認
    for p, kind in ((args.sentences, "file"), (args.words, "file"), (args.audio_dir, "dir")):
        if (kind == "file" and not p.is_file()) or (kind == "dir" and not p.is_dir()):
            print(f"エラー: 見つかりません: {p}")
            return 1
    try:
        sentences = load_json(args.sentences)
        words = load_json(args.words)
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        print(f"エラー: json を読めません: {e}")
        return 1

    # 1. 作る前の検査
    errors, warnings = check_inputs(sentences, words, args.audio_dir)
    for w in warnings:
        print(f"警告: {w}")
    if errors:
        for e in errors:
            print(f"エラー: {e}")
        print(f"エラーが {len(errors)} 件あるため、データパックは作っていません。")
        return 1
    print(f"入力の検査 OK（sentences {len(sentences)} 件 / words {len(words)} 件 / 警告 {len(warnings)} 件）")

    # 2. 一時ファイルに作る（失敗しても既存の出力ファイルは壊さない）
    args.out.parent.mkdir(parents=True, exist_ok=True)
    tmp = args.out.with_name(args.out.name + ".tmp")
    try:
        write_pack(sentences, words, args.audio_dir, tmp, args.title)
        # 3. 開き直して確認
        actual, problems = verify_pack(tmp)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise
    if problems:
        for p in problems:
            print(f"エラー: {p}")
        tmp.unlink(missing_ok=True)
        print("作った zip の確認で問題が見つかったため、出力していません。")
        return 1

    # 4. 既存のファイルは日時つきの名前で残してから置き換える
    if args.out.exists():
        bak = backup_path(args.out)
        args.out.rename(bak)
        print(f"既存のファイルを残しました: {bak}")
    tmp.rename(args.out)

    print(f"確認 OK: sentences {actual['sentences']} 件 / words {actual['words']} 件 / "
          f"audio {actual['audio']} 本（pack.json の counts と一致、mp3 は STORED）")
    print(f"出力: {args.out}（{format_size(args.out.stat().st_size)}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
