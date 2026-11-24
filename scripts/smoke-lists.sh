#!/usr/bin/env bash
# 顧客のパスワード変更・利用履歴の検索・ユーザー一覧/カード一覧の検索(読み込み節約)のスモークテスト。
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



echo "== 顧客のパスワード変更 =="
req $ALICE POST /api/auth/change-password '{"currentPassword":"wrongpass1","newPassword":"newalicepass1"}'; check "現在のパスワードが違うと401" 401
req $ALICE POST /api/auth/change-password '{"currentPassword":"alicepass123","newPassword":"short"}'; check "8文字未満は400" 400
req $ANON POST /api/auth/change-password '{"currentPassword":"alicepass123","newPassword":"newalicepass1"}'; check "未ログインは401" 401
ALICE2=$TMP/alice2.jar
req $ALICE2 POST /api/auth/login '{"loginId":"alice@example.com","password":"alicepass123"}'; check "別の端末でログイン" 200
req $ALICE POST /api/auth/change-password '{"currentPassword":"alicepass123","newPassword":"newalicepass1"}'; check "変更できる" 200
req $ALICE GET /api/auth/me; check "いまの端末はログインしたまま" 200
req $ALICE2 GET /api/auth/me; check "ほかの端末はログアウトされる" 401
req $ANON POST /api/auth/login '{"loginId":"alice@example.com","password":"alicepass123"}'; check "古いパスワードでは入れない" 401
req $ANON POST /api/auth/login '{"loginId":"alice@example.com","password":"newalicepass1"}'; check "新しいパスワードで入れる" 200
expect "監査に残る" 1 "$(sqlv "SELECT COUNT(*) FROM audit_logs WHERE action='account.change_password'")"

echo "== 利用履歴の検索 =="
for i in 1 2 3; do charge $R1 $ALICE 100 >/dev/null; done
req $ALICE GET /api/wallet/history; check "履歴(既定)" 200; expect "既定は新しい順に全件" 4 "$(jget "['items'].__len__()")"
req $ALICE GET "/api/wallet/history?limit=2"; expect "2件ずつ" 2 "$(jget "['items'].__len__()")"; NEXT=$(jget "['next']")
req $ALICE GET "/api/wallet/history?limit=2&cursor=$NEXT"; expect "続き" 2 "$(jget "['items'].__len__()")"; expect "最後はnextなし" None "$(jget "['next']")"
req $ALICE GET "/api/wallet/history?kind=payment"; expect "お支払いは0件(まだ買っていない)" 0 "$(jget "['items'].__len__()")"
req $ALICE GET "/api/wallet/history?kind=charge"; expect "チャージ" 4 "$(jget "['items'].__len__()")"
req $ALICE GET "/api/wallet/history?kind=refund"; expect "返金・払い戻し" 0 "$(jget "['items'].__len__()")"
req $ALICE GET "/api/wallet/history?kind=bogus"; check "不正な種類は400" 400
req $ALICE GET "/api/wallet/history?limit=51"; check "51件は400" 400
req $ALICE GET "/api/wallet/history?to=1000"; expect "期間の終わりより前は0件" 0 "$(jget "['items'].__len__()")"
req $ALICE GET "/api/wallet/history?from=$NOW"; expect "期間の始まり以降" 4 "$(jget "['items'].__len__()")"
req $BOB GET /api/wallet/history; expect "他人の履歴は混ざらない" 1 "$(jget "['items'].__len__()")"

echo "== ユーザー一覧の検索 =="
req $ADMIN GET "/api/admin/users?role=CUSTOMER"; check "顧客一覧" 200; expect "顧客2人" 2 "$(jget "['users'].__len__()")"
req $ADMIN GET "/api/admin/users?limit=2"; expect "2件ずつ" 2 "$(jget "['users'].__len__()")"; expect "続きあり" True "$(python3 -I -c "import json;print(json.load(open('$TMP/body'))['next'] is not None)")"; N2=$(jget "['next']")
req $ADMIN GET "/api/admin/users?limit=2&cursor=$N2"; check "続き" 200
req $ADMIN GET "/api/admin/users?q=%E3%82%A2%E3%83%AA%E3%82%B9"; expect "表示名で検索" 1 "$(jget "['users'].__len__()")"
req $ADMIN GET "/api/admin/users?q=clerk-a"; expect "ログインIDで検索" 1 "$(jget "['users'].__len__()")"
req $ADMIN GET "/api/admin/users?q=3A"; expect "店舗名で検索(その店舗の責任者・店員)" 2 "$(jget "['users'].__len__()")"
req $ADMIN GET "/api/admin/users?q=%25"; expect "%は文字として扱う(全件にならない)" 0 "$(jget "['users'].__len__()")"
req $ADMIN GET "/api/admin/users?limit=101"; check "101件は400" 400
req $ADMIN GET "/api/admin/users?cursor=bad"; check "不正なカーソルは400" 400

echo "== カード一覧の検索 =="
req $ADMIN POST /api/cards/issue '{"count":3,"batch":"検索テスト"}'; check "カード3枚を発行" 201
req $ADMIN GET "/api/cards?limit=2"; check "カード一覧" 200; expect "2件ずつ" 2 "$(jget "['cards'].__len__()")"; expect "続きの位置" 2 "$(jget "['next']")"
req $ADMIN GET "/api/cards?limit=2&offset=2"; expect "続き(残り1件)" 1 "$(jget "['cards'].__len__()")"; expect "最後はnextなし" None "$(jget "['next']")"
req $ADMIN GET "/api/cards?limit=101"; check "101件は400" 400
req $ADMIN GET "/api/cards?q=%E6%A4%9C%E7%B4%A2"; expect "バッチ名で検索" 3 "$(jget "['cards'].__len__()")"
expect "件数の全件集計は返さない" False "$(python3 -I -c "import json;print('counts' in json.load(open('$TMP/body')))")"

echo
echo "結果: pass=$pass fail=$fail"
[ "$fail" = 0 ]
