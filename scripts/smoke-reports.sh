#!/usr/bin/env bash
# festival-qr-pos 売上・精算・CSV・監査ログ・緊急停止のスモークテスト。
#
# 前提: ローカルで `vite preview --port 4173` が動いていて、DBが空(migration 適用直後)であること。
# 使い方: bash scripts/smoke-reports.sh
#
# 確認すること: 店舗別の売上・割引・返金・純売上、期間指定、商品別売上、CSV(BOM・式の無害化・権限)、
#   監査ログ(一覧・絞り込み・ページ送り・CSV・権限)、緊急停止(止まる操作・止まらない操作・解除・監査記録)。
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
py() { python3 -I -c "import json;d=json.load(open('$TMP/body'));$1"; }
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
EVIL=$(mkp '{"name":"=1+1 特製","price":100,"saleMode":"BOTH","discountable":true,"sortOrder":2,"tagIds":[],"trackStock":false}')
req $TMP/alice.jar POST /api/auth/register '{"email":"alice@example.com","password":"alicepass123","nickname":"alice"}'; check "顧客" 201
req $ADMIN POST /api/admin/users/reception '{"nickname":"受付A"}'; check "受付A" 201; RA_TOK=$(jget "['token']")
req $R1 POST /api/auth/qr-login "{\"token\":\"$RA_TOK\"}"; check "受付ログイン" 200
charge $R1 $ALICE 10000; check "チャージ" 201
req $ADMIN POST /api/discounts/auto "{\"name\":\"10%引き\",\"method\":\"PERCENT\",\"value\":10,\"minOrderAmount\":500,\"maxDiscountAmount\":null,\"startsAt\":null,\"endsAt\":null,\"shopIds\":[],\"combinableWithCoupon\":true}"; check "割引" 201
T0=$(date +%s)000
buy $ALICE "$(items $YAKI 1)" ""; check "注文1(300)" 200; O1=$ORDER
buy $ALICE "$(items $YAKI 2)" ""; check "注文2(600-60=540)" 200; O2=$ORDER
buy $ALICE "$(items $EVIL 1)" ""; check "注文3(100)" 200
req $MGR POST /api/refunds/orders/$O2/refund "{\"requestId\":\"$(rid)\",\"kind\":\"FULL\",\"reason\":\"取消\",\"expectedAmount\":540}"; check "注文2を全額取消" 201

echo "== 売上 =="
req $ADMIN GET /api/reports/sales; check "売上" 200
expect "店舗の数" 2 "$(jget "['shops'].__len__()")"
expect "店舗Aの取引数" 3 "$(py "print([s['orders'] for s in d['shops'] if s['shopId']=='$SA'][0])")"
expect "店舗Aの割引前" 1000 "$(py "print([s['subtotal'] for s in d['shops'] if s['shopId']=='$SA'][0])")"
expect "店舗Aの割引" 60 "$(py "print([s['discountTotal'] for s in d['shops'] if s['shopId']=='$SA'][0])")"
expect "店舗Aの支払額" 940 "$(py "print([s['paidTotal'] for s in d['shops'] if s['shopId']=='$SA'][0])")"
expect "店舗Aの返金額" 540 "$(py "print([s['refundedTotal'] for s in d['shops'] if s['shopId']=='$SA'][0])")"
expect "店舗Aの純売上" 400 "$(py "print([s['netSales'] for s in d['shops'] if s['shopId']=='$SA'][0])")"
expect "店舗Bは0" 0 "$(py "print([s['orders'] for s in d['shops'] if s['shopId']=='$SB'][0])")"
expect "合計の純売上" 400 "$(jget "['totals']['netSales']")"
expect "割引の内訳" "10%引き:1:60" "$(py "x=d['discounts'][0];print(x['name']+':'+str(x['count'])+':'+str(x['amount']))")"
req $ADMIN GET "/api/reports/sales?from=1&to=2"; expect "期間外は0件" 0 "$(jget "['totals']['orders']")"
req $ADMIN GET "/api/reports/sales?from=$T0"; expect "期間の始まりを指定" 3 "$(jget "['totals']['orders']")"
req $ADMIN GET "/api/reports/sales?from=5&to=5"; check "終わりが始まり以前は400" 400
req $MGR GET /api/reports/sales; check "店舗責任者は全体の売上を見られない" 403
req $CLERK GET /api/reports/sales; check "店員は見られない" 403
req $MGR GET /api/reports/shops/$SA/products; check "責任者は自店舗の商品別売上" 200
expect "焼きそば 3個" 3 "$(py "print([p['quantity'] for p in d['products'] if p['name']=='焼きそば'][0])")"
req $MGR GET /api/reports/shops/$SB/products; check "他店舗は403" 403
req $CLERK GET /api/reports/shops/$SA/products; check "店員は403" 403

echo "== 店舗別の詳細(サマリ・取引履歴) =="
req $ADMIN GET /api/reports/shops/$SA/summary; check "管理者は店舗サマリを見られる" 200
expect "サマリの件数は売上画面と一致" "$(req $ADMIN GET /api/reports/sales; python3 -I -c "import json;d=json.load(open('$TMP/body'));print([s['orders'] for s in d['shops'] if s['shopId']=='$SA'][0])")" "$(req $ADMIN GET /api/reports/shops/$SA/summary; jget "['shop']['orders']")"
req $MGR GET /api/reports/shops/$SA/summary; check "責任者は自店舗のサマリ" 200
req $MGR GET /api/reports/shops/$SB/summary; check "他店舗のサマリは403" 403
req $CLERK GET /api/reports/shops/$SA/summary; check "店員は403" 403
req $ADMIN GET /api/reports/shops/00000000000000000000000000/summary; check "存在しない店舗は404" 404
req $ADMIN GET /api/reports/shops/$SA/orders; check "取引履歴" 200
expect "取引履歴の件数(CSVと同じ3件)" 3 "$(jget "['orders'].__len__()")"
expect "新しい順" True "$(jget "['orders'][0]['paidAt'] >= d['orders'][-1]['paidAt']")"
req $ADMIN GET "/api/reports/shops/$SA/orders?limit=2"; expect "ページ分け: 2件" 2 "$(jget "['orders'].__len__()")"
NXT=$(jget "['next']"); req $ADMIN GET "/api/reports/shops/$SA/orders?limit=2&before=$NXT"; check "次のページ" 200
req $MGR GET /api/reports/shops/$SB/orders; check "他店舗の取引履歴は403" 403
req $CLERK GET /api/reports/shops/$SA/orders; check "店員は取引履歴を見られない" 403

echo "== CSV =="
curl -s -D $TMP/h -o $TMP/sales.csv -b $ADMIN $BASE/api/reports/sales.csv
expect "content-type" "text/csv; charset=utf-8" "$(grep -i '^content-type' $TMP/h | tr -d '\r' | cut -d' ' -f2-)"
expect "BOM" "efbbbf" "$(head -c 3 $TMP/sales.csv | od -An -tx1 | tr -d " \n")"
expect "合計行" "合計,3,1000,60,940,540,400,,," "$(tail -n 1 $TMP/sales.csv | tr -d '\r')"
curl -s -o $TMP/orders.csv -b $MGR $BASE/api/reports/shops/$SA/orders.csv
expect "注文CSVの行数(見出し+3)" 4 "$(wc -l < $TMP/orders.csv | tr -d ' ')"
expect "式になる文字は無害化される" 1 "$(grep -c "'=1+1" $TMP/orders.csv)"
expect "式のまま出力されない" 0 "$(grep -c ",=1+1" $TMP/orders.csv)"
expect "他店舗のCSVは403" 403 "$(curl -s -o /dev/null -w '%{http_code}' -b $MGR $BASE/api/reports/shops/$SB/orders.csv)"
expect "未ログインは401" 401 "$(curl -s -o /dev/null -w '%{http_code}' $BASE/api/reports/sales.csv)"

echo "== 監査ログ =="
req $ADMIN GET /api/reports/audit; check "一覧" 200
expect "新しい順" 1 "$(py "t=[e['createdAt'] for e in d['entries']];print(1 if t==sorted(t,reverse=True) else 0)")"
expect "操作者名" "運営" "$(py "print([e['actorNickname'] for e in d['entries'] if e['action']=='discount.create'][0])")"
req $ADMIN GET "/api/reports/audit?action=discount"; expect "操作の絞り込み" 1 "$(jget "['entries'].__len__()")"
req $ADMIN GET "/api/reports/audit?limit=2"; expect "2件ずつ" 2 "$(jget "['entries'].__len__()")"
NEXT=$(jget "['next']"); [ "$NEXT" != "None" ] && echo "  ok  続きがある" && pass=$((pass+1)) || { echo "  NG  続きがない"; fail=$((fail+1)); }
req $ADMIN GET "/api/reports/audit?limit=2&before=$NEXT"; check "続きを取得" 200
req $MGR GET /api/reports/audit; check "責任者は監査ログを見られない" 403
curl -s -o $TMP/audit.csv -b $ADMIN $BASE/api/reports/audit.csv
expect "監査CSVに見出し" "日時(日本時間),操作者,役割,店舗,操作,対象の種類,対象ID,理由,変更前,変更後" "$(sed '1s/^\xEF\xBB\xBF//' $TMP/audit.csv | head -n 1 | tr -d '\r')"

echo "== 緊急停止 =="
req $ADMIN GET /api/settings/public; expect "初期は停止していない" False "$(jget "['emergency']['on']")"
req $MGR PUT /api/admin/settings/emergency '{"on":true,"message":"x"}'; check "責任者は設定できない" 403
req $ADMIN PUT /api/admin/settings/emergency '{"on":true,"message":"システム点検のため"}'; check "緊急停止を開始" 200
req $ADMIN GET /api/settings/public; expect "公開設定に反映" True "$(jget "['emergency']['on']")"
req $ALICE POST /api/wallet/qr '{}'; check "顧客のQR発行は503" 503
expect "理由コード" EMERGENCY_STOP "$(jget "['error']['code']")"
expect "メッセージ" "緊急停止中です: システム点検のため" "$(jget "['error']['message']")"
req $R1 POST /api/reception/charge '{"lookupId":"x","requestId":"aaaaaaaaaaaaaaaaaaaa","cashAmount":100}'; check "受付のチャージは503" 503
req $R1 POST /api/reception/payout '{"lookupId":"x","requestId":"bbbbbbbbbbbbbbbbbbbb","amount":100}'; check "受付の払戻しは503" 503
req $CLERK POST /api/pos/$SA/pay/scan '{"token":"FES1:U:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx","items":[]}'; check "レジの読み取りは503" 503
req $CLERK POST /api/pos/$SA/pay/01HZZZZZZZZZZZZZZZZZZZZZZZ/commit '{"requestId":"cccccccccccccccccccc","expectedTotal":1}'; check "レジの確定は503" 503
req $ADMIN GET /api/reports/sales; check "管理・集計は止まらない" 200
req $CLERK GET /api/pos/$SA/catalog; check "商品一覧は見られる" 200
req $MGR POST /api/refunds/orders/$O1/refund "{\"requestId\":\"$(rid)\",\"kind\":\"FULL\",\"reason\":\"停止中の後始末\",\"expectedAmount\":300}"; check "返金は止まらない" 201
req $ADMIN PUT /api/admin/settings/emergency '{"on":false,"message":""}'; check "解除" 200
req $ALICE POST /api/wallet/qr '{}'; check "解除後はQRを発行できる" 200
expect "監査ログ(開始・解除)" 2 "$(sqlv "SELECT COUNT(*) FROM audit_logs WHERE action IN ('emergency.start','emergency.end')")"

echo
echo "結果: $pass 件成功 / $fail 件失敗"
[ "$fail" = 0 ]
