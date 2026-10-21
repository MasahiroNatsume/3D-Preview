#!/usr/bin/env python3
"""
Blender ファイル (output_fixed.blend) からオブジェクトを抽出し、
リンクごとに1個のプレビューが表示されるようにプロジェクトを登録・発行するツール。

使い方:
    # デフォルト: sample_00_2_after_ft を1個抽出して登録し、共有URLを発行
    python3 tools/import_blend.py

    # 特定のオブジェクト名を指定して登録
    python3 tools/import_blend.py --object sample_02_2_after_ft

    # blend内の全サンプル（sample_00〜04の各after_ft）をそれぞれ個別リンクとして一括登録
    python3 tools/import_blend.py --all
"""
import argparse
import json
import os
import secrets
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DEFAULT_BLEND = Path("/Users/kana/Downloads/output_fixed_hightmap_estimation/output_fixed.blend")
BLENDER_BIN = "/Applications/Blender.app/Contents/MacOS/Blender"

LABEL_MAP = {
    "sample_00_2_after_ft": "サンプル 00（高さ推定モデル：ファインチューニング後）",
    "sample_01_2_after_ft": "サンプル 01（高さ推定モデル：ファインチューニング後）",
    "sample_02_2_after_ft": "サンプル 02（高さ推定モデル：ファインチューニング後）",
    "sample_03_2_after_ft": "サンプル 03（高さ推定モデル：ファインチューニング後）",
    "sample_04_2_after_ft": "サンプル 04（高さ推定モデル：ファインチューニング後）",
}


def export_object(blend_path: Path, object_name: str, out_dir: Path) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    glb_path = out_dir / "model.glb"
    obj_path = out_dir / "model.obj"
    info_json_path = out_dir / "_export_info.json"

    blender_script = f"""
import bpy, os, json

target_name = {json.dumps(object_name)}
if target_name not in bpy.data.objects:
    raise ValueError(f"Object '{{target_name}}' not found in blend file")

# 全オブジェクト非選択
bpy.ops.object.select_all(action='DESELECT')
obj = bpy.data.objects[target_name]
obj.select_set(True)
bpy.context.view_layer.objects.active = obj

# 原点に移動してエクスポート
orig_loc = list(obj.location)
orig_rot = list(obj.rotation_euler)
obj.location = (0, 0, 0)

glb_out = {json.dumps(str(glb_path))}
bpy.ops.export_scene.gltf(filepath=glb_out, use_selection=True, export_format='GLB')

obj_out = {json.dumps(str(obj_path))}
try:
    bpy.ops.wm.obj_export(filepath=obj_out, export_selected_objects=True)
except Exception:
    bpy.ops.export_scene.obj(filepath=obj_out, use_selection=True)

# 元に戻す
obj.location = orig_loc

info = {{
    "name": target_name,
    "dimensions": list(obj.dimensions),
    "vertices": len(obj.data.vertices),
    "faces": len(obj.data.polygons),
}}
with open({json.dumps(str(info_json_path))}, "w") as f:
    json.dump(info, f)
"""
    cmd = [BLENDER_BIN, "-b", str(blend_path), "--python-expr", blender_script]
    res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if res.returncode != 0:
        print(f"Blender export failed:\n{res.stderr}\n{res.stdout}", file=sys.stderr)
        raise RuntimeError("Blender export failed")

    info = json.loads(info_json_path.read_text("utf-8"))
    info_json_path.unlink(missing_ok=True)
    return info


def register_project(object_name: str, blend_path: Path) -> tuple[str, str]:
    token = secrets.token_urlsafe(24)
    target_dir = DATA_DIR / token
    info = export_object(blend_path, object_name, target_dir)

    title = LABEL_MAP.get(object_name, f"厚盛りサンプル（{object_name}）")
    meta = {
        "title": title,
        "object_name": object_name,
        "created_at": time.time(),
        "expires_at": None,
    }
    (target_dir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), "utf-8")

    # config.json: 寸法や注記
    dims = info.get("dimensions", [1.0, 1.0, 0.06])
    config = {
        "title": title,
        "size_mm": {
            "width": 300,
            "height": round(300 * (dims[1] / dims[0]), 1) if dims[0] else 300,
        },
        "model_file": "model.glb",
        "board": {"thickness_mm": 3, "color": "#fafafa"},
        "note": f"Blenderオブジェクト '{object_name}' より自動生成。頂点数: {info.get('vertices'):,} / 面数: {info.get('faces'):,}",
    }
    (target_dir / "config.json").write_text(json.dumps(config, ensure_ascii=False, indent=2), "utf-8")

    url = f"/p/{token}"
    return token, url


def main():
    parser = argparse.ArgumentParser(description="Export Blender objects into isolated preview share links")
    parser.add_argument("--blend", default=str(DEFAULT_BLEND), help="Path to .blend file")
    parser.add_argument("--object", default="sample_00_2_after_ft", help="Single object name to export")
    parser.add_argument("--all", action="store_true", help="Export all after_ft samples as separate links")
    args = parser.parse_args()

    blend_path = Path(args.blend)
    if not blend_path.is_file():
        print(f"Error: Blend file not found at {blend_path}", file=sys.stderr)
        sys.exit(1)

    if args.all:
        targets = [f"sample_0{i}_2_after_ft" for i in range(5)]
        print(f"Exporting {len(targets)} objects from {blend_path.name} as separate links...\n")
        for t in targets:
            print(f"[*] Processing {t}...")
            token, url = register_project(t, blend_path)
            print(f"    Title: {LABEL_MAP.get(t, t)}")
            print(f"    Link : {url}  (Token: {token})\n")
    else:
        print(f"[*] Processing single object: {args.object} from {blend_path.name}...")
        token, url = register_project(args.object, blend_path)
        print(f"\n[OK] 登録完了！ 1オブジェクト専用の共有プレビューを発行しました:")
        print(f"    オブジェクト名: {args.object}")
        print(f"    共有リンク    : {url}")
        print(f"    トークン      : {token}")


if __name__ == "__main__":
    main()
