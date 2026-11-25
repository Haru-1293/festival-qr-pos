#!/usr/bin/env bash
# 割引の発動条件(商品の個数・会計金額)と割引をかける範囲のスモークテスト。
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

req $MGR POST /api/catalog/$SA/tags '{"name":"麺類"}'; TAGM=$(jget "['id']")
req $MGR POST /api/catalog/$SA/products "{\"name\":\"焼きうどん\",\"price\":300,\"saleMode\":\"BOTH\",\"discountable\":true,\"sortOrder\":2,\"tagIds\":[\"$TAGM\"],\"trackStock\":false}"; UDON=$(jget "['id']")
req $MGR POST /api/catalog/$SA/products "{\"name\":\"ジュース\",\"price\":200,\"saleMode\":\"BOTH\",\"discountable\":true,\"sortOrder\":3,\"tagIds\":[],\"trackStock\":false}"; JUICE=$(jget "['id']")
# cp <code> <method> <value> <min|null> <conditionsJson> <mode> <scope> [shopsJson]
cp() { req $ADMIN POST /api/discounts/coupons "{\"name\":\"条件$1\",\"kind\":\"COMMON\",\"code\":\"$1\",\"method\":\"$2\",\"value\":$3,\"minOrderAmount\":$4,\"maxDiscountAmount\":null,\"startsAt\":null,\"endsAt\":null,\"shopIds\":${8:-[\"$SA\"]},\"totalLimit\":null,\"perWalletLimit\":null,\"combinableWithAuto\":true,\"note\":null,\"conditions\":$5,\"conditionMode\":\"$6\",\"applyScope\":\"$7\"}"; }
scan() { local j=$1 c=$2; shift 2; QR=$(newQr "$j")
  req $CLERK POST /api/pos/$SA/pay/scan "{\"token\":\"$QR\",\"items\":$(items "$@"),\"couponCode\":\"$c\"}"; }
qd() { python3 -I -c "import json;d=json.load(open('$TMP/body'));print(d['quote']['discountTotal'],d['quote']['total'])"; }
cerr() { python3 -I -c "import json;d=json.load(open('$TMP/body'));print(d['error']['message'])"; }

echo "== 商品の個数の条件(会計全体に割引) =="
C1="[{\"type\":\"PRODUCT\",\"id\":\"$YAKI\",\"minQty\":3}]"
cp Q3ALL PERCENT 10 null "$C1" ALL ORDER; check "焼きそば3個以上で会計全体10%引き" 201
scan $ALICE Q3ALL $YAKI 2 $JUICE 1; check "2個ではクーポンが使えず409" 409
expect "2個では条件に足りない" "焼きそばを3個以上で使えます" "$(cerr)"
scan $ALICE Q3ALL $YAKI 3 $JUICE 1; check "スキャン(3個)" 200
expect "3個で発動: 会計全体(1400)の10%=140" "140 1260" "$(qd)"

echo "== 条件にあたった商品だけに割引 =="
cp Q3ONLY PERCENT 50 null "$C1" ALL CONDITION; check "焼きそば3個以上で、焼きそばだけ半額" 201
scan $ALICE Q3ONLY $YAKI 3 $JUICE 1; check "スキャン" 200
expect "焼きそば(1200)の半額=600だけ" "600 800" "$(qd)"
scan $ALICE Q3ONLY $YAKI 2 $JUICE 1; check "足りないとクーポンは使えない" 409

echo "== 範囲=ふつうは、対象を指定していればその商品だけ(従来どおり) =="
req $ADMIN POST /api/discounts/coupons "{\"name\":\"対象指定\",\"kind\":\"COMMON\",\"code\":\"TGTONLY\",\"method\":\"PERCENT\",\"value\":50,\"minOrderAmount\":null,\"maxDiscountAmount\":null,\"startsAt\":null,\"endsAt\":null,\"shopIds\":[\"$SA\"],\"totalLimit\":null,\"perWalletLimit\":null,\"combinableWithAuto\":true,\"note\":null,\"items\":[{\"type\":\"PRODUCT\",\"id\":\"$JUICE\"}],\"conditions\":[{\"type\":\"PRODUCT\",\"id\":\"$YAKI\",\"minQty\":2}]}"; check "ジュースだけ対象+焼きそば2個以上" 201
scan $ALICE TGTONLY $YAKI 2 $JUICE 2; expect "条件を満たす→ジュース(400)の半額" "200 1000" "$(qd)"
scan $ALICE TGTONLY $YAKI 1 $JUICE 2; check "焼きそば1個では発動しない" 409
req $ADMIN POST /api/discounts/coupons "{\"name\":\"全体\",\"kind\":\"COMMON\",\"code\":\"TGTORDER\",\"method\":\"PERCENT\",\"value\":50,\"minOrderAmount\":null,\"maxDiscountAmount\":null,\"startsAt\":null,\"endsAt\":null,\"shopIds\":[\"$SA\"],\"totalLimit\":null,\"perWalletLimit\":null,\"combinableWithAuto\":true,\"note\":null,\"items\":[{\"type\":\"PRODUCT\",\"id\":\"$JUICE\"}],\"applyScope\":\"ORDER\"}"; check "対象指定があっても範囲=会計全体" 201
scan $ALICE TGTORDER $YAKI 1 $JUICE 1; expect "会計全体(600)の半額" "300 300" "$(qd)"

echo "== タグの個数の条件 =="
cp TAG2 FIXED 100 null "[{\"type\":\"TAG\",\"id\":\"$TAGM\",\"minQty\":3}]" ALL ORDER; check "麺類タグの商品が3個以上で100円引き" 201
scan $ALICE TAG2 $YAKI 1 $UDON 1 $JUICE 1; check "麺類2個は409" 409; expect "麺類2個では足りない" "タグ「麺類」の商品を3個以上で使えます" "$(cerr)"
scan $ALICE TAG2 $YAKI 1 $UDON 3; expect "麺類タグの焼きうどん3個で発動(タグなしの焼きそばは数えない)" "100 1200" "$(qd)"

echo "== 会計金額 と 個数の条件 =="
cp AMTALL FIXED 100 1000 "[{\"type\":\"PRODUCT\",\"id\":\"$JUICE\",\"minQty\":2}]" ALL ORDER; check "1000円以上 かつ ジュース2個以上" 201
scan $ALICE AMTALL $YAKI 3 $JUICE 1; check "個数不足は409" 409; expect "金額は足りるが個数が足りない(かつ)" "ジュースを2個以上" "$(cerr | grep -o 'ジュースを2個以上')"
scan $ALICE AMTALL $YAKI 1 $JUICE 2; check "金額不足は409" 409; expect "個数は足りるが金額が足りない(800円)" "1000円以上のお買い上げ" "$(cerr | grep -o '1000円以上のお買い上げ')"
scan $ALICE AMTALL $YAKI 3 $JUICE 2; expect "両方満たすと発動" "100 1500" "$(qd)"
cp AMTANY FIXED 100 1000 "[{\"type\":\"PRODUCT\",\"id\":\"$JUICE\",\"minQty\":2}]" ANY ORDER; check "1000円以上 または ジュース2個以上" 201
scan $ALICE AMTANY $YAKI 1 $JUICE 2; expect "個数だけ満たす(800円)→発動(どれか)" "100 700" "$(qd)"
scan $ALICE AMTANY $YAKI 3 $JUICE 1; expect "金額だけ満たす→発動(どれか)" "100 1300" "$(qd)"
scan $ALICE AMTANY $YAKI 1 $JUICE 1; check "どちらも満たさない→使えない" 409
cp ANY2 PERCENT 50 null "[{\"type\":\"PRODUCT\",\"id\":\"$YAKI\",\"minQty\":2},{\"type\":\"PRODUCT\",\"id\":\"$JUICE\",\"minQty\":2}]" ANY CONDITION; check "焼きそば2個以上 または ジュース2個以上 → 満たした商品だけ半額" 201
scan $ALICE ANY2 $YAKI 1 $JUICE 2 $UDON 1; expect "ジュースだけ満たす→ジュース(400)の半額だけ" "200 900" "$(qd)"
scan $ALICE ANY2 $YAKI 2 $JUICE 2; expect "両方満たす→両方(1200)半額" "600 600" "$(qd 2>/dev/null)"

echo "== 確定まで通す =="
scan $ALICE Q3ONLY $YAKI 3 $JUICE 1; S=$(jget "['sessionId']")
B0=$(myBalance $ALICE)
req $CLERK POST /api/pos/$SA/pay/$S/commit "{\"requestId\":\"$(rid)\",\"expectedTotal\":800}"; check "条件つきクーポンで確定" 200
expect "残高は800減る" "$((B0-800))" "$(myBalance $ALICE)"
expect "注文の割引" 600 "$(sqlv "SELECT amount FROM order_discounts WHERE kind='COMMON_COUPON' ORDER BY rowid DESC LIMIT 1")"

echo "== 入力の検証 =="
cp BADC PERCENT 10 null "[{\"type\":\"PRODUCT\",\"id\":\"$YAKI\",\"minQty\":0}]" ALL ORDER; check "個数0は400" 400
cp BADC PERCENT 10 null "[{\"type\":\"PRODUCT\",\"id\":\"$YAKI\",\"minQty\":2},{\"type\":\"PRODUCT\",\"id\":\"$YAKI\",\"minQty\":3}]" ALL ORDER; check "同じ商品の条件が重なると400" 400
cp BADC PERCENT 10 null "[{\"type\":\"PRODUCT\",\"id\":\"$YAKI\",\"minQty\":2}]" ALL ORDER "[]"; check "商品の条件は店舗を1つ選ばないと400" 400
cp BADC PERCENT 10 null "[{\"type\":\"PRODUCT\",\"id\":\"$YAKI\",\"minQty\":2}]" ALL ORDER "[\"$SB\"]"; check "他店の商品の条件は400" 400
cp BADC PERCENT 10 null "[]" ALL CONDITION; check "範囲=条件の商品だけなのに条件がないと400" 400
cp BADC PERCENT 10 null "[{\"type\":\"PRODUCT\",\"id\":\"01HZZZZZZZZZZZZZZZZZZZZZZZ\",\"minQty\":2}]" ALL ORDER; check "存在しない商品は400" 400
cp BADC PERCENT 10 null "[]" ALL BOGUS; check "不正な範囲は400" 400
req $MGR POST /api/shop-coupons/$SA "{\"name\":\"店舗のクーポン\",\"kind\":\"COMMON\",\"code\":\"MGRCOND\",\"method\":\"FIXED\",\"value\":50,\"minOrderAmount\":null,\"maxDiscountAmount\":null,\"startsAt\":null,\"endsAt\":null,\"shopIds\":[],\"totalLimit\":null,\"perWalletLimit\":null,\"combinableWithAuto\":true,\"note\":null,\"conditions\":[{\"type\":\"PRODUCT\",\"id\":\"$YAKI\",\"minQty\":2}],\"conditionMode\":\"ALL\",\"applyScope\":\"CONDITION\"}"; check "店舗責任者も条件つきで作れる(自店舗に固定)" 201

echo "== 一覧に条件が出る =="
req $ADMIN GET /api/discounts
expect "条件の内容" "ANY ORDER 2 ジュース" "$(python3 -I -c "
import json;d=json.load(open('$TMP/body'))
c=[x for x in d['coupons'] if x['code']=='AMTANY'][0]
print(c['conditionMode'],c['applyScope'],c['conditions'][0]['minQty'],c['conditions'][0]['name'])")"

echo
echo "結果: pass=$pass fail=$fail"
[ "$fail" = 0 ]
