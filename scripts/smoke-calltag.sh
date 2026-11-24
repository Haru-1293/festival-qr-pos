#!/usr/bin/env bash
# 呼び出し: 番号札(レジで入力)・自動の番号・スマホでの受け取り待ち表示のスモークテスト。
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
P='"saleMode":"BOTH","discountable":false,"sortOrder":1,"tagIds":[],"trackStock":false'
req $MGR POST /api/catalog/$SA/products "{\"name\":\"焼きそば\",\"price\":400,$P}"; YAKI=$(jget "['id']")
req $ALICE POST /api/auth/register '{"email":"alice@example.com","password":"alicepass123","nickname":"アリス"}'; check "お客様登録(アリス)" 201
req $BOB POST /api/auth/register '{"email":"bob@example.com","password":"bobpass12345","nickname":"ボブ"}'; check "お客様登録(ボブ)" 201
charge $R1 $ALICE 20000; check "チャージ(アリス)" 201
charge $R1 $BOB 20000; check "チャージ(ボブ)" 201
scanTag() { # scanTag <customerJar> <tagNo or ""> [qr]
  QR=${3:-$(newQr "$1")}
  local tg=""; [ -n "$2" ] && tg=",\"tagNo\":$2"
  req $CLERK POST /api/pos/$SA/pay/scan "{\"token\":\"$QR\",\"items\":$(items $YAKI 1)$tg}"; }
commit() { local s; s=$(jget "['sessionId']"); local t; t=$(jget "['quote']['total']")
  req $CLERK POST /api/pos/$SA/pay/$s/commit "{\"requestId\":\"$(rid)\",\"expectedTotal\":$t}"; ORDER=$(jget "['orderId']"); CALLNO=$(jget "['callNo']"); }
status() { req $CLERK POST /api/orders/$SA/$1/status "{\"status\":\"$2\"}"; }

echo "== 設定 =="
req $MGR GET /api/shops/$SA/options; expect "既定は自動の番号" AUTO "$(jget "['options']['callMode']")"
req $MGR PUT /api/shops/$SA/options '{"orderTracking":true,"callBoard":true}'; check "callModeを省略しても保存できる" 200
req $MGR GET /api/shops/$SA/options; expect "省略は自動" AUTO "$(jget "['options']['callMode']")"
req $MGR PUT /api/shops/$SA/options '{"orderTracking":true,"callBoard":true,"callMode":"BOGUS"}'; check "不正な方式は400" 400
req $CLERK PUT /api/shops/$SA/options '{"orderTracking":true,"callBoard":true,"callMode":"TAG"}'; check "店員は変えられない" 403
req $MGRB PUT /api/shops/$SA/options '{"orderTracking":true,"callBoard":true,"callMode":"TAG"}'; check "他店の責任者は変えられない" 403
req $CLERK GET /api/pos/$SA/catalog; expect "自動のとき、レジは番号札なし" False "$(jget "['fulfillment']['tagMode']")"
SIG0=$(jget "['signature']")

echo "== 自動の番号 =="
scanTag $ALICE 55; check "自動の方式で tagNo を送っても無視される" 200; commit; check "確定" 200
expect "自動の番号(1番目)" 1 "$CALLNO"; O_AUTO=$ORDER
req $ALICE GET /api/wallet/active-orders; check "スマホで見る" 200
expect "自動の番号もスマホに出る" 1 "$(jget "['orders'][0]['callNo']")"
expect "調理中" PREPARING "$(jget "['orders'][0]['status']")"
expect "店名" "3A 焼きそば" "$(jget "['orders'][0]['shopName']")"
expect "商品" "焼きそば×1" "$(jget "['orders'][0]['items']")"
status $O_AUTO READY
req $ALICE GET /api/wallet/active-orders; expect "呼び出し中になる" READY "$(jget "['orders'][0]['status']")"

echo "== 番号札の方式 =="
req $MGR PUT /api/shops/$SA/options '{"orderTracking":true,"callBoard":true,"callMode":"TAG"}'; check "番号札の方式に切り替え" 200
req $CLERK GET /api/pos/$SA/catalog; expect "レジに番号札の入力が出る" True "$(jget "['fulfillment']['tagMode']")"
expect "設定が変わると署名も変わる" 1 "$([ "$(jget "['signature']")" != "$SIG0" ] && echo 1 || echo 0)"
Q=$(newQr $ALICE)
scanTag $ALICE "" $Q; check "番号札なしは400" 400
expect "理由" TAG_REQUIRED "$(jget "['error']['code']")"
scanTag $ALICE 0 $Q; check "0は400" 400
scanTag $ALICE 1000 $Q; check "1000は400" 400
scanTag $ALICE 1.5 $Q; check "小数は400" 400
scanTag $ALICE 12 $Q; check "同じQRで、番号札を入れ直して読める(QRは消費されていない)" 200
commit; check "確定" 200
expect "番号札の番号が呼び出し番号になる" 12 "$CALLNO"; O12=$ORDER
expect "追跡の番号" 12 "$(sqlv "SELECT call_no FROM order_tracking WHERE order_id='$O12'")"
req $CLERK GET /api/orders/$SA/active; expect "店員の一覧にも12" 1 "$(python3 -I -c "import json;d=json.load(open('$TMP/body'));print(sum(1 for o in d['orders'] if o['callNo']==12))")"
Q2=$(newQr $BOB)
scanTag $BOB 12 $Q2; check "使用中の番号札は409" 409
expect "理由" TAG_IN_USE "$(jget "['error']['code']")"
scanTag $BOB 1 $Q2; check "自動で振られた番号(1)も使用中(受け渡し前)" 409
scanTag $BOB 13 $Q2; check "別の番号なら同じQRで読める" 200
commit; expect "13" 13 "$CALLNO"; O13=$ORDER
status $O12 DONE
scanTag $BOB 12; check "受け渡し済みの番号は再利用できる" 200; commit; expect "12を再利用" 12 "$CALLNO"; O12B=$ORDER
req $ALICE GET /api/wallet/active-orders; expect "受け渡し済みはスマホから消える" 0 "$(python3 -I -c "import json;d=json.load(open('$TMP/body'));print(sum(1 for o in d['orders'] if o['orderId']=='$O12'))")"

echo "== 番号の付け替え =="
cn() { req "$1" POST /api/orders/$SA/$2/call-no "{\"callNo\":$3}"; }
cn $CLERK $O13 14; check "店員が付け替える" 200
expect "追跡の番号" 14 "$(sqlv "SELECT call_no FROM order_tracking WHERE order_id='$O13'")"
expect "監査に残る" 1 "$(sqlv "SELECT COUNT(*) FROM audit_logs WHERE action='order.call_no' AND target_id='$O13'")"
cn $CLERK $O13 12; check "使用中の番号へは付け替えられない" 409
cn $CLERK $O13 0; check "0は400" 400
cn $CLERK $O13 1000; check "1000は400" 400
cn $MGR $O13 14; check "同じ番号なら何もしない" 200
cn $MGRB $O13 20; check "他店の責任者は不可" 403
cn $ALICE $O13 20; check "お客様は不可" 403
cn $CLERK $O12 30; check "受け渡し済みは不可" 400
req $CLERK POST /api/orders/$SB/$O13/call-no '{"callNo":20}'; check "他店のURLでは不可" 403
cn $MGR $O13 15; check "店舗責任者も付け替えられる" 200

echo "== スマホの受け取り待ち =="
req $BOB GET /api/wallet/active-orders; expect "ボブの注文(13→15と、12)" 2 "$(jget "['orders'].__len__()")"
expect "最新順で、12が先頭" 12 "$(jget "['orders'][0]['callNo']")"
req $ALICE GET /api/wallet/active-orders; expect "アリスの注文は、自動の番号1(呼び出し中)だけ" 1 "$(jget "['orders'].__len__()")"
expect "他人の注文は見えない" 0 "$(python3 -I -c "import json;d=json.load(open('$TMP/body'));print(sum(1 for o in d['orders'] if o['callNo'] in (12,15)))")"
req $ANON GET /api/wallet/active-orders; check "未ログインは401" 401
req $CLERK GET /api/wallet/active-orders; check "店員は不可" 403
req $MGR GET /api/wallet/active-orders; check "責任者は不可" 403
status $O_AUTO DONE
req $ALICE GET /api/wallet/active-orders; expect "受け渡し済みで消える" 0 "$(jget "['orders'].__len__()")"
# 全額返金(取消し)した注文は出ない・番号札も空く
req $CLERK POST /api/orders/$SA/$O13/cancel "{\"requestId\":\"$(rid)\",\"reason\":\"在庫切れ\",\"restoreStock\":false}"; check "注文を取り消す" 201
req $BOB GET /api/wallet/active-orders; expect "取り消した注文は消える" 1 "$(jget "['orders'].__len__()")"
scanTag $ALICE 15; check "取り消した注文の番号札は再利用できる" 200

echo "== 呼び出しボード =="
req $ANON GET /api/public/shops/$SA/board; check "ボード" 200
expect "番号札の番号が出る" 1 "$(python3 -I -c "import json;d=json.load(open('$TMP/body'));print(1 if 12 in d['preparing'] else 0)")"
expect "取り消した番号は出ない" 0 "$(python3 -I -c "import json;d=json.load(open('$TMP/body'));print(1 if 15 in d['preparing'] else 0)")"

echo "== 他店は影響を受けない =="
req $MGRB GET /api/shops/$SB/options; expect "他店の方式は自動のまま" AUTO "$(jget "['options']['callMode']")"

echo
echo "結果: pass=$pass fail=$fail"
[ "$fail" = 0 ]
