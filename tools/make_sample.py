#!/usr/bin/env python3
"""
動作確認用のサンプルレイヤーを生成し、data/ にプロジェクトとして登録する。
（Python 標準ライブラリのみ）

    python3 tools/make_sample.py            # sample/ に PNG + config.json を出力
    python3 tools/make_sample.py --install  # さらに data/ に登録して共有URLを表示
"""
import argparse
import json
import math
import random
import secrets
import shutil
import struct
import sys
import time
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
W, H = 900, 600


def write_png(path: Path, w: int, h: int, pixels, channels: int):
    """pixels: bytes-like (row-major, channels per pixel)"""
    color_type = {1: 0, 3: 2, 4: 6}[channels]
    raw = bytearray()
    stride = w * channels
    for y in range(h):
        raw.append(0)
        raw += pixels[y * stride:(y + 1) * stride]

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, color_type, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    path.write_bytes(png)


def smoothstep(e0, e1, x):
    t = max(0.0, min(1.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)


def hsv(h, s, v):
    i = int(h * 6) % 6
    f = h * 6 - int(h * 6)
    p, q, t = v * (1 - s), v * (1 - f * s), v * (1 - (1 - f) * s)
    return [(v, t, p), (q, v, p), (p, v, t), (p, q, v), (t, p, v), (v, p, q)][i]


def generate(out: Path):
    out.mkdir(parents=True, exist_ok=True)
    random.seed(3)
    base = bytearray(W * H)
    tex = bytearray(W * H)
    var = bytearray(W * H)
    col = bytearray(W * H * 3)

    flowers = [(0.30, 0.50, 0.20), (0.70, 0.42, 0.15), (0.60, 0.78, 0.09)]
    sc = min(W, H)
    for y in range(H):
        for x in range(W):
            u, v = x / W, y / H
            # 背景色（淡いグラデーション）
            r, g, b = 0.96 - 0.10 * v, 0.93 - 0.05 * u, 0.86 + 0.08 * v
            hval = 0.0
            tval = 0.0
            gloss = 0.0
            for (cx, cy, rad) in flowers:
                dx, dy = (x - cx * W) / sc, (y - cy * H) / sc
                d = math.hypot(dx, dy)
                ang = math.atan2(dy, dx)
                petal_r = rad * (0.62 + 0.38 * abs(math.cos(ang * 2.5)))
                if d < petal_r:
                    k = d / petal_r
                    petal = math.sqrt(max(0.0, 1 - k * k))  # ドーム状
                    center = smoothstep(0.32, 0.18, k)
                    hv = 0.55 * petal + 0.45 * center
                    if hv > hval:
                        hval = hv
                        if k < 0.25:
                            r, g, b = hsv(0.13, 0.85, 0.95)
                            tval = 0.5 + 0.5 * math.sin(x * 0.9) * math.sin(y * 0.9)  # 花芯のつぶつぶ
                            gloss = 1.0
                        else:
                            r, g, b = hsv(0.92 + 0.08 * k, 0.55 + 0.35 * k, 0.95)
                            tval = 0.5 + 0.5 * math.cos(ang * 40)  # 花びらの筋
                            gloss = 0.0
            # 葉っぱ（茎）
            stem = abs((x / W - 0.30) - 0.08 * math.sin(v * 5)) * W
            if v > 0.68 and stem < 6:
                hv = 0.35 * (1 - stem / 6)
                if hv > hval:
                    hval = hv
                    r, g, b = 0.30, 0.60, 0.25
            if hval == 0.0:
                tval = 0.15 * random.random()  # 背景の紙目
            i = y * W + x
            base[i] = int(255 * min(1.0, hval))
            tex[i] = int(255 * tval)
            var[i] = int(255 * gloss)
            col[i * 3:i * 3 + 3] = bytes(int(255 * max(0, min(1, c))) for c in (r, g, b))

    write_png(out / "base.png", W, H, base, 1)
    write_png(out / "texture.png", W, H, tex, 1)
    write_png(out / "varnish.png", W, H, var, 1)
    write_png(out / "color.png", W, H, col, 3)
    write_png(out / "original.png", W, H, col, 3)
    config = {
        "title": "サンプル：花の厚盛りサイン",
        "size_mm": {"width": 450, "height": 300},
        "white_is_high": True,
        "board": {"thickness_mm": 3, "color": "#fafafa"},
        "layers": {
            "base": {"ink": "White", "density_percent": 900, "passes": 9, "max_height_mm": 1.5},
            "texture": {"ink": "White", "density_percent": 200, "passes": 2, "max_height_mm": 0.25},
            "color": {"ink": "CMYK", "density_percent": 100, "passes": 1},
            "varnish": {"ink": "Gloss", "density_percent": 200, "passes": 2, "max_height_mm": 0.05},
        },
        "note": "サンプルデータです。",
    }
    (out / "config.json").write_text(json.dumps(config, ensure_ascii=False, indent=2), "utf-8")
    return config


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "sample"))
    ap.add_argument("--install", action="store_true")
    args = ap.parse_args()
    out = Path(args.out)
    print("generating sample…", file=sys.stderr)
    config = generate(out)
    print(f"wrote {out}")
    if args.install:
        token = secrets.token_urlsafe(24)
        d = ROOT / "data" / token
        d.mkdir(parents=True)
        for f in out.iterdir():
            shutil.copy(f, d / f.name)
        (d / "meta.json").write_text(json.dumps(
            {"title": config["title"], "created_at": time.time(), "expires_at": None}, ensure_ascii=False), "utf-8")
        print(f"/p/{token}")


if __name__ == "__main__":
    main()
