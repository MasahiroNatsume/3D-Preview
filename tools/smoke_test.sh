#!/bin/zsh
# サーバーを起動して主要エンドポイントを検証する簡易テスト
cd "$(dirname "$0")/.."
export NO_PROXY='*' no_proxy='*'
ADMIN_PASSWORD=test1234 python3 server.py --port 8765 >/tmp/atsumori-test.log 2>&1 &
PID=$!
sleep 1
B=http://127.0.0.1:8765
T=$(ls data | head -1)
code() { curl -s --noproxy '*' --path-as-is -o /dev/null -w "%{http_code}" "$@"; }
check() { [[ "$2" == "$3" ]] && echo "OK   $1 ($2)" || echo "FAIL $1 (got $2, want $3)"; }
check "landing" $(code $B/) 200
check "viewer" $(code $B/p/$T) 200
check "manifest" $(code $B/p/$T/manifest.json) 200
check "layer file" $(code $B/p/$T/files/base.png) 200
check "unknown token" $(code $B/p/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA) 404
check "meta.json hidden" $(code $B/p/$T/files/meta.json) 404
check "static traversal" $(code "$B/static/../server.py") 404
check "admin no auth" $(code $B/admin) 401
check "admin wrong pw" $(code -u admin:nope $B/admin) 401
check "admin ok" $(code -u admin:test1234 $B/admin) 200
R=$(curl -s --noproxy '*' -u admin:test1234 -X POST -H 'Content-Type: application/json' -d '{"title":"テスト","expires_days":1}' $B/api/admin/projects)
NT=$(echo $R | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
check "upload png" $(code -u admin:test1234 -X PUT --data-binary @sample/base.png $B/api/admin/projects/$NT/files/base.png) 200
check "reject non-image" $(code -u admin:test1234 -X PUT --data-binary hello $B/api/admin/projects/$NT/files/color.png) 400
check "reject bad name" $(code -u admin:test1234 -X PUT --data-binary @sample/base.png $B/api/admin/projects/$NT/files/evil.html) 404
check "new viewer" $(code $B/p/$NT) 200
check "delete" $(code -u admin:test1234 -X DELETE $B/api/admin/projects/$NT) 200
check "deleted gone" $(code $B/p/$NT) 404
echo "--- headers"
curl -sI --noproxy '*' $B/p/$T | grep -iE 'robots|referrer|cache'
curl -s --noproxy '*' $B/p/$T/manifest.json; echo
kill $PID
