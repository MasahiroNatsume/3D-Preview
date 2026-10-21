#!/usr/bin/env python3
"""
厚盛り印刷 3D プレビュー サーバー（Python 標準ライブラリのみ）

- /admin                 : 管理画面（Basic 認証）。レイヤー画像をアップロードして共有リンクを発行
- /p/<token>             : 共有リンク。トークンを知っている人だけが閲覧できる
- /p/<token>/files/<name>: 各レイヤー画像 / config.json

起動:
    ADMIN_PASSWORD=xxxx python3 server.py --port 8000
"""
from __future__ import annotations

import argparse
import base64
import hmac
import json
import mimetypes
import os
import re
import secrets
import shutil
import sys
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
TEMPLATE_DIR = ROOT / "templates"
DATA_DIR = Path(os.environ.get("DATA_DIR", ROOT / "data")).resolve()

ADMIN_USER = os.environ.get("ADMIN_USER", "admin")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD") or ""

MAX_UPLOAD_BYTES = int(os.environ.get("MAX_UPLOAD_MB", "200")) * 1024 * 1024

# 受け渡しファイル名（要件定義 3-5 に準拠）
LAYER_FILES = {
    "original": "original.png",
    "base": "base.png",
    "texture": "texture.png",
    "color": "color.png",
    "varnish": "varnish.png",
}
MODEL_FILES = {"model.glb", "model.gltf", "model.obj", "model.mtl"}
ALLOWED_FILES = set(LAYER_FILES.values()) | {"config.json"} | MODEL_FILES

# token_urlsafe(24) -> 32 文字（192bit）。推測は事実上不可能
TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{32}$")

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
JPEG_MAGIC = b"\xff\xd8\xff"
WEBP_MAGIC = b"RIFF"
GLB_MAGIC = b"glTF"

COMMON_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",  # 共有URLが外部サイトへ漏れないように
    "X-Frame-Options": "SAMEORIGIN",
}
PRIVATE_HEADERS = {
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "Cache-Control": "private, no-store",
}


def project_dir(token: str) -> Path | None:
    if not TOKEN_RE.match(token):
        return None
    d = DATA_DIR / token
    return d if (d / "meta.json").is_file() else None


def read_meta(d: Path) -> dict:
    return json.loads((d / "meta.json").read_text("utf-8"))


def write_meta(d: Path, meta: dict) -> None:
    tmp = d / "meta.json.tmp"
    tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=2), "utf-8")
    tmp.replace(d / "meta.json")


def is_expired(meta: dict) -> bool:
    exp = meta.get("expires_at")
    return bool(exp) and time.time() > float(exp)


class Handler(BaseHTTPRequestHandler):
    server_version = "AtsumoriPreview/1.0"
    protocol_version = "HTTP/1.1"

    # ------------------------------------------------------------------ utils
    def log_message(self, fmt, *args):  # トークンをログに残しすぎないよう短縮
        msg = fmt % args
        msg = re.sub(r"/p/([A-Za-z0-9_-]{6})[A-Za-z0-9_-]{26}", r"/p/\1…", msg)
        sys.stderr.write(f"[{self.log_date_time_string()}] {msg}\n")

    def send_bytes(self, body: bytes, ctype: str, status=200, extra: dict | None = None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in {**COMMON_HEADERS, **(extra or {})}.items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_json(self, obj, status=200):
        self.send_bytes(json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                        "application/json; charset=utf-8", status, PRIVATE_HEADERS)

    def send_file(self, path: Path, extra: dict | None = None):
        if not path.is_file():
            return self.not_found()
        ctype = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        size = path.stat().st_size
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(size))
        for k, v in {**COMMON_HEADERS, **(extra or {})}.items():
            self.send_header(k, v)
        self.end_headers()
        if self.command == "HEAD":
            return
        with path.open("rb") as f:
            shutil.copyfileobj(f, self.wfile, 1024 * 256)

    def render(self, name: str, ctx: dict | None = None, status=200, extra=None):
        html = (TEMPLATE_DIR / name).read_text("utf-8")
        for k, v in (ctx or {}).items():
            html = html.replace("{{" + k + "}}", v)
        self.send_bytes(html.encode("utf-8"), "text/html; charset=utf-8", status,
                        {**PRIVATE_HEADERS, **(extra or {})})

    def not_found(self):
        self.render("notfound.html", status=404)

    def read_body(self) -> bytes | None:
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_UPLOAD_BYTES:
            self.send_json({"error": "ファイルが大きすぎます"}, 413)
            return None
        return self.rfile.read(length) if length else b""

    def check_admin(self) -> bool:
        auth = self.headers.get("Authorization", "")
        if auth.startswith("Basic "):
            try:
                user, _, pw = base64.b64decode(auth[6:]).decode("utf-8").partition(":")
                if hmac.compare_digest(user, ADMIN_USER) and hmac.compare_digest(pw, ADMIN_PASSWORD):
                    return True
            except Exception:
                pass
        body = b"Authentication required"
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="Atsumori Preview Admin", charset="UTF-8"')
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        return False

    # ---------------------------------------------------------------- routing
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        path = unquote(urlparse(self.path).path)

        if path == "/" or path == "/index.html":
            return self.render("index.html")

        if path.startswith("/static/"):
            rel = path[len("/static/"):]
            target = (STATIC_DIR / rel).resolve()
            if STATIC_DIR not in target.parents:
                return self.not_found()
            return self.send_file(target, {"Cache-Control": "public, max-age=300"})

        if path == "/robots.txt":
            return self.send_bytes(b"User-agent: *\nDisallow: /\n", "text/plain")

        # ---- 共有リンク
        m = re.match(r"^/p/([^/]+)/?$", path)
        if m:
            d = project_dir(m.group(1))
            if not d:
                return self.not_found()
            meta = read_meta(d)
            if is_expired(meta):
                return self.render("notfound.html", status=410)
            title = (meta.get("title") or "厚盛り印刷プレビュー")
            safe_title = (title.replace("&", "&amp;").replace("<", "&lt;")
                          .replace(">", "&gt;").replace('"', "&quot;"))
            return self.render("viewer.html", {"TITLE": safe_title})

        m = re.match(r"^/p/([^/]+)/files/([^/]+)$", path)
        if m:
            d = project_dir(m.group(1))
            name = m.group(2)
            if not d or name not in ALLOWED_FILES or is_expired(read_meta(d)):
                return self.not_found()
            return self.send_file(d / name, PRIVATE_HEADERS)

        m = re.match(r"^/p/([^/]+)/manifest\.json$", path)
        if m:
            d = project_dir(m.group(1))
            if not d:
                return self.not_found()
            meta = read_meta(d)
            if is_expired(meta):
                return self.not_found()
            resp = {
                "title": meta.get("title", ""),
                "files": {k: f"files/{v}" for k, v in LAYER_FILES.items() if (d / v).is_file()},
                "config": "files/config.json" if (d / "config.json").is_file() else None,
            }
            for mf in ("model.glb", "model.gltf", "model.obj"):
                if (d / mf).is_file():
                    resp["model"] = f"files/{mf}"
                    break
            return self.send_json(resp)

        # ---- 管理
        if path in ("/admin", "/admin/"):
            if not self.check_admin():
                return
            return self.render("admin.html")

        if path == "/api/admin/projects":
            if not self.check_admin():
                return
            items = []
            if DATA_DIR.is_dir():
                for d in DATA_DIR.iterdir():
                    if d.is_dir() and (d / "meta.json").is_file():
                        meta = read_meta(d)
                        items.append({
                            "token": d.name,
                            "title": meta.get("title", ""),
                            "created_at": meta.get("created_at"),
                            "expires_at": meta.get("expires_at"),
                            "files": sorted(p.name for p in d.iterdir() if p.name in ALLOWED_FILES),
                        })
            items.sort(key=lambda x: x.get("created_at") or 0, reverse=True)
            return self.send_json({"projects": items})

        return self.not_found()

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/admin/projects":
            if not self.check_admin():
                return
            body = self.read_body()
            if body is None:
                return
            try:
                data = json.loads(body or b"{}")
            except json.JSONDecodeError:
                return self.send_json({"error": "invalid json"}, 400)
            token = secrets.token_urlsafe(24)
            d = DATA_DIR / token
            d.mkdir(parents=True, exist_ok=False)
            expires_days = data.get("expires_days")
            meta = {
                "title": str(data.get("title") or "")[:200],
                "created_at": time.time(),
                "expires_at": (time.time() + float(expires_days) * 86400) if expires_days else None,
            }
            write_meta(d, meta)
            return self.send_json({"token": token, "url": f"/p/{token}"}, 201)
        return self.not_found()

    def do_PUT(self):
        path = urlparse(self.path).path
        m = re.match(r"^/api/admin/projects/([^/]+)/files/([^/]+)$", path)
        if not m:
            return self.not_found()
        if not self.check_admin():
            return
        d = project_dir(m.group(1))
        name = m.group(2)
        if not d or name not in ALLOWED_FILES:
            return self.send_json({"error": "not found"}, 404)
        body = self.read_body()
        if body is None:
            return
        if name == "config.json" or name.endswith(".gltf"):
            try:
                json.loads(body.decode("utf-8"))
            except Exception:
                return self.send_json({"error": f"{name} が不正な JSON です"}, 400)
        elif name.endswith(".glb"):
            if not body.startswith(GLB_MAGIC):
                return self.send_json({"error": "不正な GLB ファイルです"}, 400)
        elif name.endswith(".obj") or name.endswith(".mtl"):
            pass  # text file
        elif not (body.startswith(PNG_MAGIC) or body.startswith(JPEG_MAGIC) or body.startswith(WEBP_MAGIC)):
            return self.send_json({"error": "PNG / JPEG / WebP / GLB / OBJ のみアップロードできます"}, 400)
        tmp = d / (name + ".tmp")
        tmp.write_bytes(body)
        tmp.replace(d / name)
        return self.send_json({"ok": True, "name": name, "bytes": len(body)})

    def do_DELETE(self):
        path = urlparse(self.path).path
        m = re.match(r"^/api/admin/projects/([^/]+)$", path)
        if not m:
            return self.not_found()
        if not self.check_admin():
            return
        d = project_dir(m.group(1))
        if not d:
            return self.send_json({"error": "not found"}, 404)
        shutil.rmtree(d)
        return self.send_json({"ok": True})


def main():
    global ADMIN_PASSWORD
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8000")))
    args = ap.parse_args()

    mimetypes.add_type("application/javascript", ".js")
    mimetypes.add_type("text/css", ".css")
    mimetypes.add_type("model/gltf-binary", ".glb")
    mimetypes.add_type("model/gltf+json", ".gltf")
    mimetypes.add_type("text/plain", ".obj")
    mimetypes.add_type("text/plain", ".mtl")
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    if not ADMIN_PASSWORD:
        ADMIN_PASSWORD = secrets.token_urlsafe(12)
        print(f"[!] ADMIN_PASSWORD が未設定のため一時パスワードを生成しました: {ADMIN_PASSWORD}")

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Serving on http://{args.host}:{args.port}  (admin: /admin  user: {ADMIN_USER})")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
