#!/usr/bin/env python3
"""
Cloudflare Workers / Pages / Vercel 向けの静的配信ディレクトリ (dist) を生成するスクリプト。
"""
import os
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
DATA_DIR = ROOT / "data"
TEMPLATES_DIR = ROOT / "templates"
STATIC_DIR = ROOT / "static"


def build():
    if DIST.exists():
        shutil.rmtree(DIST)
    DIST.mkdir(parents=True, exist_ok=True)

    # HTML テンプレートの配置
    for name in ["index.html", "admin.html", "notfound.html"]:
        src = TEMPLATES_DIR / name
        if src.exists():
            shutil.copy(src, DIST / name)

    shutil.copy(TEMPLATES_DIR / "admin.html", DIST / "index.html")

    # 静的アセット (static)
    if STATIC_DIR.exists():
        shutil.copytree(STATIC_DIR, DIST / "static")

    # 閲覧用ビューアー HTML
    viewer_html = (TEMPLATES_DIR / "viewer.html").read_text("utf-8")
    (DIST / "viewer").mkdir(parents=True, exist_ok=True)
    (DIST / "viewer" / "index.html").write_text(viewer_html, "utf-8")

    # 各サンプルトークンのページ・モデルデータを配置
    if DATA_DIR.exists():
        for token_dir in DATA_DIR.iterdir():
            if not token_dir.is_dir():
                continue
            p_dir = DIST / "p" / token_dir.name
            p_dir.mkdir(parents=True, exist_ok=True)

            # /p/<token>/ -> index.html (viewer.html)
            (p_dir / "index.html").write_text(viewer_html, "utf-8")

            # manifest.json
            manifest_src = token_dir / "manifest.json"
            if manifest_src.exists():
                shutil.copy(manifest_src, p_dir / "manifest.json")

            # /p/<token>/files/...
            files_dir = p_dir / "files"
            files_dir.mkdir(parents=True, exist_ok=True)
            for item in token_dir.iterdir():
                if item.is_file() and item.name not in {"manifest.json", "meta.json"}:
                    shutil.copy(item, files_dir / item.name)

    print("dist build completed successfully.")


if __name__ == "__main__":
    build()
