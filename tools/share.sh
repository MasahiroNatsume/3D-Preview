#!/bin/bash
# 手元のMacから直接外部公開URLを発行するスクリプト（完全無料・登録不要）
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

# 既存プロセスがあれば停止
pkill -f "server.py" 2>/dev/null
pkill -f "cloudflared tunnel --url http://127.0.0.1:8000" 2>/dev/null
lsof -ti:8000 | xargs kill -9 2>/dev/null || true
sleep 1

echo "Starting local server on port 8000..."
ADMIN_PASSWORD=yamatesign python3 server.py --port 8000 > /tmp/atsumori-server.log 2>&1 &
SERVER_PID=$!
sleep 1

echo "Connecting to Cloudflare Tunnel..."
if [ ! -f "$DIR/cloudflared" ]; then
  echo "Downloading cloudflared..."
  ARCH=$(uname -m)
  CF_ARCH="arm64"
  if [ "$ARCH" = "x86_64" ]; then CF_ARCH="amd64"; fi
  curl -sL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${CF_ARCH}.tgz" | tar -xz -C "$DIR"
  chmod +x "$DIR/cloudflared"
fi
"$DIR/cloudflared" tunnel --url http://127.0.0.1:8000 > /tmp/tunnel.log 2>&1 &
TUNNEL_PID=$!

for i in {1..30}; do
  URL=$(grep -o 'https://[-a-zA-Z0-9.]*\.trycloudflare\.com' /tmp/tunnel.log | head -1)
  if [ -n "$URL" ]; then
    echo ""
    echo "=========================================================="
    echo "  🎉 公開URLが発行されました！"
    echo "  Base URL: $URL"
    echo "=========================================================="
    echo ""
    echo "各サンプルのURL:"
    echo "  サンプル 00: $URL/p/kwkGw3IvwxWs3EgcBdQRBA1W_XXVhZux"
    echo "  サンプル 01: $URL/p/ajw8w5YpMoazNXkzmakvsbrlAm28Crm3"
    echo "  サンプル 02: $URL/p/rBsNDFJyat_avdaeomDdQ01ajvQ4ZNnU"
    echo "  サンプル 03: $URL/p/gm2lX8IUDWfiU9l5WQQk6RiK3wi0vWVW"
    echo "  サンプル 04: $URL/p/dOw0yRZy0nk_C_jkqzw31Iq-435u0uSR"
    echo "  管理画面   : $URL/admin (user: admin / pass: yamatesign)"
    echo "=========================================================="
    break
  fi
  sleep 1
done
