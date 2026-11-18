#!/usr/bin/env bash
# festival-qr-pos 店舗のレジ決済(カート・QR読み取り・確定・取消)のスモークテスト。
#
# 前提: ローカルで `vite preview --port 4173` が動いていて、DBが空(migration 適用直後)であること。
# 使い方: bash scripts/smoke-pay.sh
#
# 確認すること: 価格のサーバー再計算(画面の合計と違えば確定しない)、値下げ・売り切れ・在庫の変化、
#   残高不足、冪等(再送/同時送信)、在庫の売り越し防止(同時購入)、セッションの期限・取消、
#   QRの1回限り消費(買えないカートではQRを消費しない)、停止中の顧客、残高と台帳・在庫と移動記録の整合、権限。
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

echo "== 読み取り(scan) =="
QA=$(newQr $ALICE)
scan $CLERK "$QA" '[]'; check "空のカートは400" 400
scan $CLERK "$QA" "$(items $YAKI 100)"; check "数量100は400" 400
scan $CLERK "$QA" "$(items 01ARZ3NDEKTSV4RRFFQ69G5FAV 1)"; check "存在しない商品は409" 409; expect "コード" CART_UNAVAILABLE "$(jget "['error']['code']")"
scan $CLERK "$QA" "$(items $SETONLY 1)"; check "セット専用は単品で買えない" 409
scan $CLERK "$QA" "$(items $YAKI 6)"; check "在庫を超える数量は409" 409; expect "不足メッセージ" "焼きそば は残り5個です" "$(jget "['error']['message']")"
scan $ANON "$QA" "$(items $YAKI 1)"; check "未ログインは401" 401
scan $CLERKB "$QA" "$(items $YAKI 1)"; check "他店舗の店員は不可" 403
req $ALICE POST /api/pos/$SA/pay/scan "{\"token\":\"$QA\",\"items\":$(items $YAKI 1)}"; check "顧客は会計できない" 403
scan $CLERK "FES1:U:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" "$(items $YAKI 1)"; check "存在しないQRは400" 400
scan $CLERK "bad" "$(items $YAKI 1)"; check "形式違いのQRは400" 400
scan $CLERK "$QA" "$(items $YAKI 2 $DRINK 1)"; check "買えないカートで弾かれたQRはまだ使える" 200
S1=$(jget "['sessionId']"); expect "合計(300x2+150)" 750 "$(ptotal)"; expect "お客様名" アリス "$(jget "['customer']['nickname']")"
expect "残高" 1000 "$(jget "['customer']['balance']")"; expect "不足なし" 0 "$(jget "['shortfall']")"
scan $CLERK "$QA" "$(items $YAKI 1)"; check "同じQRの2回目は拒否" 400; expect "コード" QR_USED "$(jget "['error']['code']")"
expect "読み取りだけでは残高・在庫は変わらない" "1000/5" "$(myBalance $ALICE)/$(sqlv "SELECT stock_qty FROM products WHERE id='$YAKI'")"

echo "== 確定 =="
RQ1=$(rid)
commit $CLERK $S1 $RQ1 700; check "画面の合計と違えば確定しない" 409; expect "コード" PRICE_CHANGED "$(jget "['error']['code']")"
expect "新しい見積もりが返る" 750 "$(jget "['error']['details']['quote']['total']")"
expect "拒否時は残高・在庫が不変" "1000/5" "$(myBalance $ALICE)/$(sqlv "SELECT stock_qty FROM products WHERE id='$YAKI'")"
commit $CLERKB $S1 $RQ1 750; check "他店舗の店員は確定できない" 403
commit $CLERK $S1 short 750; check "短いリクエストIDは400" 400
commit $CLERK $S1 $RQ1 750; check "確定" 200; O1=$(jget "['orderId']"); expect "合計" 750 "$(jget "['total']")"; expect "支払い後の残高" 250 "$(jget "['balanceAfter']")"
expect "再送でない" None "$(jget ".get('replayed')")"
expect "残高" 250 "$(myBalance $ALICE)"
expect "焼きそばの在庫" 3 "$(sqlv "SELECT stock_qty FROM products WHERE id='$YAKI'")"
expect "台帳(決済・マイナス)" "PAYMENT/-750/250" "$(sqlv "SELECT kind||'/'||amount||'/'||balance_after FROM wallet_ledger WHERE ref_id='$O1'")"
expect "注文の合計・割引" "750/0/750" "$(sqlv "SELECT subtotal||'/'||discount_total||'/'||total_paid FROM orders WHERE id='$O1'")"
expect "注文明細の件数" 2 "$(sqlv "SELECT count(*) FROM order_lines WHERE order_id='$O1'")"
expect "在庫移動(販売)" "-2/3" "$(sqlv "SELECT delta||'/'||qty_after FROM stock_movements WHERE ref_id='$O1'")"
commit $CLERK $S1 $RQ1 750; check "同じリクエストの再送" 200; expect "再送フラグ" True "$(jget "['replayed']")"; expect "同じ注文" "$O1" "$(jget "['orderId']")"
expect "二重に引かれない" "250/3" "$(myBalance $ALICE)/$(sqlv "SELECT stock_qty FROM products WHERE id='$YAKI'")"
commit $CLERK $S1 $(rid) 750; check "確定済みのセッションに別IDで再確定は409" 409; expect "コード" SESSION_DONE "$(jget "['error']['code']")"
req $CLERK GET /api/pos/$SA/pay/$S1; check "結果の照会" 200; expect "状態" COMMITTED "$(jget "['status']")"; expect "照会で同じ注文" "$O1" "$(jget "['result']['orderId']")"
req $CLERKB GET /api/pos/$SA/pay/$S1; check "他店舗は照会できない" 403
req $CLERK POST /api/pos/$SA/pay/$S1/cancel '{}'; check "確定後の取消は409" 409
expect "決済の監査ログ" 1 "$(sqlv "SELECT count(*) FROM audit_logs WHERE action='payment.commit' AND target_id='$O1'")"

echo "== 残高不足・取消 =="
QA2=$(newQr $ALICE); scan $CLERK "$QA2" "$(items $YAKI 1 $DRINK 1)"; check "読み取り(合計450・残高250)" 200; S2=$(jget "['sessionId']")
expect "不足額" 200 "$(jget "['shortfall']")"
commit $CLERK $S2 $(rid) 450; check "残高不足は確定できない" 409; expect "コード" INSUFFICIENT_BALANCE "$(jget "['error']['code']")"
expect "残高・在庫は不変" "250/3" "$(myBalance $ALICE)/$(sqlv "SELECT stock_qty FROM products WHERE id='$YAKI'")"
req $CLERK POST /api/pos/$SA/pay/$S2/cancel '{}'; check "取消" 200
commit $CLERK $S2 $(rid) 450; check "取消後は確定できない" 409; expect "コード" SESSION_CANCELLED "$(jget "['error']['code']")"
req $CLERK GET /api/pos/$SA/pay/$S2; expect "状態" CANCELLED "$(jget "['status']")"
charge $R1 $ALICE 1000; check "Alice追加チャージ" 201; expect "残高1250" 1250 "$(myBalance $ALICE)"

echo "== 値下げと価格の変化 =="
req $MGR POST /api/catalog/$SA/price-cuts '{"name":"タイムセール","method":"PERCENT","value":20}'; check "20%引き" 201; CUT=$(jget "['id']")
QA3=$(newQr $ALICE); scan $CLERK "$QA3" "$(items $YAKI 1 $OMAKE 1)"; check "値下げ中に読み取り" 200; S3=$(jget "['sessionId']")
expect "合計(300→240 + 100は対象外)" 340 "$(ptotal)"; expect "値下げ名" タイムセール "$(jget "['quote']['cut']['name']")"
req $MGR POST /api/catalog/$SA/price-cuts/$CUT/stop '{}'; check "確定前に値下げが終了" 200
commit $CLERK $S3 $(rid) 340; check "古い合計では確定しない" 409; expect "コード" PRICE_CHANGED "$(jget "['error']['code']")"; expect "新しい合計" 400 "$(jget "['error']['details']['quote']['total']")"
expect "不変" 1250 "$(myBalance $ALICE)"
req $MGR POST /api/catalog/$SA/price-cuts '{"name":"再開セール","method":"FIXED","value":50}'; check "50円引きで再開" 201
commit $CLERK $S3 $(rid) 400; check "値下げ後の合計でも、いまの価格と違えば確定しない" 409; expect "新しい合計(250+100)" 350 "$(jget "['error']['details']['quote']['total']")"
RQ3=$(rid); commit $CLERK $S3 $RQ3 350; check "新しい合計で確定" 200; O3=$(jget "['orderId']")
expect "明細に定価と値下げ後を記録" "300/250/再開セール" "$(sqlv "SELECT list_unit_price||'/'||unit_price||'/'||price_cut_name FROM order_lines WHERE order_id='$O3' AND product_id='$YAKI'")"
expect "対象外の商品は値下げなし" "100/100/" "$(sqlv "SELECT list_unit_price||'/'||unit_price||'/'||COALESCE(price_cut_name,'') FROM order_lines WHERE order_id='$O3' AND product_id='$OMAKE'")"
expect "残高" 900 "$(myBalance $ALICE)"
req $MGR GET /api/catalog/$SA/price-cuts; CUT2=$(python3 -I -c "import json;print([c for c in json.load(open('$TMP/body'))['cuts'] if c['state']=='RUNNING'][0]['id'])")
req $MGR POST /api/catalog/$SA/price-cuts/$CUT2/stop '{}'; check "値下げ停止" 200

echo "== 売り切れの変化 =="
QA4=$(newQr $ALICE); scan $CLERK "$QA4" "$(items $DRINK 1)"; check "読み取り" 200; S4=$(jget "['sessionId']")
req $CLERK POST /api/pos/$SA/products/$DRINK/sold-out '{"soldOut":true}'; check "確定前に売り切れ" 200
commit $CLERK $S4 $(rid) 150; check "売り切れの商品は確定できない" 409; expect "コード" CART_UNAVAILABLE "$(jget "['error']['code']")"
expect "不変" 900 "$(myBalance $ALICE)"
req $CLERK POST /api/pos/$SA/products/$DRINK/sold-out '{"soldOut":false}'; check "販売再開" 200
commit $CLERK $S4 $(rid) 150; check "再開後は確定できる" 200

echo "== 期限切れ =="
QA5=$(newQr $ALICE); scan $CLERK "$QA5" "$(items $DRINK 1)"; S5=$(jget "['sessionId']")
sql "UPDATE payment_sessions SET expires_at = $(( $(date +%s) * 1000 - 1000 )) WHERE id='$S5'" >/dev/null
commit $CLERK $S5 $(rid) 150; check "期限切れは確定できない" 409; expect "コード" SESSION_EXPIRED "$(jget "['error']['code']")"
req $CLERK GET /api/pos/$SA/pay/$S5; expect "照会でも期限切れ" EXPIRED "$(jget "['status']")"
expect "期限切れで残高は不変" 750 "$(myBalance $ALICE)"

echo "== 同時実行 =="
QA6=$(newQr $ALICE); scan $CLERK "$QA6" "$(items $DRINK 1)"; S6=$(jget "['sessionId']"); SAME=$(rid)
for i in 1 2 3 4 5 6; do
  curl -s -o "$TMP/par$i" -w '%{http_code}\n' -X POST -b $CLERK -H "Origin: $BASE" -H 'content-type: application/json' \
    --data "{\"requestId\":\"$SAME\",\"expectedTotal\":150}" $BASE/api/pos/$SA/pay/$S6/commit > "$TMP/parcode$i" &
done; wait
ok=0; for i in 1 2 3 4 5 6; do [ "$(cat $TMP/parcode$i)" = "200" ] && ok=$((ok+1)); done
expect "同じIDの同時6リクエストはすべて成功扱い" 6 $ok
expect "注文は1件だけ" 1 "$(sqlv "SELECT count(*) FROM orders WHERE idempotency_key='$SAME'")"
expect "1回分だけ引かれる" 600 "$(myBalance $ALICE)"
# 別々のセッションを同じ requestId で確定しようとする
QA7=$(newQr $ALICE); scan $CLERK "$QA7" "$(items $DRINK 1)"; S7=$(jget "['sessionId']")
commit $CLERK $S7 $SAME 150; check "別の決済に同じリクエストIDは使えない" 409; expect "コード" REQUEST_ID_REUSED "$(jget "['error']['code']")"
req $CLERK POST /api/pos/$SA/pay/$S7/cancel '{}'

echo "== 在庫の売り越し(同時購入) =="
QA8=$(newQr $ALICE); QB8=$(newQr $BOB)
scan $CLERK "$QA8" "$(items $ONE 1)"; check "Aliceが読み取り(残り1個)" 200; S8A=$(jget "['sessionId']")
scan $CLERK "$QB8" "$(items $ONE 1)"; check "Bobも読み取り(まだ残り1個)" 200; S8B=$(jget "['sessionId']")
for who in A B; do
  sid=$([ $who = A ] && echo $S8A || echo $S8B)
  curl -s -o "$TMP/race$who" -w '%{http_code}\n' -X POST -b $CLERK -H "Origin: $BASE" -H 'content-type: application/json' \
    --data "{\"requestId\":\"$(rid)\",\"expectedTotal\":100}" $BASE/api/pos/$SA/pay/$sid/commit > "$TMP/racecode$who" &
done; wait
expect "同時購入で成功は1件だけ" 1 "$(cat $TMP/racecode* | grep -c '^200$')"
expect "もう1件は409" 1 "$(cat $TMP/racecode* | grep -c '^409$')"
expect "在庫は0(マイナスにならない)" 0 "$(sqlv "SELECT stock_qty FROM products WHERE id='$ONE'")"
expect "1個分だけ売れた" 1 "$(sqlv "SELECT count(*) FROM order_lines WHERE product_id='$ONE'")"
expect "売り越しで失敗した決済は何も残らない(台帳)" 1 "$(sqlv "SELECT count(*) FROM wallet_ledger WHERE kind='PAYMENT' AND amount=-100")"
req $CLERK GET /api/pos/$SA/catalog; expect "在庫0は自動で売り切れ表示" STOCK "$(python3 -I -c "import json;print([p for p in json.load(open('$TMP/body'))['products'] if p['name']=='限定1個'][0]['soldOutReason'])")"

echo "== 停止中の顧客 =="
QB9=$(newQr $BOB)
req $ADMIN GET /api/admin/users; BOB_ID=$(python3 -I -c "import json;print([u for u in json.load(open('$TMP/body'))['users'] if u['nickname']=='ボブ'][0]['id'])")
req $ADMIN PATCH /api/admin/users/$BOB_ID/status '{"status":"SUSPENDED"}'; check "Bobを停止" 200
scan $CLERK "$QB9" "$(items $DRINK 1)"; check "停止中の顧客は決済できない" 403; expect "コード" WALLET_INACTIVE "$(jget "['error']['code']")"
req $ADMIN PATCH /api/admin/users/$BOB_ID/status '{"status":"ACTIVE"}'; check "Bobを再開" 200

echo "== 設定 =="
req $ADMIN PUT /api/admin/settings/operations '{"closingMode":"DAY","qrTtlSeconds":300,"paymentSessionSeconds":30}'; check "30秒は拒否" 400
req $ADMIN PUT /api/admin/settings/operations '{"closingMode":"DAY","qrTtlSeconds":300,"paymentSessionSeconds":600}'; check "決済セッション10分に変更" 200
QA10=$(newQr $ALICE); scan $CLERK "$QA10" "$(items $DRINK 1)"; expect "新しい有効時間が使われる" 600 "$(python3 -I -c "import json;d=json.load(open('$TMP/body'));print(round((d['expiresAt']-__import__('time').time()*1000)/1000/10)*10)")"
req $CLERK POST /api/pos/$SA/pay/$(jget "['sessionId']")/cancel '{}'

echo "== 不変条件 =="
expect "全ウォレット: 台帳の合計 = 残高" 0 "$(sqlv "SELECT count(*) FROM wallets w WHERE w.balance <> COALESCE((SELECT SUM(amount) FROM wallet_ledger l WHERE l.wallet_id=w.id),0)")"
expect "全注文: 明細の合計 = 注文の合計" 0 "$(sqlv "SELECT count(*) FROM orders o WHERE o.total_paid <> (SELECT SUM(line_paid) FROM order_lines l WHERE l.order_id=o.id)")"
expect "全注文: 注文の合計 = 台帳の決済額" 0 "$(sqlv "SELECT count(*) FROM orders o JOIN wallet_ledger l ON l.id=o.ledger_id WHERE -l.amount <> o.total_paid")"
expect "在庫 = 初期 + 移動の合計(焼きそば)" "$(sqlv "SELECT stock_qty FROM products WHERE id='$YAKI'")" "$(sqlv "SELECT SUM(delta) FROM stock_movements WHERE product_id='$YAKI'")"
expect "在庫 = 初期 + 移動の合計(限定1個)" "$(sqlv "SELECT stock_qty FROM products WHERE id='$ONE'")" "$(sqlv "SELECT SUM(delta) FROM stock_movements WHERE product_id='$ONE'")"
expect "確定済みセッションは注文と1対1" 0 "$(sqlv "SELECT count(*) FROM payment_sessions s WHERE s.status='COMMITTED' AND (s.order_id IS NULL OR NOT EXISTS (SELECT 1 FROM orders o WHERE o.id=s.order_id))")"
expect "確定していないセッションに注文はない" 0 "$(sqlv "SELECT count(*) FROM payment_sessions WHERE status<>'COMMITTED' AND order_id IS NOT NULL")"
expect "決済の監査ログ数 = 注文数" "$(sqlv "SELECT count(*) FROM orders")" "$(sqlv "SELECT count(*) FROM audit_logs WHERE action='payment.commit'")"

echo
echo "結果: pass=$pass fail=$fail"
[ $fail -eq 0 ]
