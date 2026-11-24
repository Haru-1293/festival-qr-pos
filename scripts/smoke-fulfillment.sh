#!/usr/bin/env bash
# 注文ステータス・呼び出しボード・訪問者向け公開API・店舗責任者の複数登録・受付のID/パスワードログイン・売上の時系列のスモークテスト。
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
req $ADMIN POST /api/admin/shops '{"name":"3B たこ焼き","displayName":"3B たこ焼き"}'; check "店舗B" 201; SB=$(jget "['shop']['id']")
req $ADMIN POST /api/admin/users/shop-manager "{\"shopId\":\"$SA\",\"loginId\":\"mgr-a\",\"password\":\"mgrpass123\",\"nickname\":\"A責任者\"}"; check "A責任者" 201
req $ADMIN POST /api/admin/users/shop-manager "{\"shopId\":\"$SB\",\"loginId\":\"mgr-b\",\"password\":\"mgrpass123\",\"nickname\":\"B責任者\"}"; check "B責任者" 201
req $MGR POST /api/auth/login '{"loginId":"mgr-a","password":"mgrpass123"}'; check "A責任者ログイン" 200
req $MGRB POST /api/auth/login '{"loginId":"mgr-b","password":"mgrpass123"}'; check "B責任者ログイン" 200
req $MGR POST /api/shops/$SA/staff '{"loginId":"clerk-a","password":"clerkpass1","nickname":"A店員"}'; check "A店員登録" 201
req $CLERK POST /api/auth/login '{"loginId":"clerk-a","password":"clerkpass1"}'; check "A店員ログイン" 200
req $MGR POST /api/catalog/$SA/products '{"name":"焼きそば","price":300,"saleMode":"BOTH","discountable":true,"sortOrder":1,"tagIds":[],"trackStock":false}'; YAKI=$(jget "['id']")
req $ALICE POST /api/auth/register '{"email":"alice@example.com","password":"alicepass123","nickname":"alice"}'; check "顧客" 201

echo "== 店舗責任者の複数登録 =="
req $MGR POST /api/shops/$SA/staff '{"loginId":"mgr-a2","password":"mgrpass456","nickname":"A責任者2","role":"SHOP_MANAGER"}'; check "責任者が共同の責任者を登録" 201
req $MGR2 POST /api/auth/login '{"loginId":"mgr-a2","password":"mgrpass456"}'; check "共同の責任者がログイン" 200
expect "共同の責任者の役割" SHOP_MANAGER "$(jget "['user']['role']")"
req $MGR2 GET /api/catalog/$SA/products; check "共同の責任者は商品を管理できる" 200
req $MGR2 GET /api/catalog/$SB/products; check "共同の責任者も他店舗は不可" 403
req $MGR GET /api/shops/$SA/staff; expect "スタッフ一覧に責任者2人+店員1人" 3 "$(jget "['staff'].__len__()")"
req $MGRB POST /api/shops/$SA/staff '{"loginId":"xx1","password":"mgrpass456","nickname":"x","role":"SHOP_MANAGER"}'; check "他店舗の責任者は登録できない" 403
req $CLERK POST /api/shops/$SA/staff '{"loginId":"xx2","password":"mgrpass456","nickname":"x","role":"SHOP_MANAGER"}'; check "店員は登録できない" 403
M2ID=$(sqlv "SELECT id FROM users WHERE login_id='mgr-a2'"); M1ID=$(sqlv "SELECT id FROM users WHERE login_id='mgr-a'")
req $MGR POST /api/shops/$SA/staff/$M2ID/reset-password '{"password":"mgrpass789"}'; check "責任者が共同責任者のパスワードを再設定" 200
req $MGR2 GET /api/auth/me; check "再設定で共同責任者のセッションは切れる" 401
req $MGR2 POST /api/auth/login '{"loginId":"mgr-a2","password":"mgrpass789"}'; check "新しいパスワードでログイン" 200
req $MGR PATCH /api/shops/$SA/staff/$M2ID/login-id '{"loginId":"mgr-a3"}'; check "共同責任者のID変更" 200
req $MGR2 POST /api/auth/login '{"loginId":"mgr-a3","password":"mgrpass789"}'; check "新IDでログイン" 200
req $MGR2 POST /api/shops/$SA/staff/$M1ID/reset-password '{"password":"hijack1234"}'; check "共同責任者側からも他の責任者を再設定できる(対等)" 200
req $MGR POST /api/auth/login '{"loginId":"mgr-a","password":"mgrpass123"}'; check "元の責任者はログインし直せない(パスワードが変わった)" 401
req $MGR POST /api/auth/login '{"loginId":"mgr-a","password":"hijack1234"}'; check "変更後のパスワードで入れる" 200
req $MGR POST /api/shops/$SA/staff/$M1ID/reset-password '{"password":"mgrpass123"}'; check "自分自身はここでは変更不可" 400
req $MGR PATCH /api/shops/$SA/staff/$M1ID/status '{"status":"SUSPENDED"}'; check "自分自身は停止できない" 400
req $MGRB POST /api/shops/$SA/staff/$M2ID/reset-password '{"password":"hijack1234"}'; check "他店舗の責任者は共同責任者を操作できない" 403
req $CLERK POST /api/shops/$SA/staff/$M2ID/reset-password '{"password":"hijack1234"}'; check "店員は操作できない" 403
req $MGR PATCH /api/shops/$SA/staff/$M2ID/status '{"status":"SUSPENDED"}'; check "共同責任者を停止" 200
req $MGR2 POST /api/auth/login '{"loginId":"mgr-a3","password":"mgrpass789"}'; check "停止中はログインできない" 401
req $MGR PATCH /api/shops/$SA/staff/$M2ID/status '{"status":"ACTIVE"}'; check "再開" 200
req $MGR2 POST /api/auth/login '{"loginId":"mgr-a3","password":"mgrpass789"}'; check "再開後はログインできる" 200
req $MGR POST /api/auth/login '{"loginId":"mgr-a","password":"hijack1234"}'; check "元の責任者に戻す" 200
req $ADMIN POST /api/admin/users/$M1ID/reset-password '{"password":"mgrpass123"}' >/dev/null
req $MGR POST /api/auth/login '{"loginId":"mgr-a","password":"mgrpass123"}'; check "管理者が責任者のパスワードを戻せる" 200

echo "== 受付担当者のID/パスワード =="
req $ADMIN POST /api/admin/users/reception '{"nickname":"受付A","loginId":"recep-a","password":"recepass123"}'; check "ID付きで受付を登録" 201; RID=$(jget "['userId']")
req $R1 POST /api/auth/login '{"loginId":"recep-a","password":"recepass123"}'; check "受付がID/パスワードでログイン" 200
expect "役割" RECEPTION "$(jget "['user']['role']")"
req $R2 POST /api/auth/login '{"loginId":"recep-a","password":"recepass123"}'; check "別端末でログイン" 200
req $R1 GET /api/reception/summary; check "古い端末はログアウトされる(受付は同時1端末)" 401
req $R2 GET /api/reception/summary; check "新しい端末は使える" 200
req $R2 POST /api/auth/login '{"loginId":"recep-a","password":"wrong-password"}'; check "パスワード違いは401" 401
req $ADMIN POST /api/admin/users/reception '{"nickname":"受付B","loginId":"recep-b"}'; check "IDだけは400" 400
req $ADMIN POST /api/admin/users/reception '{"nickname":"受付B"}'; check "ID無しの受付(QRのみ)" 201; RB=$(jget "['userId']")
req $ADMIN POST /api/admin/users/$RB/reset-password '{"password":"newpass1234"}'; check "IDが無い受付のパスワード再設定は400" 400
req $ADMIN POST /api/admin/users/$RB/reception-credentials '{"loginId":"recep-a","password":"newpass1234"}'; check "ID重複は409" 409
req $ADMIN POST /api/admin/users/$RB/reception-credentials '{"loginId":"recep-b","password":"newpass1234"}'; check "後からID/パスワードを設定" 200
req $ANON POST /api/auth/login '{"loginId":"recep-b","password":"newpass1234"}'; check "設定したIDでログイン" 200
req $R2 POST /api/admin/users/$RB/reception-credentials '{"loginId":"zzz","password":"newpass1234"}'; check "受付は設定できない" 403

echo "== 注文ステータス(オプション) =="
charge $R2 $ALICE 5000; check "チャージ" 201
buy $ALICE "$(items $YAKI 1)"; expect "オプションがオフなら呼び出し番号なし" None "$CALLNO"
req $CLERK GET /api/orders/$SA/active; expect "オフでは追跡されない" 0 "$(jget "['orders'].__len__()")"
req $CLERK PUT /api/shops/$SA/options '{"orderTracking":true,"callBoard":false}'; check "店員はオプションを変えられない" 403
req $MGR PUT /api/shops/$SA/options '{"orderTracking":false,"callBoard":true}'; check "呼び出しボードだけは400" 400
req $MGRB PUT /api/shops/$SA/options '{"orderTracking":true,"callBoard":true}'; check "他店舗は変更不可" 403
req $MGR PUT /api/shops/$SA/options '{"orderTracking":true,"callBoard":true}'; check "オンにする" 200
req $ANON GET /api/public/shops/$SB/board; check "ボードを使っていない店舗は404" 404
buy $ALICE "$(items $YAKI 2)"; O1=$ORDER; expect "呼び出し番号1" 1 "$CALLNO"
buy $ALICE "$(items $YAKI 1)"; O2=$ORDER; expect "呼び出し番号2" 2 "$CALLNO"
req $CLERK GET /api/orders/$SA/active; expect "調理中2件" 2 "$(jget "['orders'].__len__()")"
expect "最初は調理中" PREPARING "$(jget "['orders'][0]['status']")"
expect "商品が見える" 焼きそば "$(jget "['orders'][0]['items'][0]['name']")"
req $TMP/none.jar GET /api/orders/$SA/active; check "未ログインは401" 401
req $MGRB GET /api/orders/$SA/active; check "他店舗は403" 403
req $ANON GET /api/public/shops/$SA/board; check "ボード(ログイン不要)" 200
expect "ボード: 調理中" "['1', '2']" "$(jget "['preparing']")"
expect "ボード: 提供可能" "[]" "$(jget "['ready']")"
expect "ボードに個人情報は含まれない" "['preparing', 'ready', 'serverTime', 'shopName']" "$(jget ".keys().__class__ and sorted(d.keys())")"
req $CLERK POST /api/orders/$SA/$O1/status '{"status":"READY"}'; check "提供可能にする" 200
req $ANON GET /api/public/shops/$SA/board; expect "ボード: 調理中[2]" "['2']" "$(jget "['preparing']")"; expect "ボード: 提供可能[1]" "['1']" "$(jget "['ready']")"
req $CLERK POST /api/orders/$SB/$O1/status '{"status":"DONE"}'; check "他店舗の経路では変更できない" 403
req $MGRB POST /api/orders/$SB/$O1/status '{"status":"DONE"}'; check "別店舗の注文は404" 404
req $CLERK POST /api/orders/$SA/$O1/status '{"status":"DONE"}'; check "受け渡し済み" 200
req $ANON GET /api/public/shops/$SA/board; expect "受け渡し後はボードから消える" "[]" "$(jget "['ready']")"
req $CLERK POST /api/orders/$SA/$O2/status '{"status":"BAD"}'; check "不正な状態は400" 400
req $MGR POST /api/refunds/orders/$O2/refund "{\"requestId\":\"$(rid)\",\"kind\":\"FULL\",\"reason\":\"お客様都合\",\"restoreStock\":true,\"expectedAmount\":300}"; check "全額返金" 201
req $ANON GET /api/public/shops/$SA/board; expect "全額返金した注文はボードから消える" "[]" "$(jget "['preparing']")"
buy $ALICE "$(items $YAKI 1)"; expect "呼び出し番号3" 3 "$CALLNO"

echo "== 訪問者向けの公開API =="
req $ANON GET /api/public/shops; check "店舗一覧(ログイン不要)" 200
expect "店舗数" 2 "$(jget "['shops'].__len__()")"
req $ANON GET /api/public/shops/$SA/menu; check "メニュー" 200
expect "商品名" 焼きそば "$(jget "['items'][0]['name']")"
expect "在庫の数は出さない" "['description', 'kind', 'name', 'price', 'soldOut']" "$(jget "['items'][0].keys().__class__ and sorted(d['items'][0].keys())")"
req $ANON GET /api/public/shops/01HZZZZZZZZZZZZZZZZZZZZZZZ/menu; check "存在しない店舗は404" 404

echo "== 売上の時系列 =="
req $ADMIN GET "/api/reports/timeseries?bucket=hour"; check "全体(時間帯別)" 200
expect "合計取引数" 4 "$(python3 -I -c "import json;print(sum(p['orders'] for p in json.load(open('$TMP/body'))['points']))")"
req $MGR GET "/api/reports/shops/$SA/timeseries?bucket=day"; check "店舗(日別)" 200
expect "1日にまとまる" 1 "$(jget "['points'].__len__()")"
req $MGRB GET "/api/reports/shops/$SA/timeseries"; check "他店舗は403" 403
req $MGR GET "/api/reports/timeseries"; check "全体は管理者のみ" 403

echo
echo "結果: $pass 件成功 / $fail 件失敗"
[ "$fail" = "0" ]
