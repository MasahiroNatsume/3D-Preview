#!/bin/zsh
# ヘッドレス Chrome でビューアーのスクリーンショットを撮る（目視確認用）
cd "$(dirname "$0")/.."
OUT=${1:-/tmp/atsumori-shot.png}
ADMIN_PASSWORD=test1234 python3 server.py --port 8765 >/tmp/atsumori-shot-server.log 2>&1 &
PID=$!
sleep 1
T=$(ls data | head -1)
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu-sandbox --use-angle=swiftshader --enable-unsafe-swiftshader \
  --window-size=1440,900 --virtual-time-budget=15000 --enable-logging=stderr --v=0 \
  --user-data-dir=/tmp/atsumori-chrome --screenshot="$OUT" "http://127.0.0.1:8765/p/$T" 2>&1 | grep -iE 'console|error|uncaught' | grep -v -iE 'gcm|dbus|registration|google_apis|sandbox' | head -20
kill $PID
echo "saved $OUT"
