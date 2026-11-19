#!/usr/bin/env bash
# festival-qr-pos セット商品(登録・内訳の選択・追加料金・在庫連動・値下げ・返金)のスモークテスト。
#
# 前提: ローカルで `vite preview --port 4173` が動いていて、DBが空(migration 適用直後)であること。
# 使い方: bash scripts/smoke-sets.sh
#
# 確認すること: セットの登録検証、内訳の選び方の検証(必須・数・重複・対象外)、追加料金、値下げ(追加料金は値下げしない)、
#   単品とセット内の在庫共有(同じ注文は合算)、SET_SALE の在庫移動、売り切れ・販売停止、返金時の在庫戻し、権限。
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

ptotal() { jget "['quote']['total']"; }
scan() { # scan <clerkJar> <token> <itemsJson>
  req "$1" POST /api/pos/$SA/pay/scan "{\"token\":\"$2\",\"items\":$3}"
}
commit() { # commit <jar> <session> <requestId> <expectedTotal>
  req "$1" POST /api/pos/$SA/pay/$2/commit "{\"requestId\":\"$3\",\"expectedTotal\":$4}"
}
charge() { # charge <receptionJar> <customerJar> <yen>
  local q; q=$(newQr "$2"); lookup "$1" "$q"; local l; l=$(jget "['lookupId']")
  req "$1" POST /api/reception/charge "{\"lookupId\":\"$l\",\"requestId\":\"$(rid)\",\"cashAmount\":$3}"
}
items() { python3 -I -c "
import json,sys
a=sys.argv[1:]
print(json.dumps([{'productId':a[i],'quantity':int(a[i+1])} for i in range(0,len(a),2)]))" "$@"; }

ADMIN=$TMP/admin.jar; ALICE=$TMP/alice.jar; BOB=$TMP/bob.jar; R1=$TMP/r1.jar; MGR=$TMP/mgr.jar; MGRB=$TMP/mgrb.jar
CLERK=$TMP/clerk.jar; CLERKB=$TMP/clerkb.jar; ANON=$TMP/anon.jar

echo "== 準備 =="
# セット用: 単品と内訳つきセットを混ぜたカート。引数は JSON をそのまま渡す
buy() { # buy <customerJar> <itemsJson> <expectedTotal>  → ORDER / 結果は code で確認
  local q; q=$(newQr "$1"); scan $CLERK "$q" "$2"
  if [ "$(code)" != "200" ]; then ORDER=""; return; fi
  local s; s=$(jget "['sessionId']"); commit $CLERK $s $(rid) $3; ORDER=$(jget "['orderId']")
}
stock() { sqlv "SELECT stock_qty FROM products WHERE id='$1'"; }

echo "== 準備 =="
curl -s -o "$TMP/body" -w '%{http_code}' -X POST -H "Origin: $BASE" -H 'content-type: application/json' -H "x-setup-token: $SETUP_TOKEN" -c $ADMIN \
  --data '{"loginId":"admin","password":"adminpass1","nickname":"運営"}' $BASE/api/setup/admin > "$TMP/code"
if [ "$(code)" != "201" ]; then req $ADMIN POST /api/auth/login '{"loginId":"admin","password":"adminpass1"}'; fi
req $ADMIN POST /api/admin/shops '{"name":"2A 焼きそば","displayName":"2A 焼きそば"}'; check "店舗A" 201; SA=$(jget "['shop']['id']")
req $ADMIN POST /api/admin/shops '{"name":"3B たこ焼き","displayName":"3B たこ焼き"}'; check "店舗B" 201; SB=$(jget "['shop']['id']")
req $ADMIN POST /api/admin/users/shop-manager "{\"shopId\":\"$SA\",\"loginId\":\"mgr-a\",\"password\":\"mgrpass123\",\"nickname\":\"A責任者\"}"; check "A責任者" 201
req $ADMIN POST /api/admin/users/shop-manager "{\"shopId\":\"$SB\",\"loginId\":\"mgr-b\",\"password\":\"mgrpass123\",\"nickname\":\"B責任者\"}"; check "B責任者" 201
req $MGR POST /api/auth/login '{"loginId":"mgr-a","password":"mgrpass123"}'; check "A責任者ログイン" 200
req $MGRB POST /api/auth/login '{"loginId":"mgr-b","password":"mgrpass123"}'; check "B責任者ログイン" 200
req $MGR POST /api/shops/$SA/staff '{"loginId":"clerk-a","password":"clerkpass1","nickname":"A店員"}'; check "A店員登録" 201
req $CLERK POST /api/auth/login '{"loginId":"clerk-a","password":"clerkpass1"}'; check "A店員ログイン" 200
mkp() { req $MGR POST /api/catalog/$SA/products "$1"; jget "['id']"; }
YAKI=$(mkp '{"name":"焼きそば","price":300,"saleMode":"BOTH","discountable":true,"sortOrder":1,"tagIds":[],"trackStock":true,"stockQty":6}')
FRANK=$(mkp '{"name":"フランク","price":250,"saleMode":"BOTH","discountable":true,"sortOrder":2,"tagIds":[],"trackStock":true,"stockQty":2}')
COLA=$(mkp '{"name":"コーラ","price":150,"saleMode":"BOTH","discountable":true,"sortOrder":3,"tagIds":[],"trackStock":true,"stockQty":3}')
WATER=$(mkp '{"name":"水","price":100,"saleMode":"BOTH","discountable":true,"sortOrder":4,"tagIds":[],"trackStock":false}')
JELLY=$(mkp '{"name":"ミニゼリー","price":null,"saleMode":"SET_ONLY","discountable":true,"sortOrder":5,"tagIds":[],"trackStock":true,"stockQty":2}')
SINGLE=$(mkp '{"name":"単品専用","price":500,"saleMode":"SINGLE_ONLY","discountable":true,"sortOrder":6,"tagIds":[],"trackStock":false}')
req $MGRB POST /api/catalog/$SB/products '{"name":"たこ焼き","price":400,"saleMode":"BOTH","discountable":true,"sortOrder":1,"tagIds":[],"trackStock":false}'; OTHER=$(jget "['id']")
req $ALICE POST /api/auth/register '{"email":"alice@example.com","password":"alicepass1","nickname":"アリス"}'; check "顧客Alice" 201
req $ADMIN POST /api/admin/users/reception '{"nickname":"受付A"}'; check "受付A" 201; RA_TOK=$(jget "['token']")
req $R1 POST /api/auth/qr-login "{\"token\":\"$RA_TOK\"}"; check "受付ログイン" 200
charge $R1 $ALICE 10000; check "Alice 10000チャージ" 201

segs() { # 標準の内訳(フード/ドリンク/デザート)
  echo "[{\"name\":\"フード\",\"required\":true,\"pickCount\":1,\"allowDuplicate\":false,\"items\":[{\"productId\":\"$YAKI\",\"surcharge\":0},{\"productId\":\"$FRANK\",\"surcharge\":50}]},{\"name\":\"ドリンク\",\"required\":true,\"pickCount\":1,\"allowDuplicate\":false,\"items\":[{\"productId\":\"$COLA\",\"surcharge\":0},{\"productId\":\"$WATER\",\"surcharge\":0}]},{\"name\":\"デザート\",\"required\":false,\"pickCount\":1,\"allowDuplicate\":false,\"items\":[{\"productId\":\"$JELLY\",\"surcharge\":30}]}]"
}
setbody() { echo "{\"name\":\"$1\",\"price\":$2,\"discountable\":true,\"sortOrder\":1,\"segments\":$3}"; }

echo "== セットの登録 =="
req $MGR POST /api/catalog/$SA/sets "$(setbody 満腹セット 700 '[]')"; check "内訳なしは400" 400
req $MGR POST /api/catalog/$SA/sets "$(setbody 満腹セット 700 "[{\"name\":\"フード\",\"required\":true,\"pickCount\":1,\"allowDuplicate\":false,\"items\":[{\"productId\":\"$SINGLE\",\"surcharge\":0}]}]")"; check "単品専用商品は入れられない" 400
req $MGR POST /api/catalog/$SA/sets "$(setbody 満腹セット 700 "[{\"name\":\"フード\",\"required\":true,\"pickCount\":1,\"allowDuplicate\":false,\"items\":[{\"productId\":\"$OTHER\",\"surcharge\":0}]}]")"; check "他店舗の商品は入れられない" 400
req $MGR POST /api/catalog/$SA/sets "$(setbody 満腹セット 700 "[{\"name\":\"フード\",\"required\":true,\"pickCount\":2,\"allowDuplicate\":false,\"items\":[{\"productId\":\"$YAKI\",\"surcharge\":0}]}]")"; check "重複不可で選ぶ数が商品数より多いと400" 400
req $MGR POST /api/catalog/$SA/sets "$(setbody 満腹セット -1 "$(segs)")"; check "負の価格は400" 400
req $CLERK POST /api/catalog/$SA/sets "$(setbody 満腹セット 700 "$(segs)")"; check "店員はセットを登録できない" 403
req $MGRB POST /api/catalog/$SA/sets "$(setbody 満腹セット 700 "$(segs)")"; check "他店舗の責任者は登録できない" 403
req $MGR POST /api/catalog/$SA/sets "$(setbody 満腹セット 700 "$(segs)")"; check "セット登録" 201; SET=$(jget "['id']")
req $MGR GET /api/catalog/$SA/sets; check "セット一覧" 200
expect "内訳の数" 3 "$(jget "['sets'][0]['segments'].__len__()")"
expect "提供可能" True "$(jget "['sets'][0]['available']")"
SEG_F=$(jget "['sets'][0]['segments'][0]['id']"); SEG_D=$(jget "['sets'][0]['segments'][1]['id']"); SEG_S=$(jget "['sets'][0]['segments'][2]['id']")
req $CLERK GET /api/catalog/$SA/sets; check "店員は管理一覧を見られない" 403
req $CLERK GET /api/pos/$SA/catalog; check "レジの商品一覧にセットが出る" 200
expect "レジのセット数" 1 "$(jget "['sets'].__len__()")"
expect "セット専用商品は単品一覧に出ない" "False" "$(python3 -I -c "import json;d=json.load(open('$TMP/body'));print(any(p['name']=='ミニゼリー' for p in d['products']))")"
SIG0=$(jget "['signature']")

req $MGR PUT /api/catalog/$SA/sets/$SET "$(setbody 満腹セット 720 "$(segs | python3 -I -c "
import json,sys
s=json.load(sys.stdin)
s[0]['id']='$SEG_F'; s[1]['id']='$SEG_D'; s[2]['id']='$SEG_S'
print(json.dumps(s))")")"; check "セット更新(内訳IDを維持)" 200
req $MGR PUT /api/catalog/$SA/sets/$SET "$(setbody 満腹セット 700 "$(segs | python3 -I -c "
import json,sys
s=json.load(sys.stdin)
s[0]['id']='$SEG_F'; s[1]['id']='$SEG_D'; s[2]['id']='$SEG_S'
print(json.dumps(s))")")"; check "価格を戻す" 200
req $CLERK GET /api/pos/$SA/catalog; expect "更新で署名が変わる" True "$([ "$(jget "['signature']")" != "$SIG0" ] && echo True || echo False)"
expect "内訳IDが維持される" "$SEG_F" "$(jget "['sets'][0]['segments'][0]['id']")"

echo "== 内訳の選び方の検証 =="
pk() { # pk <setId> <qty> <food> <drink> [dessert]
  python3 -I -c "
import json,sys
a=sys.argv[1:]
p={'$SEG_F':[a[2]],'$SEG_D':[a[3]]}
if len(a)>4 and a[4]: p['$SEG_S']=[a[4]]
print(json.dumps({'setId':a[0],'quantity':int(a[1]),'picks':p}))" "$@"
}
QA=$(newQr $ALICE)
scan $CLERK "$QA" "[{\"setId\":\"$SET\",\"quantity\":1,\"picks\":{\"$SEG_F\":[\"$YAKI\"]}}]"; check "必須の内訳が未選択は409" 409; expect "コード" CART_UNAVAILABLE "$(jget "['error']['code']")"
scan $CLERK "$QA" "[{\"setId\":\"$SET\",\"quantity\":1,\"picks\":{\"$SEG_F\":[\"$YAKI\",\"$FRANK\"],\"$SEG_D\":[\"$COLA\"]}}]"; check "選ぶ数が違うと409" 409
scan $CLERK "$QA" "[{\"setId\":\"$SET\",\"quantity\":1,\"picks\":{\"$SEG_F\":[\"$COLA\"],\"$SEG_D\":[\"$COLA\"]}}]"; check "内訳にない商品は409" 409
scan $CLERK "$QA" "[{\"setId\":\"$SET\",\"quantity\":1,\"picks\":{\"01ARZ3NDEKTSV4RRFFQ69G5FAV\":[\"$YAKI\"],\"$SEG_F\":[\"$YAKI\"],\"$SEG_D\":[\"$COLA\"]}}]"; check "存在しない内訳IDは409" 409
scan $CLERK "$QA" "[{\"setId\":\"$SET\",\"productId\":\"$YAKI\",\"quantity\":1}]"; check "商品とセットの同時指定は400" 400
scan $CLERK "$QA" "[{\"setId\":\"$SET\",\"quantity\":1}]"; check "選択なしは409" 409
scan $CLERK "$QA" "[$(pk $SET 1 $YAKI $COLA $JELLY)]"; check "正しい選択(QRは弾かれても消費されていない)" 200; S1=$(jget "['sessionId']")
expect "合計(700+追加30)" 730 "$(jget "['quote']['total']")"
expect "セット行の内訳数" 3 "$(jget "['quote']['lines'][0]['components'].__len__()")"
expect "追加料金の合計" 30 "$(jget "['quote']['lines'][0]['surchargeTotal']")"
commit $CLERK $S1 $(rid) 700; check "追加料金を含まない合計では確定しない" 409; expect "コード" PRICE_CHANGED "$(jget "['error']['code']")"

echo "== 決済・在庫連動 =="
O1_RQ=$(rid); commit $CLERK $S1 $O1_RQ 730; check "セットの決済" 200; O1=$(jget "['orderId']")
expect "残高" 9270 "$(req $ALICE GET /api/auth/me; jget "['wallet']['balance']")"
expect "焼きそば在庫" 5 "$(stock $YAKI)"; expect "コーラ在庫" 2 "$(stock $COLA)"; expect "ゼリー在庫" 1 "$(stock $JELLY)"; expect "水(数量未管理)" "None" "$(stock $WATER)"
expect "在庫移動は SET_SALE" "SET_SALE/SET_SALE/SET_SALE" "$(sqlv "SELECT group_concat(reason,'/') FROM stock_movements WHERE ref_id='$O1'")"
expect "注文明細(SET)" "SET/700/1/30/730" "$(sqlv "SELECT kind||'/'||unit_price||'/'||quantity||'/'||surcharge_total||'/'||line_paid FROM order_lines WHERE order_id='$O1'")"
expect "内訳の記録" "3" "$(sqlv "SELECT count(*) FROM order_line_components c JOIN order_lines l ON l.id=c.order_line_id WHERE l.order_id='$O1'")"
expect "内訳の追加料金" "30" "$(sqlv "SELECT surcharge FROM order_line_components c JOIN order_lines l ON l.id=c.order_line_id WHERE l.order_id='$O1' AND c.name_snapshot='ミニゼリー'")"
expect "売上は注文の合計だけ(内訳へ重複計上しない)" "730" "$(sqlv "SELECT total_paid FROM orders WHERE id='$O1'")"
commit $CLERK $S1 $O1_RQ 730; check "再送は元の結果" 200; expect "二重に減らない" "5/2/1" "$(stock $YAKI)/$(stock $COLA)/$(stock $JELLY)"
req $CLERK GET /api/pos/$SA/pay/$S1; expect "結果照会で内訳つき" 3 "$(jget "['result']['lines'][0]['components'].__len__()")"

echo "== 単品とセット内の在庫共有 =="
# コーラ残2: 単品2 + セット内1 = 3 > 2
QA=$(newQr $ALICE)
scan $CLERK "$QA" "[{\"productId\":\"$COLA\",\"quantity\":2},$(pk $SET 1 $YAKI $COLA)]"; check "単品とセット内を合算して在庫不足" 409; expect "メッセージ" "コーラ は残り2個です" "$(jget "['error']['details']['quote']['problems'][0]['message']")"
scan $CLERK "$QA" "[{\"productId\":\"$COLA\",\"quantity\":1},$(pk $SET 1 $YAKI $COLA)]"; check "ちょうど足りるカート" 200; S2=$(jget "['sessionId']")
expect "合計(150+700)" 850 "$(jget "['quote']['total']")"
commit $CLERK $S2 $(rid) 850; check "確定" 200; O2=$(jget "['orderId']")
expect "コーラ在庫は0" 0 "$(stock $COLA)"; expect "焼きそば" 4 "$(stock $YAKI)"
expect "コーラの在庫移動(SALE と SET_SALE)" "SALE:-1,SET_SALE:-1" "$(sqlv "SELECT group_concat(reason||':'||delta,',') FROM (SELECT reason,delta FROM stock_movements WHERE ref_id='$O2' AND product_id='$COLA' ORDER BY reason)")"
req $CLERK GET /api/pos/$SA/catalog
expect "コーラが選べなくなる" "True" "$(python3 -I -c "import json;d=json.load(open('$TMP/body'));s=d['sets'][0]['segments'][1]['items'];print([i for i in s if i['name']=='コーラ'][0]['disabled'])")"
expect "セットは水で提供を続けられる" "True" "$(jget "['sets'][0]['available']")"
QA=$(newQr $ALICE); scan $CLERK "$QA" "[$(pk $SET 1 $YAKI $COLA)]"; check "売り切れの内訳は選べない" 409
scan $CLERK "$QA" "[$(pk $SET 2 $FRANK $WATER $JELLY)]"; check "ゼリー在庫1で2セットは不足" 409
scan $CLERK "$QA" "[$(pk $SET 1 $FRANK $WATER $JELLY)]"; check "フランク(追加50)・水・ゼリー(追加30)" 200; S3=$(jget "['sessionId']"); expect "合計(700+50+30)" 780 "$(jget "['quote']['total']")"
req $CLERK POST /api/pos/$SA/pay/$S3/cancel '{}'; check "取消" 200

echo "== 値下げ(追加料金は値下げしない) =="
req $MGR POST /api/catalog/$SA/price-cuts '{"name":"タイムセール","method":"PERCENT","value":10}'; check "10%値下げ" 201
req $CLERK GET /api/pos/$SA/catalog; expect "セット値下げ後(700→630)" 630 "$(jget "['sets'][0]['salePrice']")"
QA=$(newQr $ALICE); scan $CLERK "$QA" "[$(pk $SET 1 $FRANK $WATER $JELLY)]"; check "値下げ中の見積もり" 200; S4=$(jget "['sessionId']")
expect "合計(630+50+30)" 710 "$(jget "['quote']['total']")"
commit $CLERK $S4 $(rid) 710; check "確定" 200; O4=$(jget "['orderId']")
expect "定価・値下げ後単価の記録" "700/630" "$(sqlv "SELECT list_unit_price||'/'||unit_price FROM order_lines WHERE order_id='$O4'")"
req $MGR GET /api/catalog/$SA/price-cuts; CUT=$(jget "['cuts'][0]['id']")
req $MGR POST /api/catalog/$SA/price-cuts/$CUT/stop '{}'; check "値下げ停止" 200

echo "== 売り切れ・販売停止 =="
req $CLERK POST /api/pos/$SA/sets/$SET/sold-out '{"soldOut":true}'; check "店員がセットを売り切れにできる" 200
req $CLERK GET /api/pos/$SA/catalog; expect "提供不可(手動)" MANUAL "$(jget "['sets'][0]['unavailableReason']")"
QA=$(newQr $ALICE); scan $CLERK "$QA" "[$(pk $SET 1 $YAKI $WATER)]"; check "売り切れセットは買えない" 409
req $CLERK POST /api/pos/$SA/sets/$SET/sold-out '{"soldOut":false}'; check "販売再開" 200
req $CLERK POST /api/catalog/$SA/sets/$SET/status '{"status":"STOPPED"}'; check "店員は停止できない" 403
req $MGR POST /api/catalog/$SA/sets/$SET/status '{"status":"STOPPED"}'; check "責任者は販売停止できる" 200
req $CLERK GET /api/pos/$SA/catalog; expect "停止中はレジに出ない" 0 "$(jget "['sets'].__len__()")"
scan $CLERK "$QA" "[$(pk $SET 1 $YAKI $WATER)]"; check "停止中のセットは買えない" 409
req $MGR POST /api/catalog/$SA/sets/$SET/status '{"status":"ACTIVE"}'; check "再開" 200
# 必須の内訳(フード)が全部売り切れ → セットは提供終了、フランクだけ単品を続けられる
req $CLERK POST /api/pos/$SA/products/$YAKI/sold-out '{"soldOut":true}'; req $CLERK POST /api/pos/$SA/products/$FRANK/sold-out '{"soldOut":true}'
req $CLERK GET /api/pos/$SA/catalog; expect "必須内訳が全滅でセットは提供終了" NO_OPTIONS "$(jget "['sets'][0]['unavailableReason']")"
req $CLERK POST /api/pos/$SA/products/$YAKI/sold-out '{"soldOut":false}'; req $CLERK POST /api/pos/$SA/products/$FRANK/sold-out '{"soldOut":false}'

echo "== 返金(セット内の在庫戻し) =="
# O2: セット1+コーラ単品1。セット行を返金して在庫を戻す
L_SET=$(sqlv "SELECT id FROM order_lines WHERE order_id='$O2' AND kind='SET'")
req $MGR GET /api/refunds/orders/$O2; check "注文詳細" 200
expect "セット行の内訳" 2 "$(python3 -I -c "import json;d=json.load(open('$TMP/body'));print(len([l for l in d['lines'] if l['kind']=='SET'][0]['components']))")"
BAL=$(req $ALICE GET /api/auth/me; jget "['wallet']['balance']"); Y0=$(stock $YAKI); C0=$(stock $COLA)
req $MGR POST /api/refunds/orders/$O2/refund "{\"requestId\":\"$(rid)\",\"kind\":\"PARTIAL\",\"reason\":\"セット返品\",\"lines\":[{\"orderLineId\":\"$L_SET\",\"quantity\":1,\"restoreStock\":true}],\"expectedAmount\":700}"; check "セット行を返金(在庫を戻す)" 201
expect "返金後の残高" $((BAL+700)) "$(req $ALICE GET /api/auth/me; jget "['wallet']['balance']")"
expect "焼きそばが1戻る" $((Y0+1)) "$(stock $YAKI)"; expect "コーラが1戻る(セット内ぶんだけ)" $((C0+1)) "$(stock $COLA)"
expect "戻しの移動記録" "REFUND_RESTORE/REFUND_RESTORE" "$(sqlv "SELECT group_concat(reason,'/') FROM stock_movements WHERE ref_type='REFUND'")"
# O1: 追加料金つきの全額返金(在庫を戻さない)
Y1=$(stock $YAKI)
req $MGR POST /api/refunds/orders/$O1/refund "{\"requestId\":\"$(rid)\",\"kind\":\"FULL\",\"reason\":\"全額\",\"restoreStock\":false,\"expectedAmount\":730}"; check "追加料金を含む全額返金" 201
expect "在庫は戻さない" "$Y1" "$(stock $YAKI)"
expect "返金の累計は支払額と一致" "730/730" "$(sqlv "SELECT refunded_total||'/'||total_paid FROM orders WHERE id='$O1'")"

echo "== 同時購入での売り越し防止 =="
# 焼きそば在庫を絞る: 残りをセット2 + 単品で競合させる
CUR=$(stock $FRANK); M0=$(sqlv "SELECT count(*) FROM stock_movements WHERE product_id='$FRANK' AND reason='SET_SALE'"); echo "     フランク在庫: $CUR"
for i in 1 2 3 4; do
  q=$(newQr $ALICE); scan $CLERK "$q" "[$(pk $SET 1 $FRANK $WATER)]"; [ "$(code)" = "200" ] && eval "SS$i=$(jget "['sessionId']")" || eval "SS$i="
done
for i in 1 2 3 4; do eval "s=\$SS$i"; [ -n "$s" ] && (commit $CLERK $s $(rid) 750 ) & done; wait
expect "フランク在庫はマイナスにならない" True "$([ "$(stock $FRANK)" -ge 0 ] && echo True || echo False)"
expect "売れた数 = 在庫の減少" "$(( CUR - $(stock $FRANK) ))" "$(( $(sqlv "SELECT count(*) FROM stock_movements WHERE product_id='$FRANK' AND reason='SET_SALE'") - M0 ))"

echo "== 整合 =="
expect "残高と台帳の合計が一致" "$(sqlv "SELECT balance FROM wallets WHERE owner_user_id=(SELECT id FROM users WHERE login_id='alice@example.com')")" "$(sqlv "SELECT SUM(amount) FROM wallet_ledger WHERE wallet_id=(SELECT id FROM wallets WHERE owner_user_id=(SELECT id FROM users WHERE login_id='alice@example.com'))")"
expect "在庫の負値なし" 0 "$(sqlv "SELECT count(*) FROM products WHERE stock_qty < 0")"
expect "セットの監査ログ" "set.create" "$(sqlv "SELECT action FROM audit_logs WHERE action='set.create' LIMIT 1")"

echo
echo "結果: pass=$pass fail=$fail"
[ $fail -eq 0 ]
