#!/usr/bin/env bash
# 有効期限(管理者設定・新規ウォレット・期限切れの利用停止)のスモークテスト。
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


ADMIN=$TMP/admin.jar; ALICE=$TMP/alice.jar; R1=$TMP/r1.jar; R2=$TMP/r2.jar; MGR=$TMP/mgr.jar; MGR2=$TMP/mgr2.jar; MGRB=$TMP/mgrb.jar; CLERK=$TMP/clerk.jar; ANON=$TMP/anon.jar
items() { python3 -I -c "
import json,sys
a=sys.argv[1:]
print(json.dumps([{'productId':a[i],'quantity':int(a[i+1])} for i in range(0,len(a),2)]))" "$@"; }
charge() { local q; q=$(newQr "$2"); lookup "$1" "$q"; local l; l=$(jget "['lookupId']")
  req "$1" POST /api/reception/charge "{\"lookupId\":\"$l\",\"requestId\":\"$(rid)\",\"cashAmount\":$3}"; }
buy() { # buy <customerJar> <itemsJson> → ORDER, CALLNO
  local q; q=$(newQr "$1"); req $CLERK POST /api/pos/$SA/pay/scan "{\"token\":\"$q\",\"items\":$2}"
  local s; s=$(jget "['sessionId']"); local t; t=$(jget "['quote']['total']")
  req $CLERK POST /api/pos/$SA/pay/$s/commit "{\"requestId\":\"$(rid)\",\"expectedTotal\":$t}"
  ORDER=$(jget "['orderId']"); CALLNO=$(jget "['callNo']"); }

echo "== 準備 =="
if [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Origin: $BASE" -H 'content-type: application/json' -H "x-setup-token: $SETUP_TOKEN" -c $ADMIN --data '{"loginId":"admin","password":"adminpass1","nickname":"運営"}' $BASE/api/setup/admin)" != "201" ]; then req $ADMIN POST /api/auth/login '{"loginId":"admin","password":"adminpass1"}'; fi
req $ADMIN POST /api/admin/shops '{"name":"2A 焼きそば","displayName":"2A 焼きそば"}'; check "店舗A" 201; SA=$(jget "['shop']['id']")
req $ADMIN POST /api/admin/users/shop-manager "{\"shopId\":\"$SA\",\"loginId\":\"mgr-a\",\"password\":\"mgrpass123\",\"nickname\":\"A責任者\"}"; check "A責任者" 201
req $MGR POST /api/auth/login '{"loginId":"mgr-a","password":"mgrpass123"}'; check "A責任者ログイン" 200
req $MGR POST /api/shops/$SA/staff '{"loginId":"clerk-a","password":"clerkpass1","nickname":"A店員"}'; check "A店員登録" 201
req $CLERK POST /api/auth/login '{"loginId":"clerk-a","password":"clerkpass1"}'; check "A店員ログイン" 200
req $MGR POST /api/catalog/$SA/products '{"name":"焼きそば","price":300,"saleMode":"BOTH","discountable":true,"sortOrder":1,"tagIds":[],"trackStock":false}'; YAKI=$(jget "['id']")
req $ADMIN POST /api/admin/users/reception '{"nickname":"受付A","loginId":"recep-a","password":"recepass123"}'; check "受付" 201
req $R1 POST /api/auth/login '{"loginId":"recep-a","password":"recepass123"}'; check "受付ログイン" 200
NOW=$(python3 -I -c "import time;print(int(time.time()*1000))")
DAY=86400000

echo "== 設定の取得・保存 =="
req $ADMIN GET /api/admin/settings/expiry; check "既定の取得" 200
expect "既定は日数方式" DAYS "$(jget "['expiry']['mode']")"
expect "既定は180日" 180 "$(jget "['expiry']['days']")"
req $MGR GET /api/admin/settings/expiry; check "責任者は読めない" 403
req $R1 PUT /api/admin/settings/expiry '{"mode":"DAYS","days":30,"date":null}'; check "受付は変更できない" 403
req $ADMIN PUT /api/admin/settings/expiry '{"mode":"DAYS","days":185,"date":null}'; check "185日は400" 400
req $ADMIN PUT /api/admin/settings/expiry '{"mode":"DAYS","days":0,"date":null}'; check "0日は400" 400
req $ADMIN PUT /api/admin/settings/expiry '{"mode":"DATE","days":30,"date":null}'; check "固定日で日付なしは400" 400
req $ADMIN PUT /api/admin/settings/expiry '{"mode":"DATE","days":30,"date":"2020-01-01"}'; check "過去の日付は400" 400
FAR=$(python3 -I -c "import datetime;print((datetime.date.today()+datetime.timedelta(days=200)).isoformat())")
req $ADMIN PUT /api/admin/settings/expiry "{\"mode\":\"DATE\",\"days\":30,\"date\":\"$FAR\"}"; check "6か月を超える日付は400" 400
req $ADMIN PUT /api/admin/settings/expiry '{"mode":"DATE","days":30,"date":"2026-13-45x"}'; check "形式不正は400" 400

echo "== 日数方式: 新規ウォレットとカードに反映 =="
req $ADMIN PUT /api/admin/settings/expiry '{"mode":"DAYS","days":30,"date":null}'; check "30日に設定" 200
req $ADMIN GET /api/admin/settings/expiry; expect "保存された" 30 "$(jget "['expiry']['days']")"
req $ALICE POST /api/auth/register '{"email":"alice@example.com","password":"alicepass123","nickname":"alice"}'; check "顧客登録" 201
EXP=$(sqlv "SELECT expires_at FROM wallets WHERE owner_user_id IS NOT NULL")
OK=$(python3 -I -c "d=($EXP-$NOW)/$DAY;print('yes' if 29.9<d<30.1 else 'no:%s'%d)")
expect "顧客ウォレットの期限は約30日後" yes "$OK"
req $ADMIN POST /api/cards/issue '{"count":1}'; check "期限を指定せずカード発行" 201
CEXP=$(sqlv "SELECT expires_at FROM cards ORDER BY issued_at DESC LIMIT 1")
expect "カードの期限も約30日後" yes "$(python3 -I -c "d=($CEXP-$NOW)/$DAY;print('yes' if 29.9<d<30.1 else 'no:%s'%d)")"
req $ADMIN POST /api/cards/issue "{\"count\":1,\"expiresAt\":$((NOW+200*DAY))}"; check "明示でも上限(184日)は超えられない" 400

echo "== 固定日方式 =="
D10=$(python3 -I -c "import datetime;print((datetime.date.today()+datetime.timedelta(days=10)).isoformat())")
req $ADMIN PUT /api/admin/settings/expiry "{\"mode\":\"DATE\",\"days\":30,\"date\":\"$D10\"}"; check "10日後の固定日" 200
req $ANON POST /api/auth/register '{"email":"bob@example.com","password":"bobpass1234","nickname":"bob"}'; check "顧客B登録" 201
BEXP=$(sqlv "SELECT expires_at FROM wallets w JOIN users u ON u.id = w.owner_user_id WHERE u.login_id = 'bob@example.com'")
expect "固定日の23:59:59(日本時間)" "$(python3 -I -c "import datetime;print(int(datetime.datetime.fromisoformat('${D10}T23:59:59.999+09:00').timestamp()*1000))")" "$BEXP"

echo "== 期限切れの扱い =="
# 期限を過去に書き換えて「期限が切れた」状態を作る

req $ALICE POST /api/auth/login '{"loginId":"alice@example.com","password":"alicepass123"}'; check "Aliceログイン" 200
Q=$(newQr $ALICE); lookup $R1 "$Q"; LK=$(jget "['lookupId']")
req $R1 POST /api/reception/charge "{\"lookupId\":\"$LK\",\"requestId\":\"$(rid)\",\"cashAmount\":3000}"; check "期限内ならチャージできる" 201
expect "残高3000" 3000 "$(myBalance $ALICE)"
AW=$(sqlv "SELECT w.id FROM wallets w JOIN users u ON u.id = w.owner_user_id WHERE u.login_id = 'alice@example.com'")
# 支払いの途中(QR読み取り後・確定前)で期限が切れた場合
Q=$(newQr $ALICE); req $CLERK POST /api/pos/$SA/pay/scan "{\"token\":\"$Q\",\"items\":$(items $YAKI 1)}"; check "期限内ならスキャンできる" 200
SES=$(jget "['sessionId']"); TOT=$(jget "['quote']['total']")
sql "UPDATE wallets SET expires_at = $((NOW-1000)) WHERE id = '$AW'" >/dev/null
req $CLERK POST /api/pos/$SA/pay/$SES/commit "{\"requestId\":\"$(rid)\",\"expectedTotal\":$TOT}"; check "確定の直前に期限が切れたら支払えない" 403
expect "エラーコード" WALLET_EXPIRED "$(jget "['error']['code']")"
expect "残高は減らない" 3000 "$(sqlv "SELECT balance FROM wallets WHERE id = '$AW'")"
req $ALICE POST /api/wallet/qr '{}'; check "期限切れのQR表示は403" 403
expect "エラーコード" WALLET_EXPIRED "$(jget "['error']['code']")"
# 期限が切れる前に作ったQRでも、読み取りで止まる
sql "UPDATE wallets SET expires_at = $((NOW+DAY)) WHERE id = '$AW'" >/dev/null
Q=$(newQr $ALICE)
sql "UPDATE wallets SET expires_at = $((NOW-1000)) WHERE id = '$AW'" >/dev/null
req $CLERK POST /api/pos/$SA/pay/scan "{\"token\":\"$Q\",\"items\":$(items $YAKI 1)}"; check "期限切れウォレットのQRは読み取りで断る" 403
expect "エラーコード" WALLET_EXPIRED "$(jget "['error']['code']")"
expect "QRは消費されない" None "$(sqlv "SELECT consumed_at FROM pay_qr_tokens ORDER BY created_at DESC LIMIT 1" | sed 's/^$/None/;s/^null$/None/')"
# 受付: チャージは不可、払戻しはできる(残高を返せる)
sql "UPDATE wallets SET expires_at = $((NOW+DAY)) WHERE id = '$AW'" >/dev/null
Q=$(newQr $ALICE); lookup $R1 "$Q"; LK=$(jget "['lookupId']")
sql "UPDATE wallets SET expires_at = $((NOW-1000)) WHERE id = '$AW'" >/dev/null
req $R1 POST /api/reception/charge "{\"lookupId\":\"$LK\",\"requestId\":\"$(rid)\",\"cashAmount\":1000}"; check "期限切れのウォレットにはチャージできない" 409
expect "残高は変わらない" 3000 "$(sqlv "SELECT balance FROM wallets WHERE id = '$AW'")"
req $R1 POST /api/reception/payout "{\"lookupId\":\"$LK\",\"requestId\":\"$(rid)\",\"expectedBalance\":3000}"; check "期限切れでも残高は払い戻せる" 201
expect "払戻し後の残高は0" 0 "$(sqlv "SELECT balance FROM wallets WHERE id = '$AW'")"

echo "== 設定変更は発行済みに影響しない =="
req $ADMIN PUT /api/admin/settings/expiry '{"mode":"DAYS","days":90,"date":null}'; check "90日に変更" 200
expect "Bのウォレット期限は変わらない" "$BEXP" "$(sqlv "SELECT expires_at FROM wallets w JOIN users u ON u.id = w.owner_user_id WHERE u.login_id = 'bob@example.com'")"
expect "監査ログに記録される" 1 "$(sqlv "SELECT COUNT(*) > 0 FROM audit_logs WHERE action = 'settings.expiry'")"

echo; echo "結果: $pass 件成功 / $fail 件失敗"; [ "$fail" = "0" ]
