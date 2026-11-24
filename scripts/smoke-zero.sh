#!/usr/bin/env bash
# 合計0円(クーポンで全額引き)の会計のスモークテスト。
# 前提: ローカルで `vite preview --port 4173` が動いていて、DBが空(migration 適用直後)であること。
BASE=${BASE:-http://127.0.0.1:4173}
SETUP_TOKEN=${SETUP_TOKEN:-local-setup-token-for-testing}
TMP=$(mktemp -d)
pass=0; fail=0
cd "$(dirname "$0")/.." || exit 1

req() { # req <jar> <METHOD> <path> [json]
  local jar=$1 method=$2 path=$3 body=${4:-}
  local args=(-s -o "$TMP/body" -w '%{http_code}' -X "$method" -b "$jar" -c "$jar" -H "Origin: $BASE")
  [ -n "$body" ] && args+=(-H 'content-type: application/json' --data "$body")
  curl "${args[@]}" "$BASE$path" > "$TMP/code"
}
code() { cat "$TMP/code"; }
body() { cat "$TMP/body"; }
jget() { python3 -I -c "import sys,json;d=json.load(open('$TMP/body'));print(eval('d'+sys.argv[1]))" "$1"; }
check() { if [ "$(code)" = "$2" ]; then pass=$((pass+1)); echo "  ok   $1 ($2)"; else fail=$((fail+1)); echo "  FAIL $1: expected $2 got $(code): $(body | head -c 300)"; fi; }
expect() { # expect <name> <expected> <actual>
  if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "  ok   $1 ($3)"; else fail=$((fail+1)); echo "  FAIL $1: expected '$2' got '$3'"; fi
}
sql() { npx wrangler d1 execute DB --local --json --command "$1" 2>/dev/null | python3 -I -c "import json,sys;r=json.load(sys.stdin)[0]['results'];print(json.dumps(r))"; }
sqlv() { sql "$1" | python3 -I -c "import json,sys;r=json.load(sys.stdin);print(list(r[0].values())[0] if r else '')"; }
rid() { python3 -I -c "import uuid;print(uuid.uuid4().hex)"; }
myBalance() { req "$1" GET /api/auth/me; jget "['wallet']['balance']"; }
newQr() { req "$1" POST /api/wallet/qr '{}'; jget "['token']"; }
lookup() { req "$1" POST /api/reception/lookup "{\"token\":\"$2\"}"; }


ADMIN=$TMP/admin.jar; ALICE=$TMP/alice.jar; R1=$TMP/r1.jar; R2=$TMP/r2.jar; MGR=$TMP/mgr.jar; MGR2=$TMP/mgr2.jar; MGRB=$TMP/mgrb.jar; CLERK=$TMP/clerk.jar; ANON=$TMP/anon.jar; BOB=$TMP/bob.jar
items() { python3 -I -c "
import json,sys
a=sys.argv[1:]
print(json.dumps([{'productId':a[i],'quantity':int(a[i+1])} for i in range(0,len(a),2)]))" "$@"; }
charge() { local q; q=$(newQr "$2"); lookup "$1" "$q"; local l; l=$(jget "['lookupId']")
  req "$1" POST /api/reception/charge "{\"lookupId\":\"$l\",\"requestId\":\"$(rid)\",\"cashAmount\":$3}"; }
NOW=$(python3 -I -c "import time;print(int(time.time()*1000))")
echo "== 準備 =="
req $ADMIN POST /api/setup/admin '{"loginId":"admin","password":"adminpass1","nickname":"運営"}' 2>/dev/null
curl -s -o /dev/null -X POST -H "Origin: $BASE" -H 'content-type: application/json' -H "x-setup-token: $SETUP_TOKEN" -c $ADMIN --data '{"loginId":"admin","password":"adminpass1","nickname":"運営"}' $BASE/api/setup/admin
req $ADMIN POST /api/auth/login '{"loginId":"admin","password":"adminpass1"}'
req $ADMIN POST /api/admin/shops '{"name":"3A 焼きそば","displayName":"3A 焼きそば"}'; SA=$(jget "['shop']['id']")
req $ADMIN POST /api/admin/shops '{"name":"3B たこ焼き","displayName":"3B たこ焼き"}'; SB=$(jget "['shop']['id']")
req $ADMIN POST /api/admin/users/shop-manager "{\"shopId\":\"$SA\",\"loginId\":\"mgr-a\",\"password\":\"mgrpass123\",\"nickname\":\"A責任者\"}"
req $ADMIN POST /api/admin/users/shop-manager "{\"shopId\":\"$SB\",\"loginId\":\"mgr-b\",\"password\":\"mgrpass123\",\"nickname\":\"B責任者\"}"
req $MGR POST /api/auth/login '{"loginId":"mgr-a","password":"mgrpass123"}'
req $MGRB POST /api/auth/login '{"loginId":"mgr-b","password":"mgrpass123"}'
req $MGR POST /api/shops/$SA/staff '{"loginId":"clerk-a","password":"clerkpass1","nickname":"A店員"}'
req $CLERK POST /api/auth/login '{"loginId":"clerk-a","password":"clerkpass1"}'
req $ADMIN POST /api/admin/users/reception '{"nickname":"受付A","loginId":"recep-a","password":"recepass123"}'
req $R1 POST /api/auth/login '{"loginId":"recep-a","password":"recepass123"}'
P='"saleMode":"BOTH","discountable":true,"sortOrder":1,"tagIds":[],"trackStock":false'
req $MGR POST /api/catalog/$SA/products "{\"name\":\"焼きそば\",\"price\":400,$P}"; YAKI=$(jget "['id']")
req $ALICE POST /api/auth/register '{"email":"alice@example.com","password":"alicepass123","nickname":"アリス"}'; check "お客様登録(アリス)" 201
req $BOB POST /api/auth/register '{"email":"bob@example.com","password":"bobpass12345","nickname":"ボブ"}'; check "お客様登録(ボブ)" 201
charge $R1 $ALICE 20000; check "チャージ(アリス)" 201
charge $R1 $BOB 20000; check "チャージ(ボブ)" 201
scanC() { # scanC <customerJar> <couponCode>
  QR=$(newQr "$1")
  req $CLERK POST /api/pos/$SA/pay/scan "{\"token\":\"$QR\",\"items\":$(items $YAKI 1),\"couponCode\":\"$2\"}"; }
commit() { local s; s=$(jget "['sessionId']"); local t; t=$(jget "['quote']['total']")
  req $CLERK POST /api/pos/$SA/pay/$s/commit "{\"requestId\":\"$(rid)\",\"expectedTotal\":$t}"; ORDER=$(jget "['orderId']"); CALLNO=$(jget "['callNo']"); }
status() { req $CLERK POST /api/orders/$SA/$1/status "{\"status\":\"$2\"}"; }


mkcoupon() { req $ADMIN POST /api/discounts/coupons "{\"name\":\"クーポン$2\",\"kind\":\"$1\",\"code\":\"$2\",\"count\":1,\"method\":\"$3\",\"value\":$4,\"minOrderAmount\":null,\"maxDiscountAmount\":null,\"startsAt\":null,\"endsAt\":null,\"shopIds\":[],\"totalLimit\":$5,\"perWalletLimit\":$6,\"combinableWithAuto\":true,\"note\":null}"; }
echo "== 合計0円 =="
req $MGR PUT /api/shops/$SA/options '{"orderTracking":true,"callBoard":true}'; check "注文ステータスをオン" 200
mkcoupon COMMON FREE100 PERCENT 100 null 1; check "全額引きのクーポン(1人1回)" 201
B0=$(myBalance $ALICE)
scanC $ALICE FREE100; check "合計0円でもQRを読み取れる" 200
S=$(jget "['sessionId']"); expect "見積もりの合計は0" 0 "$(jget "['quote']['total']")"
req $CLERK POST /api/pos/$SA/pay/$S/commit "{\"requestId\":\"$(rid)\",\"expectedTotal\":0}"; check "確定できる" 200
O0=$(jget "['orderId']")
expect "支払額0" 0 "$(jget "['total']")"
expect "割引後の合計 0 / 小計 400" 400 "$(jget "['subtotal']")"
expect "呼び出し番号が付く" 1 "$(jget "['callNo']")"
expect "結果の残高は今の残高" "$B0" "$(jget "['balanceAfter']")"
expect "残高は動かない" "$B0" "$(myBalance $ALICE)"
expect "台帳は増えない" 0 "$(sqlv "SELECT COUNT(*) FROM wallet_ledger WHERE kind='PAYMENT'")"
expect "注文は記録される" "0|PAID|400" "$(sqlv "SELECT total_paid||'|'||status||'|'||subtotal FROM orders WHERE id='$O0'")"
expect "クーポンは使用済みになる" 1 "$(sqlv "SELECT COUNT(*) FROM coupon_redemptions WHERE order_id='$O0' AND status='USED'")"
expect "監査に残る" 1 "$(sqlv "SELECT COUNT(*) FROM audit_logs WHERE action='payment.commit' AND target_id='$O0'")"
req $CLERK POST /api/pos/$SA/pay/$S/commit "{\"requestId\":\"$(rid)\",\"expectedTotal\":0}"; check "同じ決済の2重確定は409" 409
scanC $ALICE FREE100; check "1人1回の上限を超えると断られる" 409
req $ALICE GET /api/wallet/active-orders; expect "0円の注文もスマホの受け取り待ちに出る" 1 "$(jget "['orders'].__len__()")"
req $ANON GET /api/public/shops/$SA/board; expect "ボードにも出る" "['1']" "$(jget "['preparing']")"
req $CLERK GET /api/orders/$SA/active; expect "店員の一覧にも出る" 1 "$(jget "['orders'].__len__()")"
req $CLERK POST /api/orders/$SA/$O0/status '{"status":"READY"}'; check "提供可能にできる" 200
req $CLERK POST /api/orders/$SA/$O0/status '{"status":"DONE"}'; check "受け渡し済みにできる" 200
req $ALICE GET /api/wallet/history; expect "利用履歴に0円は出ない(残高が動かないため)" 1 "$(jget "['items'].__len__()")"
req $CLERK POST /api/orders/$SA/$O0/cancel "{\"requestId\":\"$(rid)\",\"reason\":\"テスト\",\"restoreStock\":false}"; echo "  (0円の注文の取消しは $(code))"
expect "0円の注文は取り消せない(400系)" 1 "$([ "$(code)" -ge 400 ] && [ "$(code)" -lt 500 ] && echo 1 || echo 0)"
# 0円でないクーポン(一部引き)は従来どおり
mkcoupon COMMON HALF PERCENT 50 null null; check "半額クーポン" 201
scanC $BOB HALF; check "半額は従来どおり" 200
req $CLERK POST /api/pos/$SA/pay/$(jget "['sessionId']")/commit "{\"requestId\":\"$(rid)\",\"expectedTotal\":200}"; check "200円を決済" 200
expect "残高が200減る" 19800 "$(myBalance $BOB)"

echo
echo "結果: pass=$pass fail=$fail"
[ "$fail" = 0 ]
