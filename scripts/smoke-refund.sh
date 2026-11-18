#!/usr/bin/env bash
# festival-qr-pos 返金(全額・商品選択・任意金額)と利用履歴のスモークテスト。
#
# 前提: ローカルで `vite preview --port 4173` が動いていて、DBが空(migration 適用直後)であること。
# 使い方: bash scripts/smoke-refund.sh
#
# 確認すること: 返金の権限(他店舗・店員・顧客は不可、任意金額は全体管理者だけ)、全額/商品選択/任意金額、
#   返金上限(実支払額)、画面の返金額との照合、在庫を戻す/戻さない、冪等(再送/同時送信)、
#   同時に別の返金が入ったときの拒否、残高・台帳・注文・返金明細・在庫の整合、顧客の利用履歴。
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
req $MGRB POST /api/shops/$SB/staff '{"loginId":"clerk-b","password":"clerkpass1","nickname":"B店員"}'; check "B店員登録" 201
req $CLERK POST /api/auth/login '{"loginId":"clerk-a","password":"clerkpass1"}'; check "A店員ログイン" 200
req $CLERKB POST /api/auth/login '{"loginId":"clerk-b","password":"clerkpass1"}'; check "B店員ログイン" 200
mkp() { req $MGR POST /api/catalog/$SA/products "$1"; jget "['id']"; }
YAKI=$(mkp '{"name":"焼きそば","price":300,"saleMode":"BOTH","discountable":true,"sortOrder":1,"tagIds":[],"trackStock":true,"stockQty":5}')
DRINK=$(mkp '{"name":"ドリンク","price":150,"saleMode":"SINGLE_ONLY","discountable":true,"sortOrder":2,"tagIds":[],"trackStock":false}')
OMAKE=$(mkp '{"name":"限定おまけ","price":100,"saleMode":"BOTH","discountable":false,"sortOrder":3,"tagIds":[],"trackStock":false}')
ONE=$(mkp '{"name":"限定1個","price":100,"saleMode":"SINGLE_ONLY","discountable":true,"sortOrder":4,"tagIds":[],"trackStock":true,"stockQty":1}')
SETONLY=$(mkp '{"name":"セット専用","price":null,"saleMode":"SET_ONLY","discountable":true,"sortOrder":5,"tagIds":[],"trackStock":false}')
req $ALICE POST /api/auth/register '{"email":"alice@example.com","password":"alicepass1","nickname":"アリス"}'; check "顧客Alice" 201
req $BOB POST /api/auth/register '{"email":"bob@example.com","password":"bobpass123","nickname":"ボブ"}'; check "顧客Bob" 201
req $ADMIN POST /api/admin/users/reception '{"nickname":"受付A"}'; check "受付A" 201; RA_TOK=$(jget "['token']")
req $R1 POST /api/auth/qr-login "{\"token\":\"$RA_TOK\"}"; check "受付ログイン" 200
charge $R1 $ALICE 1000; check "Alice 1000チャージ" 201
charge $R1 $BOB 1000; check "Bob 1000チャージ" 201
expect "Alice残高" 1000 "$(myBalance $ALICE)"


buy() { # buy <customerJar> <itemsJson> <expectedTotal>  -> 注文IDを ORDER に入れる
  local q; q=$(newQr "$1"); scan $CLERK "$q" "$2"; local sid; sid=$(jget "['sessionId']")
  commit $CLERK $sid $(rid) $3; ORDER=$(jget "['orderId']")
}
refund() { # refund <jar> <orderId> <json>  (requestId を補う)
  req "$1" POST /api/refunds/orders/$2/refund "$3"
}
stock() { sqlv "SELECT stock_qty FROM products WHERE id='$1'"; }

charge $R1 $ALICE 3000; check "Alice追加チャージ" 201
expect "Alice残高" 4000 "$(myBalance $ALICE)"

echo "== 注文を作る =="
buy $ALICE "$(items $YAKI 3 $DRINK 1)" 1050; O1=$ORDER; echo "     注文1: $O1"
expect "残高" 2950 "$(myBalance $ALICE)"; expect "焼きそば在庫" 2 "$(stock $YAKI)"
O1NO=$(sqlv "SELECT SUBSTR(id,-8) FROM orders WHERE id='$O1'")
L_YAKI=$(sqlv "SELECT id FROM order_lines WHERE order_id='$O1' AND product_id='$YAKI'")
L_DRINK=$(sqlv "SELECT id FROM order_lines WHERE order_id='$O1' AND product_id='$DRINK'")

echo "== 権限・一覧 =="
req $ANON GET /api/refunds/orders/$O1; check "未ログインは401" 401
req $CLERK GET /api/refunds/orders/$O1; check "店員は見られない" 403
req $ALICE GET /api/refunds/orders/$O1; check "顧客は見られない" 403
req $MGRB GET /api/refunds/orders/$O1; check "他店舗の責任者は見られない" 403
req $MGRB GET /api/refunds/shops/$SA/orders; check "他店舗の一覧は見られない" 403
req $MGR GET /api/refunds/shops/$SA/orders; check "注文一覧" 200; expect "1件" 1 "$(jget ".get('orders').__len__()")"
expect "顧客名" アリス "$(jget "['orders'][0]['customerNickname']")"
req $MGR GET "/api/refunds/shops/$SA/orders?q=$O1NO"; expect "取引番号で絞り込める" 1 "$(jget "['orders'].__len__()")"
req $MGR GET "/api/refunds/shops/$SA/orders?q=ZZZZZZZZ"; expect "一致なしは0件" 0 "$(jget "['orders'].__len__()")"
req $MGR GET /api/refunds/orders/$O1; check "注文の詳細" 200
expect "返金できる残額" 1050 "$(jget "['refundable']")"; expect "状態" PAID "$(jget "['status']")"; expect "店員名" A店員 "$(jget "['clerkNickname']")"
expect "明細(2行)" 2 "$(jget "['lines'].__len__()")"

echo "== 商品を選んで返金 =="
R1Q=$(rid)
refund $MGR $O1 "{\"requestId\":\"$R1Q\",\"kind\":\"PARTIAL\",\"reason\":\"1個落とした\",\"lines\":[{\"orderLineId\":\"$L_YAKI\",\"quantity\":1,\"restoreStock\":false}],\"expectedAmount\":299}"; check "画面の返金額と違えば実行しない" 409; expect "コード" AMOUNT_CHANGED "$(jget "['error']['code']")"
refund $MGR $O1 "{\"requestId\":\"$R1Q\",\"kind\":\"PARTIAL\",\"reason\":\"\",\"lines\":[{\"orderLineId\":\"$L_YAKI\",\"quantity\":1,\"restoreStock\":false}],\"expectedAmount\":300}"; check "理由は必須" 400
refund $MGR $O1 "{\"requestId\":\"$R1Q\",\"kind\":\"PARTIAL\",\"reason\":\"x\",\"lines\":[],\"expectedAmount\":300}"; check "商品を選ばないと400" 400
refund $MGR $O1 "{\"requestId\":\"$R1Q\",\"kind\":\"PARTIAL\",\"reason\":\"x\",\"lines\":[{\"orderLineId\":\"$L_YAKI\",\"quantity\":4,\"restoreStock\":true}],\"expectedAmount\":1200}"; check "買った数を超える返金は400" 400
refund $CLERK $O1 "{\"requestId\":\"$R1Q\",\"kind\":\"PARTIAL\",\"reason\":\"x\",\"lines\":[{\"orderLineId\":\"$L_YAKI\",\"quantity\":1,\"restoreStock\":true}],\"expectedAmount\":300}"; check "店員は返金できない" 403
refund $MGRB $O1 "{\"requestId\":\"$R1Q\",\"kind\":\"PARTIAL\",\"reason\":\"x\",\"lines\":[{\"orderLineId\":\"$L_YAKI\",\"quantity\":1,\"restoreStock\":true}],\"expectedAmount\":300}"; check "他店舗の責任者は返金できない" 403
expect "拒否された返金で残高は不変" 2950 "$(myBalance $ALICE)"
refund $MGR $O1 "{\"requestId\":\"$R1Q\",\"kind\":\"PARTIAL\",\"reason\":\"1個落とした\",\"lines\":[{\"orderLineId\":\"$L_YAKI\",\"quantity\":1,\"restoreStock\":false}],\"expectedAmount\":300}"; check "焼きそば1個を返金(在庫は戻さない)" 201
RF1=$(jget "['refundId']"); expect "返金額" 300 "$(jget "['amount']")"; expect "状態" PARTIALLY_REFUNDED "$(jget "['status']")"; expect "残り返金可能額" 750 "$(jget "['refundable']")"; expect "返金後の残高" 3250 "$(jget "['balanceAfter']")"
expect "残高" 3250 "$(myBalance $ALICE)"; expect "在庫は戻らない" 2 "$(stock $YAKI)"
expect "台帳(返金・プラス)" "REFUND/300" "$(sqlv "SELECT kind||'/'||amount FROM wallet_ledger WHERE ref_id='$RF1'")"
refund $MGR $O1 "{\"requestId\":\"$R1Q\",\"kind\":\"PARTIAL\",\"reason\":\"1個落とした\",\"lines\":[{\"orderLineId\":\"$L_YAKI\",\"quantity\":1,\"restoreStock\":false}],\"expectedAmount\":300}"; check "同じリクエストの再送" 200; expect "再送フラグ" True "$(jget "['replayed']")"; expect "同じ返金" "$RF1" "$(jget "['refundId']")"
expect "二重に返金されない" 3250 "$(myBalance $ALICE)"
refund $MGR $O1 "{\"requestId\":\"$(rid)\",\"kind\":\"FULL\",\"reason\":\"x\",\"expectedAmount\":1050}"; check "一部返金後の全額返金は400" 400; expect "コード" ALREADY_PARTIALLY_REFUNDED "$(jget "['error']['code']")"
refund $MGR $O1 "{\"requestId\":\"$(rid)\",\"kind\":\"PARTIAL\",\"reason\":\"ドリンクも\",\"lines\":[{\"orderLineId\":\"$L_YAKI\",\"quantity\":2,\"restoreStock\":true},{\"orderLineId\":\"$L_DRINK\",\"quantity\":1,\"restoreStock\":true}],\"expectedAmount\":750}"; check "残りを返金(在庫に戻す)" 201
expect "全額返金済み" REFUNDED "$(jget "['status']")"; expect "残り0" 0 "$(jget "['refundable']")"
expect "焼きそばの在庫(残2+戻した2)" 4 "$(stock $YAKI)"
expect "残高(元の4000に戻る)" 4000 "$(myBalance $ALICE)"
refund $MGR $O1 "{\"requestId\":\"$(rid)\",\"kind\":\"PARTIAL\",\"reason\":\"x\",\"lines\":[{\"orderLineId\":\"$L_YAKI\",\"quantity\":1,\"restoreStock\":true}],\"expectedAmount\":300}"; check "返金済みの注文はこれ以上返金できない" 400
req $MGR GET /api/refunds/orders/$O1; expect "返金履歴は2件" 2 "$(jget "['refunds'].__len__()")"; expect "履歴の操作者" A責任者 "$(jget "['refunds'][0]['operatorNickname']")"
expect "履歴の明細(在庫を戻さない)" False "$(jget "['refunds'][0]['lines'][0]['restoreStock']")"
expect "明細の返金数量" 3 "$(jget "['lines'][0]['refundedQuantity']")"

echo "== 全額返金 =="
buy $ALICE "$(items $YAKI 2 $DRINK 2)" 900; O2=$ORDER
expect "支払い後の残高" 3100 "$(myBalance $ALICE)"; S_BEFORE=$(stock $YAKI)
refund $MGR $O2 "{\"requestId\":\"$(rid)\",\"kind\":\"FULL\",\"reason\":\"お客様都合\",\"restoreStock\":true,\"expectedAmount\":900}"; check "全額返金" 201
RF2=$(jget "['refundId']"); expect "状態" REFUNDED "$(jget "['status']")"; expect "残高" 4000 "$(myBalance $ALICE)"; expect "在庫を戻す" $((S_BEFORE+2)) "$(stock $YAKI)"
expect "在庫移動(返金戻し・この返金の分)" "2/$((S_BEFORE+2))" "$(sqlv "SELECT delta||'/'||qty_after FROM stock_movements WHERE ref_id='$RF2' AND product_id='$YAKI' AND reason='REFUND_RESTORE'")"

echo "== 値下げ中の注文を一部返金(実支払額ベース) =="
req $MGR POST /api/catalog/$SA/price-cuts '{"name":"セール","method":"PERCENT","value":20}'; check "20%引き" 201; CUT=$(jget "['id']")
buy $ALICE "$(items $YAKI 2)" 480; O3=$ORDER
expect "値下げ後の支払い" 3520 "$(myBalance $ALICE)"
L3=$(sqlv "SELECT id FROM order_lines WHERE order_id='$O3'")
refund $MGR $O3 "{\"requestId\":\"$(rid)\",\"kind\":\"PARTIAL\",\"reason\":\"x\",\"lines\":[{\"orderLineId\":\"$L3\",\"quantity\":1,\"restoreStock\":true}],\"expectedAmount\":300}"; check "定価300ではなく値下げ後240が返金額" 409
refund $MGR $O3 "{\"requestId\":\"$(rid)\",\"kind\":\"PARTIAL\",\"reason\":\"x\",\"lines\":[{\"orderLineId\":\"$L3\",\"quantity\":1,\"restoreStock\":true}],\"expectedAmount\":240}"; check "1個を返金(240)" 201
expect "残高" 3760 "$(myBalance $ALICE)"
req $MGR POST /api/catalog/$SA/price-cuts/$CUT/stop '{}'

echo "== 任意金額(全体管理者のみ) =="
buy $ALICE "$(items $DRINK 2)" 300; O4=$ORDER
refund $MGR $O4 "{\"requestId\":\"$(rid)\",\"kind\":\"ARBITRARY\",\"reason\":\"おわび\",\"amount\":50,\"expectedAmount\":50}"; check "店舗責任者は任意金額を返金できない" 403
refund $ADMIN $O4 "{\"requestId\":\"$(rid)\",\"kind\":\"ARBITRARY\",\"reason\":\"おわび\",\"amount\":301,\"expectedAmount\":301}"; check "実支払額を超える任意金額は400" 400; expect "コード" OVER_REFUNDABLE "$(jget "['error']['code']")"
refund $ADMIN $O4 "{\"requestId\":\"$(rid)\",\"kind\":\"ARBITRARY\",\"reason\":\"\",\"amount\":50,\"expectedAmount\":50}"; check "理由なしは400" 400
refund $ADMIN $O4 "{\"requestId\":\"$(rid)\",\"kind\":\"ARBITRARY\",\"reason\":\"おわび\",\"amount\":50,\"expectedAmount\":50}"; check "全体管理者が50を返金" 201
expect "残り返金可能額" 250 "$(jget "['refundable']")"; expect "状態" PARTIALLY_REFUNDED "$(jget "['status']")"
refund $ADMIN $O4 "{\"requestId\":\"$(rid)\",\"kind\":\"ARBITRARY\",\"reason\":\"おわび\",\"amount\":251,\"expectedAmount\":251}"; check "残り返金可能額を超えると400" 400
req $ADMIN GET /api/refunds/orders/$O4; check "管理者は他店舗の注文も見られる" 200

echo "== 同時実行 =="
buy $ALICE "$(items $DRINK 1)" 150; O5=$ORDER; L5=$(sqlv "SELECT id FROM order_lines WHERE order_id='$O5'"); BAL5=$(myBalance $ALICE)
for i in 1 2 3 4; do
  curl -s -o "$TMP/rf$i" -w '%{http_code}\n' -X POST -b $MGR -H "Origin: $BASE" -H 'content-type: application/json' \
    --data "{\"requestId\":\"$(rid)\",\"kind\":\"PARTIAL\",\"reason\":\"同時\",\"lines\":[{\"orderLineId\":\"$L5\",\"quantity\":1,\"restoreStock\":true}],\"expectedAmount\":150}" $BASE/api/refunds/orders/$O5/refund > "$TMP/rfcode$i" &
done; wait
expect "別々の4リクエストで返金は1件だけ成功" 1 "$(cat $TMP/rfcode* | grep -c '^201$')"
expect "残りは拒否(409/400)" 3 "$(cat $TMP/rfcode* | grep -cE '^(409|400)$')"
expect "残高は150だけ増える" $((BAL5+150)) "$(myBalance $ALICE)"
expect "返金の記録は1件" 1 "$(sqlv "SELECT count(*) FROM refunds WHERE order_id='$O5'")"
buy $ALICE "$(items $DRINK 1)" 150; O6=$ORDER; L6=$(sqlv "SELECT id FROM order_lines WHERE order_id='$O6'"); BAL6=$(myBalance $ALICE); SAMER=$(rid)
for i in 1 2 3 4 5; do
  curl -s -o "$TMP/rs$i" -w '%{http_code}\n' -X POST -b $MGR -H "Origin: $BASE" -H 'content-type: application/json' \
    --data "{\"requestId\":\"$SAMER\",\"kind\":\"PARTIAL\",\"reason\":\"同時\",\"lines\":[{\"orderLineId\":\"$L6\",\"quantity\":1,\"restoreStock\":true}],\"expectedAmount\":150}" $BASE/api/refunds/orders/$O6/refund > "$TMP/rscode$i" &
done; wait
ok=0; for i in 1 2 3 4 5; do c=$(cat $TMP/rscode$i); { [ "$c" = "200" ] || [ "$c" = "201" ]; } && ok=$((ok+1)); done
expect "同じIDの同時5リクエストはすべて成功扱い" 5 $ok
expect "返金は1件だけ" 1 "$(sqlv "SELECT count(*) FROM refunds WHERE idempotency_key='$SAMER'")"
expect "1回分だけ戻る" $((BAL6+150)) "$(myBalance $ALICE)"
refund $MGR $O5 "{\"requestId\":\"$SAMER\",\"kind\":\"PARTIAL\",\"reason\":\"x\",\"lines\":[{\"orderLineId\":\"$L5\",\"quantity\":1,\"restoreStock\":true}],\"expectedAmount\":150}"; check "別の注文に同じリクエストIDは使えない" 409; expect "コード" REQUEST_ID_REUSED "$(jget "['error']['code']")"

echo "== 利用履歴(顧客) =="
req $ALICE GET /api/wallet/history; check "履歴" 200
expect "種類(新しい順の先頭は返金)" REFUND "$(jget "['items'][0]['kind']")"
expect "支払いに店舗名と取引番号" "2A 焼きそば/$O1NO" "$(python3 -I -c "import json;d=json.load(open('$TMP/body'));p=[i for i in d['items'] if i['kind']=='PAYMENT' and i['orderNo']=='$O1NO'][0];print(p['shopName']+'/'+p['orderNo'])")"
expect "チャージも含まれる" 1 "$(python3 -I -c "import json;d=json.load(open('$TMP/body'));print(1 if any(i['kind']=='CHARGE' for i in d['items']) else 0)")"
expect "金額の符号(支払い=マイナス)" 1 "$(python3 -I -c "import json;d=json.load(open('$TMP/body'));print(1 if all((i['amount']<0)==(i['kind'] in ('PAYMENT','PAYOUT')) for i in d['items']) else 0)")"
req $BOB GET /api/wallet/history; expect "他人の履歴は混ざらない(Bobは3件以下)" 1 "$(python3 -I -c "import json;d=json.load(open('$TMP/body'));print(1 if all(i['kind'] in ('CHARGE',) for i in d['items']) else 0)")"
req $CLERK GET /api/wallet/history; check "顧客以外は不可" 403
req $ANON GET /api/wallet/history; check "未ログインは401" 401

echo "== 不変条件 =="
expect "全ウォレット: 台帳の合計 = 残高" 0 "$(sqlv "SELECT count(*) FROM wallets w WHERE w.balance <> COALESCE((SELECT SUM(amount) FROM wallet_ledger l WHERE l.wallet_id=w.id),0)")"
expect "全注文: 返金済み額 = 返金の合計" 0 "$(sqlv "SELECT count(*) FROM orders o WHERE o.refunded_total <> COALESCE((SELECT SUM(amount) FROM refunds r WHERE r.order_id=o.id),0)")"
expect "全注文: 返金済み額は実支払額以下" 0 "$(sqlv "SELECT count(*) FROM orders WHERE refunded_total > total_paid")"
expect "状態は返金額と一致(全額=REFUNDED)" 0 "$(sqlv "SELECT count(*) FROM orders WHERE (refunded_total=total_paid AND status<>'REFUNDED') OR (refunded_total>0 AND refunded_total<total_paid AND status<>'PARTIALLY_REFUNDED') OR (refunded_total=0 AND status<>'PAID')")"
expect "明細の返金額 = 返金明細の合計" 0 "$(sqlv "SELECT count(*) FROM order_lines l WHERE l.refunded_amount <> COALESCE((SELECT SUM(amount) FROM refund_lines rl WHERE rl.order_line_id=l.id),0)")"
expect "明細の返金数量 = 返金明細の数量の合計" 0 "$(sqlv "SELECT count(*) FROM order_lines l WHERE l.refunded_quantity <> COALESCE((SELECT SUM(quantity) FROM refund_lines rl WHERE rl.order_line_id=l.id),0)")"
expect "返金の台帳 = 返金額" 0 "$(sqlv "SELECT count(*) FROM refunds r JOIN wallet_ledger l ON l.id=r.ledger_id WHERE l.amount <> r.amount OR l.kind <> 'REFUND'")"
expect "在庫 = 移動の合計(焼きそば)" "$(stock $YAKI)" "$(sqlv "SELECT SUM(delta) FROM stock_movements WHERE product_id='$YAKI'")"
expect "在庫 = 移動の合計(ドリンク は数量管理なし)" "" "$(sqlv "SELECT COALESCE(SUM(delta),'') FROM stock_movements WHERE product_id='$DRINK'")"
expect "返金の監査ログ数 = 返金数" "$(sqlv "SELECT count(*) FROM refunds")" "$(sqlv "SELECT count(*) FROM audit_logs WHERE action LIKE 'refund.%'")"
expect "返金記録は書き換えられない(トリガ)" 1 "$(npx wrangler d1 execute DB --local --command "UPDATE refunds SET amount = 1" 2>&1 | grep -ci "immutable\|append\|cannot\|ABORT")"
expect "返金の金額は変わっていない" 0 "$(sqlv "SELECT count(*) FROM refunds WHERE amount = 1")"

echo
echo "結果: pass=$pass fail=$fail"
[ $fail -eq 0 ]
