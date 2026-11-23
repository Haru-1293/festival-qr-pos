#!/usr/bin/env bash
# festival-qr-pos 割引・クーポン(全ユーザー割引・共通クーポン・使い捨てクーポン)のスモークテスト。
#
# 前提: ローカルで `vite preview --port 4173` が動いていて、DBが空(migration 適用直後)であること。
# 使い方: bash scripts/smoke-discounts.sh
#
# 確認すること: 権限と入力検証、全ユーザー割引の自動適用(最低金額・対象外商品・店舗指定)、クーポン(大文字小文字・期限・上限・1人あたり上限・併用不可・
#   最大割引額)、計算順(割引→クーポン)と行への按分、確定時の記録、全額取消でのクーポン復活と部分返金での非復活、
#   同じ使い捨てクーポンの同時確定、停止、整合性(割引合計・使用回数・残高)。
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


ADMIN=$TMP/admin.jar; ALICE=$TMP/alice.jar; BOB=$TMP/bob.jar; CAROL=$TMP/carol.jar; R1=$TMP/r1.jar; MGR=$TMP/mgr.jar; MGRB=$TMP/mgrb.jar; CLERK=$TMP/clerk.jar

quote() { # quote <itemsJson> [couponCode]
  local c=${2:-}
  req $CLERK POST /api/pos/$SA/pay/quote "{\"items\":$1,\"couponCode\":\"$c\"}"
}
buy() { # buy <customerJar> <itemsJson> <coupon> → ORDER(失敗時は空。code に scan のコード)
  local q; q=$(newQr "$1"); scan $CLERK "$q" "$2" "$3"
  if [ "$(code)" != "200" ]; then ORDER=""; return; fi
  local s; s=$(jget "['sessionId']"); local t; t=$(ptotal); commit $CLERK $s $(rid) $t; ORDER=$(jget "['orderId']")
}
scan() { # scan <jar> <token> <items> [coupon]
  local c=${4:-}
  if [ -n "$c" ]; then req "$1" POST /api/pos/$SA/pay/scan "{\"token\":\"$2\",\"items\":$3,\"couponCode\":\"$c\"}"
  else req "$1" POST /api/pos/$SA/pay/scan "{\"token\":\"$2\",\"items\":$3}"; fi
}
mkauto() { # name method value min max shopIds combinable
  req $ADMIN POST /api/discounts/auto "{\"name\":\"$1\",\"method\":\"$2\",\"value\":$3,\"minOrderAmount\":$4,\"maxDiscountAmount\":$5,\"startsAt\":null,\"endsAt\":null,\"shopIds\":$6,\"combinableWithCoupon\":$7}"
}
mkcoupon() { # kind code method value min max shopIds totalLimit perWallet combinableWithAuto [count]
  req $ADMIN POST /api/discounts/coupons "{\"name\":\"クーポン$2\",\"kind\":\"$1\",\"code\":\"$2\",\"count\":${11:-1},\"method\":\"$3\",\"value\":$4,\"minOrderAmount\":$5,\"maxDiscountAmount\":$6,\"startsAt\":null,\"endsAt\":null,\"shopIds\":$7,\"totalLimit\":$8,\"perWalletLimit\":$9,\"combinableWithAuto\":${10},\"note\":null}"
}

echo "== 準備 =="
curl -s -o "$TMP/body" -w '%{http_code}' -X POST -H "Origin: $BASE" -H 'content-type: application/json' -H "x-setup-token: $SETUP_TOKEN" -c $ADMIN \
  --data '{"loginId":"admin","password":"adminpass1","nickname":"運営"}' $BASE/api/setup/admin > "$TMP/code"
if [ "$(code)" != "201" ]; then req $ADMIN POST /api/auth/login '{"loginId":"admin","password":"adminpass1"}'; fi
req $ADMIN POST /api/admin/shops '{"name":"2A 焼きそば","displayName":"2A 焼きそば"}'; check "店舗A" 201; SA=$(jget "['shop']['id']")
req $ADMIN POST /api/admin/shops '{"name":"3B たこ焼き","displayName":"3B たこ焼き"}'; check "店舗B" 201; SB=$(jget "['shop']['id']")
req $ADMIN POST /api/admin/users/shop-manager "{\"shopId\":\"$SA\",\"loginId\":\"mgr-a\",\"password\":\"mgrpass123\",\"nickname\":\"A責任者\"}"; check "A責任者" 201
req $MGR POST /api/auth/login '{"loginId":"mgr-a","password":"mgrpass123"}'; check "A責任者ログイン" 200
req $MGR POST /api/shops/$SA/staff '{"loginId":"clerk-a","password":"clerkpass1","nickname":"A店員"}'; check "A店員登録" 201
req $CLERK POST /api/auth/login '{"loginId":"clerk-a","password":"clerkpass1"}'; check "A店員ログイン" 200
mkp() { req $MGR POST /api/catalog/$SA/products "$1"; jget "['id']"; }
YAKI=$(mkp '{"name":"焼きそば","price":300,"saleMode":"BOTH","discountable":true,"sortOrder":1,"tagIds":[],"trackStock":false}')
COLA=$(mkp '{"name":"コーラ","price":150,"saleMode":"BOTH","discountable":true,"sortOrder":2,"tagIds":[],"trackStock":false}')
NODISC=$(mkp '{"name":"限定グッズ","price":200,"saleMode":"BOTH","discountable":false,"sortOrder":3,"tagIds":[],"trackStock":false}')
for n in alice bob carol; do
  req $TMP/$n.jar POST /api/auth/register "{\"email\":\"$n@example.com\",\"password\":\"${n}pass123\",\"nickname\":\"$n\"}"; check "顧客$n" 201
done
req $ADMIN POST /api/admin/users/reception '{"nickname":"受付A"}'; check "受付A" 201; RA_TOK=$(jget "['token']")
req $R1 POST /api/auth/qr-login "{\"token\":\"$RA_TOK\"}"; check "受付ログイン" 200
charge $R1 $ALICE 10000; check "Alice チャージ" 201
charge $R1 $BOB 10000; check "Bob チャージ" 201
charge $R1 $CAROL 10000; check "Carol チャージ" 201
IT2=$(items $YAKI 2); IT1=$(items $YAKI 1); IT2G=$(items $YAKI 2 $NODISC 1)

echo "== 権限・入力検証 =="
mkauto 春割 PERCENT 10 500 null "[\"$SA\"]" true >/dev/null; req $MGR POST /api/discounts/auto '{"name":"x","method":"PERCENT","value":10,"minOrderAmount":null,"maxDiscountAmount":null,"startsAt":null,"endsAt":null,"shopIds":[],"combinableWithCoupon":true}'; check "店舗責任者は割引を作れない" 403
req $CLERK GET /api/discounts; check "店員は割引一覧を見られない" 403
mkauto x PERCENT 101 null null "[]" true; check "101%は400" 400
mkauto x FIXED 0 null null "[]" true; check "0円引きは400" 400
req $ADMIN POST /api/discounts/auto "{\"name\":\"x\",\"method\":\"FIXED\",\"value\":10,\"minOrderAmount\":null,\"maxDiscountAmount\":null,\"startsAt\":2000,\"endsAt\":1000,\"shopIds\":[],\"combinableWithCoupon\":true}"; check "終了が開始より前は400" 400
mkauto x FIXED 10 null null '["01HZZZZZZZZZZZZZZZZZZZZZZZ"]' true; check "存在しない店舗は400" 400
mkcoupon COMMON "a b" FIXED 10 null null "[]" null null true; check "コードの形式が不正は400" 400

echo "== 全ユーザー割引(10%・500以上・店舗A) =="
req $ADMIN GET /api/discounts; check "一覧" 200
expect "全ユーザー割引の数" 1 "$(jget "['autos'].__len__()")"
expect "状態" RUNNING "$(jget "['autos'][0]['state']")"
AUTO1=$(jget "['autos'][0]['id']")
quote "$IT1"; check "見積もり(300)" 200
expect "最低金額に満たないと割引なし" 300 "$(jget "['total']")"
quote "$IT2"; check "見積もり(600)" 200
expect "割引後(540)" 540 "$(jget "['total']")"
expect "割引額" 60 "$(jget "['discountTotal']")"
expect "小計" 600 "$(jget "['subtotal']")"
expect "割引の名前" 春割 "$(jget "['discounts'][0]['name']")"
quote "$IT2G"; expect "対象外商品は割引されない(800-60)" 740 "$(jget "['total']")"
req $CLERK POST /api/pos/$SB/pay/quote "{\"items\":$IT2}"; check "他店舗の見積もりは403" 403

echo "== 共通クーポン(100円引き・店舗全体・上限2回・1人1回) =="
mkcoupon COMMON SPRING100 FIXED 100 null null "[]" 2 1 true; check "共通クーポン作成" 201
mkcoupon COMMON spring100 FIXED 100 null null "[]" 2 1 true; check "同じコード(大文字小文字違い)は409" 409
quote "$IT2" spring100; expect "割引→クーポンの順(600-60-100)" 440 "$(jget "['total']")"
expect "適用順1" AUTO "$(jget "['discounts'][0]['kind']")"
expect "適用順2" COMMON_COUPON "$(jget "['discounts'][1]['kind']")"
expect "クーポンの割引額" 100 "$(jget "['discounts'][1]['amount']")"
quote "$IT2" " ｓｐｒｉｎｇ１００ "; expect "全角・空白でも使える" 440 "$(jget "['total']")"
quote "$IT2" NOPE; check "存在しないコードでも見積もりは返る" 200
expect "存在しないコードの理由" "このクーポンコードは見つかりません" "$(jget "['couponError']")"
expect "存在しないコードは割引なし(自動割引のみ)" 540 "$(jget "['total']")"

echo "== クーポンで支払い =="
buy $ALICE "$IT2" SPRING100; check "Alice が支払い確定" 200
expect "支払い額" 440 "$(jget "['total']")"
expect "小計" 600 "$(jget "['subtotal']")"
expect "割引の数" 2 "$(jget "['discounts'].__len__()")"
A_ORDER=$ORDER
expect "Aliceの残高" 9560 "$(myBalance $ALICE)"
expect "orders の割引" "600|160|440" "$(sqlv "SELECT subtotal||'|'||discount_total||'|'||total_paid FROM orders WHERE id='$A_ORDER'")"
expect "行の按分" "600|160|440" "$(sqlv "SELECT line_subtotal||'|'||discount_allocated||'|'||line_paid FROM order_lines WHERE order_id='$A_ORDER'")"
expect "割引の記録" "AUTO:60,COMMON_COUPON:100" "$(sqlv "SELECT group_concat(kind||':'||amount) FROM (SELECT kind, amount FROM order_discounts WHERE order_id='$A_ORDER' ORDER BY apply_seq)")"
expect "クーポンの使用回数" 1 "$(sqlv "SELECT used_count FROM coupons WHERE code='SPRING100'")"
expect "使用記録" "USED" "$(sqlv "SELECT status FROM coupon_redemptions WHERE order_id='$A_ORDER'")"
echo "-- 同じ人は2回使えない(QRは消費されない)"
Q=$(newQr $ALICE); scan $CLERK "$Q" "$IT2" SPRING100; check "1人1回の上限は409" 409
expect "理由コード" COUPON_INVALID "$(jget "['error']['code']")"
scan $CLERK "$Q" "$IT2"; check "同じQRをクーポンなしで読める(消費されていない)" 200
S=$(jget "['sessionId']"); req $CLERK POST /api/pos/$SA/pay/$S/cancel '{}'; check "取り消し" 200

echo "== 利用上限 =="
buy $BOB "$IT2" SPRING100; check "Bob が使える" 200; B_ORDER=$ORDER
expect "使用回数 2" 2 "$(sqlv "SELECT used_count FROM coupons WHERE code='SPRING100'")"
Q=$(newQr $CAROL); scan $CLERK "$Q" "$IT2" SPRING100; check "上限到達は409" 409
expect "理由" "このクーポンは利用上限に達しました" "$(jget "['error']['message']")"
req $ADMIN GET /api/discounts; expect "状態が USED_UP" USED_UP "$(python3 -I -c "import json;d=json.load(open('$TMP/body'));print([c['state'] for c in d['coupons'] if c['code']=='SPRING100'][0])")"

echo "== 返金とクーポンの復活 =="
req $MGR POST /api/refunds/orders/$A_ORDER/refund "{\"requestId\":\"$(rid)\",\"kind\":\"PARTIAL\",\"reason\":\"1個だけ\",\"lines\":[{\"orderLineId\":\"$(sqlv "SELECT id FROM order_lines WHERE order_id='$A_ORDER'")\",\"quantity\":1,\"restoreStock\":false}],\"expectedAmount\":220}"; check "部分返金は割引後の実支払額で按分(220)" 201
expect "部分返金ではクーポンは戻らない" 2 "$(sqlv "SELECT used_count FROM coupons WHERE code='SPRING100'")"
req $MGR POST /api/refunds/orders/$B_ORDER/refund "{\"requestId\":\"$(rid)\",\"kind\":\"FULL\",\"reason\":\"取消\",\"expectedAmount\":440}"; check "全額取消(440)" 201
expect "全額取消でクーポンが復活" 1 "$(sqlv "SELECT used_count FROM coupons WHERE code='SPRING100'")"
expect "使用記録が RESTORED" RESTORED "$(sqlv "SELECT status FROM coupon_redemptions WHERE order_id='$B_ORDER'")"
expect "返金に復活の印" 1 "$(sqlv "SELECT coupon_restored FROM refunds WHERE order_id='$B_ORDER'")"
expect "Bobの残高が戻る" 10000 "$(myBalance $BOB)"
buy $CAROL "$IT2" SPRING100; check "復活した分を Carol が使える" 200
expect "使用回数 2" 2 "$(sqlv "SELECT used_count FROM coupons WHERE code='SPRING100'")"
echo "-- 復活しない指定"
buy $BOB "$IT2" ""; B2=$ORDER
req $MGR POST /api/refunds/orders/$B2/refund "{\"requestId\":\"$(rid)\",\"kind\":\"FULL\",\"reason\":\"クーポンなし\",\"restoreCoupon\":false,\"expectedAmount\":540}"; check "クーポン不使用の注文の全額取消" 201
expect "復活の印は 0" 0 "$(sqlv "SELECT coupon_restored FROM refunds WHERE order_id='$B2'")"

echo "== 使い捨てクーポンと最大割引額 =="
req $ADMIN POST /api/discounts/coupons "{\"name\":\"半額(上限40)\",\"kind\":\"ONE_TIME\",\"count\":3,\"method\":\"PERCENT\",\"value\":50,\"minOrderAmount\":null,\"maxDiscountAmount\":40,\"startsAt\":null,\"endsAt\":null,\"shopIds\":[],\"totalLimit\":null,\"perWalletLimit\":null,\"combinableWithAuto\":true,\"note\":null}"; check "使い捨て3枚を自動作成" 201
expect "コードの数" 3 "$(jget "['codes'].__len__()")"
C1=$(jget "['codes'][0]"); C2=$(jget "['codes'][1]"); C3=$(jget "['codes'][2]")
expect "コードは8文字" 8 "${#C1}"
quote "$IT2" $C1; expect "上限40で頭打ち(600-60-40)" 500 "$(jget "['total']")"
buy $ALICE "$IT2" $C1; check "使い捨てを使う" 200
expect "ONE_TIME の記録" ONE_TIME_COUPON "$(jget "['discounts'][1]['kind']")"
buy $CAROL "$IT2" $C1; check "同じコードは2回目が409" 409
expect "理由" "このクーポンはすでに使われています" "$(jget "['error']['message']")"
req $ADMIN GET /api/discounts; CID2=$(python3 -I -c "import json;d=json.load(open('$TMP/body'));print([c['id'] for c in d['coupons'] if c['code']=='$C2'][0])")
req $ADMIN POST /api/discounts/coupons/$CID2/status '{"status":"STOPPED"}'; check "クーポンを停止" 200
quote "$IT2" $C2; expect "停止したクーポンは使えない" "このクーポンは使えなくなっています" "$(jget "['couponError']")"
req $ADMIN POST /api/discounts/coupons/$CID2/status '{"status":"ACTIVE"}'; check "再開" 200
quote "$IT2" $C2; expect "再開で使える" 500 "$(jget "['total']")"

echo "== 併用できないクーポン・店舗指定 =="
mkcoupon COMMON SOLO FIXED 50 null null "[]" null null false; check "全ユーザー割引と併用不可のクーポン" 201
quote "$IT2" SOLO; expect "全ユーザー割引が適用中だと使えない" "このクーポンは、いま適用中の割引と併用できません" "$(jget "['couponError']")"
quote "$IT1" SOLO; expect "全ユーザー割引が当たらなければ使える(300-50)" 250 "$(jget "['total']")"
mkcoupon COMMON ONLYB FIXED 50 null null "[\"$SB\"]" null null true; check "店舗B限定クーポン" 201
quote "$IT2" ONLYB; expect "他店舗限定のクーポンは使えない" "このクーポンはこのお店では使えません" "$(jget "['couponError']")"
mkcoupon COMMON MIN1000 FIXED 50 1000 null "[]" null null true; check "最低金額つき" 201
quote "$IT2" MIN1000; expect "最低金額に満たない" "1000 以上のお買い上げで使えます" "$(jget "['couponError']")"
mkcoupon COMMON ALL100 PERCENT 100 null null "[]" null null true; check "100%クーポン" 201
quote "$(items $NODISC 1)" ALL100; expect "対象外商品だけなら割引にならない" "割引の対象になる商品がありません" "$(jget "['couponError']")"
mkcoupon COMMON PAST FIXED 50 null null "[]" null null true >/dev/null
req $ADMIN POST /api/discounts/coupons '{"name":"期限切れ","kind":"COMMON","code":"EXPIRED1","method":"FIXED","value":50,"minOrderAmount":null,"maxDiscountAmount":null,"startsAt":1000,"endsAt":2000,"shopIds":[],"totalLimit":null,"perWalletLimit":null,"combinableWithAuto":true,"note":null}'; check "過去の期間のクーポン" 201
quote "$IT2" EXPIRED1; expect "期限切れ" "このクーポンは有効期限が切れています" "$(jget "['couponError']")"

echo "== 複数割引の按分(行をまたぐ) =="
quote "$(items $YAKI 2 $COLA 1)" ""; expect "750 の10%" 675 "$(jget "['total']")"
buy $BOB "$(items $YAKI 2 $COLA 1)" ""; check "2行の会計" 200; M=$ORDER
expect "按分の合計は割引額と一致" "75|75" "$(sqlv "SELECT (SELECT SUM(discount_allocated) FROM order_lines WHERE order_id='$M')||'|'||discount_total FROM orders WHERE id='$M'")"
expect "行の実支払の合計は支払額" 675 "$(sqlv "SELECT SUM(line_paid) FROM order_lines WHERE order_id='$M'")"

echo "== 同じ使い捨てクーポンを2人が同時に確定 =="
Q1=$(newQr $ALICE); scan $CLERK "$Q1" "$IT2" $C2; check "Alice 読み取り" 200; S1=$(jget "['sessionId']"); T1=$(ptotal)
Q2=$(newQr $CAROL); scan $CLERK "$Q2" "$IT2" $C2; check "Carol 読み取り" 200; S2=$(jget "['sessionId']"); T2=$(ptotal)
( curl -s -o $TMP/r1 -w '%{http_code}' -X POST -b $CLERK -H "Origin: $BASE" -H 'content-type: application/json' --data "{\"requestId\":\"$(rid)\",\"expectedTotal\":$T1}" $BASE/api/pos/$SA/pay/$S1/commit > $TMP/c1 ) &
( curl -s -o $TMP/r2 -w '%{http_code}' -X POST -b $CLERK -H "Origin: $BASE" -H 'content-type: application/json' --data "{\"requestId\":\"$(rid)\",\"expectedTotal\":$T2}" $BASE/api/pos/$SA/pay/$S2/commit > $TMP/c2 ) &
wait
CODES=$(sort $TMP/c1 $TMP/c2 | tr '\n' ' ')
expect "成功1・失敗1" "200 409 " "$CODES"
expect "使用回数は1" 1 "$(sqlv "SELECT used_count FROM coupons WHERE code='$C2'")"
for s in $S1 $S2; do req $CLERK POST /api/pos/$SA/pay/$s/cancel '{}' >/dev/null; done

echo "== 全ユーザー割引の停止 =="
req $ADMIN POST /api/discounts/auto/$AUTO1/status '{"status":"STOPPED"}'; check "停止" 200
quote "$IT2"; expect "停止後は割引なし" 600 "$(jget "['total']")"
req $ADMIN POST /api/discounts/auto/$AUTO1/status '{"status":"ACTIVE"}'; check "再開" 200
quote "$IT2"; expect "再開で割引あり" 540 "$(jget "['total']")"
mkauto 全店半額 FIXED 30 null null "[]" true; check "2つ目の全ユーザー割引(全店舗・30円引き)" 201
quote "$IT2"; expect "2つの割引が順に適用(600-60-30)" 510 "$(jget "['total']")"
expect "割引の数" 2 "$(jget "['discounts'].__len__()")"

echo "== 店舗責任者の店舗限定クーポン =="
MGRB_JAR=$TMP/mgrb2.jar
req $ADMIN POST /api/admin/users/shop-manager "{\"shopId\":\"$SB\",\"loginId\":\"mgr-b\",\"password\":\"mgrpass123\",\"nickname\":\"B責任者\"}"; check "B責任者" 201
req $MGRB_JAR POST /api/auth/login '{"loginId":"mgr-b","password":"mgrpass123"}'; check "B責任者ログイン" 200
scoupon() { # jar shopId kind code totalLimit perWallet firstCome
  req "$1" POST /api/shop-coupons/$2 "{\"name\":\"店舗クーポン$4\",\"kind\":\"$3\",\"code\":\"$4\",\"method\":\"FIXED\",\"value\":50,\"minOrderAmount\":null,\"maxDiscountAmount\":null,\"startsAt\":null,\"endsAt\":null,\"shopIds\":[],\"totalLimit\":$5,\"perWalletLimit\":$6,\"firstCome\":$7,\"combinableWithAuto\":true,\"note\":null}"
}
scoupon $MGR $SA COMMON SHOPA1 null null false; check "責任者が自店舗の限定クーポンを作る" 201
expect "対象は自店舗だけ" "$SA" "$(sqlv "SELECT group_concat(target_id) FROM discount_targets WHERE discount_id = (SELECT discount_id FROM coupons WHERE code='SHOPA1')")"
scoupon $MGR $SB COMMON SHOPB1 null null false; check "他店舗には作れない" 403
scoupon $MGRB_JAR $SA COMMON SHOPB2 null null false; check "他店舗の責任者は作れない" 403
scoupon $CLERK $SA COMMON SHOPA9 null null false; check "店員は作れない" 403
scoupon $MGR $SA COMMON SHOPA1 null null false; check "コード重複は409" 409
scoupon $MGR $SA ONE_TIME "" null null false; check "使い捨て(コード自動)も作れる" 201
req $MGR GET /api/shop-coupons/$SA; check "自店舗のクーポン一覧" 200
req $MGR GET /api/shop-coupons/$SB; check "他店舗の一覧は403" 403
req $ADMIN GET /api/shop-coupons/$SA; check "管理者も見られる" 200
SC_ID=$(sqlv "SELECT id FROM coupons WHERE code='SHOPA1'")
GLOBAL_ID=$(sqlv "SELECT id FROM coupons WHERE code='SPRING100'")
req $MGR POST /api/shop-coupons/$SA/$GLOBAL_ID/status '{"status":"STOPPED"}'; check "全店舗向けクーポンは責任者から止められない" 404
req $MGR POST /api/shop-coupons/$SA/$SC_ID/status '{"status":"STOPPED"}'; check "自店舗のクーポンは止められる" 200
expect "停止された" STOPPED "$(sqlv "SELECT status FROM coupons WHERE code='SHOPA1'")"
req $MGR POST /api/shop-coupons/$SA/$SC_ID/status '{"status":"ACTIVE"}'; check "再開できる" 200
req $MGRB_JAR POST /api/shop-coupons/$SB/$SC_ID/status '{"status":"STOPPED"}'; check "他店舗のクーポンは操作できない(404)" 404
expect "監査ログに責任者の操作が残る" 1 "$(sqlv "SELECT CASE WHEN COUNT(*)>=1 THEN 1 ELSE 0 END FROM audit_logs a JOIN users u ON u.id=a.actor_user_id WHERE a.action='coupon.create' AND u.login_id='mgr-a'")"
req $ADMIN GET /api/discounts; expect "管理者の一覧には店舗限定も出る" 1 "$(python3 -I -c "import json;d=json.load(open('$TMP/body'));print(1 if any(c['code']=='SHOPA1' for c in d['coupons']) else 0)")"
expect "限定クーポンの対象店舗" "['$SA']" "$(python3 -I -c "import json;d=json.load(open('$TMP/body'));print([c['shopIds'] for c in d['coupons'] if c['code']=='SHOPA1'][0])")"

echo "== 先着N人のクーポン =="
scoupon $MGR $SA COMMON FIRST2 null null true; check "先着は人数が必須(400)" 400
scoupon $MGR $SA ONE_TIME FIRSTX 2 null true; check "先着は共通コードのみ(400)" 400
scoupon $MGR $SA COMMON FIRST2 2 null true; check "先着2人のクーポンを作る" 201
expect "1人1回に固定される" "2|1|1" "$(sqlv "SELECT total_limit||'|'||per_wallet_limit||'|'||first_come FROM coupons WHERE code='FIRST2'")"
buy $ALICE "$IT2" FIRST2; check "1人目(Alice)が使える" 200
Q=$(newQr $ALICE); scan $CLERK "$Q" "$IT2" FIRST2; check "同じ人は2回使えない(1人1回)" 409; expect "理由" COUPON_INVALID "$(jget "['error']['code']")"
buy $BOB "$IT2" FIRST2; check "2人目(Bob)が使える" 200
Q=$(newQr $CAROL); scan $CLERK "$Q" "$IT2" FIRST2; check "3人目は使えない" 409
expect "先着の人数に達したので終了" "このクーポンは先着の人数に達したため、終了しました" "$(jget "['error']['message']")"
req $MGR GET /api/shop-coupons/$SA; expect "一覧の状態は上限到達" USED_UP "$(python3 -I -c "import json;d=json.load(open('$TMP/body'));print([c['state'] for c in d['coupons'] if c['code']=='FIRST2'][0])")"
expect "一覧に先着の印" True "$(python3 -I -c "import json;d=json.load(open('$TMP/body'));print([c['firstCome'] for c in d['coupons'] if c['code']=='FIRST2'][0])")"

echo "== クーポンのQR(FES1:K:+コード) =="
scoupon $MGR $SA COMMON QRTEST null null false; check "QR用のクーポン" 201
quote "$IT2" "FES1:K:QRTEST"; expect "QRの文字のまま使える" "None" "$(jget "['couponError']")"
expect "クーポンが適用される" "True" "$(jget "['discounts'].__len__() >= 1 and any(x['kind']=='COMMON_COUPON' for x in d['discounts'])")"
quote "$IT2" "fes1:k:qrtest"; expect "小文字でも使える" "None" "$(jget "['couponError']")"
Q=$(newQr $ALICE); scan $CLERK "$Q" "$IT2" "FES1:K:QRTEST"; check "QRの文字で支払いを開始" 200
expect "クーポンが適用された見積もり" "True" "$(jget "['quote']['discounts'].__len__() >= 1")"
req $CLERK POST /api/pos/$SA/pay/$(jget "['sessionId']")/cancel '{}' >/dev/null

echo "== 対象の商品・タグを指定した割引 =="
req $MGR POST /api/catalog/$SA/tags '{"name":"麺類"}'; check "タグ(麺類)" 201; TAGM=$(jget "['id']")
req $MGR POST /api/catalog/$SA/products "{\"name\":\"焼うどん\",\"price\":400,\"saleMode\":\"BOTH\",\"discountable\":true,\"sortOrder\":9,\"tagIds\":[\"$TAGM\"],\"trackStock\":false}"; check "麺類タグの商品" 201; UDON=$(jget "['id']")
req $MGRB_JAR POST /api/catalog/$SB/products '{"name":"たこ焼き","price":500,"saleMode":"BOTH","discountable":true,"sortOrder":1,"tagIds":[],"trackStock":false}'; check "B店の商品" 201; TAKO=$(jget "['id']")
cpart() { python3 -I -c "import json;d=json.load(open('$TMP/body'));print(sum(x['amount'] for x in d['discounts'] if x['kind']!='AUTO'))"; }
sqlv "UPDATE discounts SET status = 'STOPPED' WHERE kind = 'AUTO'" >/dev/null # 他の全ユーザー割引の影響を受けないよう止めておく
icoupon() { # code method value itemsJson [jar] [path]
  req ${5:-$ADMIN} POST ${6:-/api/discounts/coupons} "{\"name\":\"対象指定$1\",\"kind\":\"COMMON\",\"code\":\"$1\",\"method\":\"$2\",\"value\":$3,\"minOrderAmount\":null,\"maxDiscountAmount\":null,\"startsAt\":null,\"endsAt\":null,\"shopIds\":[\"$SA\"],\"items\":$4,\"totalLimit\":null,\"perWalletLimit\":null,\"combinableWithAuto\":true,\"note\":null}"
}
icoupon ONLYCOLA FIXED 100 "[{\"type\":\"PRODUCT\",\"id\":\"$COLA\"}]"; check "商品を指定したクーポン" 201
quote "$(items $YAKI 2 $COLA 1)" ONLYCOLA; expect "指定した商品(コーラ)だけが対象: 100円引き" 100 "$(cpart)"
quote "$(items $YAKI 2)" ONLYCOLA; expect "対象の商品が無いと使えない" "割引の対象になる商品がありません" "$(jget "['couponError']")"
icoupon HALFNOODLE PERCENT 50 "[{\"type\":\"TAG\",\"id\":\"$TAGM\"}]"; check "タグを指定したクーポン" 201
quote "$(items $UDON 1 $YAKI 1)" HALFNOODLE; expect "麺類タグの商品(400円)だけが半額: 200円引き" 200 "$(cpart)"
icoupon MIXED FIXED 1000 "[{\"type\":\"PRODUCT\",\"id\":\"$COLA\"},{\"type\":\"TAG\",\"id\":\"$TAGM\"}]"; check "商品とタグの両方を指定" 201
quote "$(items $UDON 1 $COLA 1 $YAKI 1)" MIXED; expect "対象(550円)で頭打ち。焼きそばは対象外" 550 "$(cpart)"
req $ADMIN GET /api/discounts; expect "一覧に対象の名前が出る" "コーラ" "$(python3 -I -c "import json;d=json.load(open('$TMP/body'));print([i['name'] for c in d['coupons'] if c['code']=='ONLYCOLA' for i in c['items']][0])")"
icoupon BADITEM FIXED 100 "[{\"type\":\"PRODUCT\",\"id\":\"$TAKO\"}]"; check "対象の店舗に含まれない商品は400" 400
icoupon NOITEM FIXED 100 "[{\"type\":\"SET\",\"id\":\"00000000000000000000000000\"}]"; check "存在しないセットは400" 400
icoupon SHOPITEM FIXED 100 "[{\"type\":\"PRODUCT\",\"id\":\"$COLA\"}]" $MGR /api/shop-coupons/$SA; check "店舗責任者も自店舗の商品を指定できる" 201
icoupon SHOPBAD FIXED 100 "[{\"type\":\"PRODUCT\",\"id\":\"$TAKO\"}]" $MGR /api/shop-coupons/$SA; check "店舗責任者は他店舗の商品を指定できない" 400
req $ADMIN POST /api/discounts/auto "{\"name\":\"麺類10%\",\"method\":\"PERCENT\",\"value\":10,\"minOrderAmount\":null,\"maxDiscountAmount\":null,\"startsAt\":null,\"endsAt\":null,\"shopIds\":[\"$SA\"],\"items\":[{\"type\":\"TAG\",\"id\":\"$TAGM\"}],\"combinableWithCoupon\":true}"; check "全ユーザー割引にも対象指定できる" 201
quote "$(items $UDON 1 $YAKI 1)"; expect "麺類10%は焼うどんだけ(40円引き)" 40 "$(jget "['discounts']" >/dev/null; python3 -I -c "import json;d=json.load(open('$TMP/body'));print(sum(x['amount'] for x in d['discounts'] if x['name']=='麺類10%'))")"
echo "== 整合性 =="
expect "注文の割引合計 = 割引の記録の合計" "0" "$(sqlv "SELECT COUNT(*) FROM orders o WHERE o.discount_total <> COALESCE((SELECT SUM(amount) FROM order_discounts d WHERE d.order_id=o.id),0)")"
expect "注文の行の割引合計 = 注文の割引合計" "0" "$(sqlv "SELECT COUNT(*) FROM orders o WHERE o.discount_total <> COALESCE((SELECT SUM(discount_allocated) FROM order_lines l WHERE l.order_id=o.id),0)")"
expect "クーポンの使用回数 = USED の記録数" "0" "$(sqlv "SELECT COUNT(*) FROM coupons c WHERE c.used_count <> (SELECT COUNT(*) FROM coupon_redemptions r WHERE r.coupon_id=c.id AND r.status='USED')")"
expect "残高 = 台帳の合計" "0" "$(sqlv "SELECT COUNT(*) FROM wallets w WHERE w.balance <> COALESCE((SELECT SUM(amount) FROM wallet_ledger l WHERE l.wallet_id=w.id),0)")"
expect "監査ログ(割引の作成)" 1 "$(sqlv "SELECT CASE WHEN COUNT(*)>=3 THEN 1 ELSE 0 END FROM audit_logs WHERE action IN ('discount.create','coupon.create')")"

echo
echo "結果: $pass 件成功 / $fail 件失敗"
[ "$fail" = 0 ]
