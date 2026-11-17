#!/usr/bin/env bash
# festival-qr-pos 受付(チャージ・払戻し・途中回収・訂正・締め)のスモークテスト。
#
# 前提: ローカルで `vite preview --port 4173` が動いていて、DBが空(migration 適用直後)であること。
#       .dev.vars の SETUP_TOKEN と同じ値を SETUP_TOKEN 環境変数で渡す(既定は local-setup-token-for-testing)。
# 使い方: bash scripts/smoke-cash.sh
#
# 確認すること: 冪等(同じリクエストの再送/同時送信)、同時実行での残高整合、QRの1回限り消費、
#   払戻しの残高照合、訂正、現金の期待額、締め(確定後は変更不可)、権限。
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

ADMIN=$TMP/admin.jar; ALICE=$TMP/alice.jar; BOB=$TMP/bob.jar; R1=$TMP/r1.jar; R2=$TMP/r2.jar; ANON=$TMP/anon.jar

echo "== 準備 =="
curl -s -o "$TMP/body" -w '%{http_code}' -X POST -H "Origin: $BASE" -H 'content-type: application/json' -H "x-setup-token: $SETUP_TOKEN" -c $ADMIN \
  --data '{"loginId":"admin","password":"adminpass1","nickname":"運営"}' $BASE/api/setup/admin > "$TMP/code"
if [ "$(code)" != "201" ]; then req $ADMIN POST /api/auth/login '{"loginId":"admin","password":"adminpass1"}'; fi
req $ADMIN GET /api/auth/me; check "管理者 me" 200
req $ALICE POST /api/auth/register '{"email":"alice@example.com","password":"alicepass1","nickname":"アリス"}'; check "顧客Alice登録" 201
req $BOB POST /api/auth/register '{"email":"bob@example.com","password":"bobpass123","nickname":"ボブ"}'; check "顧客Bob登録" 201
req $ADMIN POST /api/admin/users/reception '{"nickname":"受付A"}'; check "受付A作成" 201; RA_ID=$(jget "['userId']"); RA_TOK=$(jget "['token']")
req $ADMIN POST /api/admin/users/reception '{"nickname":"受付B"}'; check "受付B作成" 201; RB_TOK=$(jget "['token']")
req $R1 POST /api/auth/reception-login "{\"token\":\"$RA_TOK\"}"; check "受付Aログイン" 200
req $R2 POST /api/auth/reception-login "{\"token\":\"$RB_TOK\"}"; check "受付Bログイン" 200

echo "== 顧客QR(読み取り=消費) =="
req $ANON POST /api/wallet/qr '{}'; check "未ログインはQR発行不可" 401
req $R1 POST /api/wallet/qr '{}'; check "受付は顧客QRを発行できない" 403
Q1=$(newQr $ALICE); echo "     形式: ${Q1:0:8}… (len ${#Q1})"
lookup $R1 "$Q1"; check "受付AがAliceのQRを読み取り" 200; L1=$(jget "['lookupId']"); expect "残高0" 0 "$(jget "['wallet']['balance']")"
lookup $R1 "$Q1"; check "同じQRの2回目は拒否(使用済み)" 400; expect "理由コード" QR_USED "$(jget "['error']['code']")"
Q2=$(newQr $ALICE); Q3=$(newQr $ALICE)
lookup $R1 "$Q2"; check "新QR作成で旧QRは無効" 400; expect "理由コード" QR_REPLACED "$(jget "['error']['code']")"
lookup $R1 "FES1:U:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; check "存在しないQR" 400
lookup $R1 "FES1:R:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; check "他種別のQRは拒否" 400
req $ADMIN POST /api/reception/lookup "{\"token\":\"$Q3\"}"; check "管理者は読み取れない" 403
req $ALICE POST /api/reception/charge "{\"lookupId\":\"$L1\",\"requestId\":\"$(rid)\",\"cashAmount\":100}"; check "顧客はチャージ不可" 403

echo "== チャージ =="
REQ1=$(rid)
req $R1 POST /api/reception/charge "{\"lookupId\":\"$L1\",\"requestId\":\"$REQ1\",\"cashAmount\":1000}"; check "1000円チャージ" 201
expect "残高" 1000 "$(jget "['balanceAfter']")"; LED1=$(jget "['ledgerId']"); expect "再送でない" False "$(jget "['replayed']")"
req $R1 POST /api/reception/charge "{\"lookupId\":\"$L1\",\"requestId\":\"$REQ1\",\"cashAmount\":1000}"; check "同じリクエストの再送" 200
expect "再送フラグ" True "$(jget "['replayed']")"; expect "同じ取引" "$LED1" "$(jget "['ledgerId']")"
expect "残高は二重加算されない" 1000 "$(myBalance $ALICE)"
req $R1 POST /api/reception/charge "{\"lookupId\":\"$L1\",\"requestId\":\"$REQ1\",\"cashAmount\":2000}"; check "同じIDで金額違いはエラー(元の結果を黙って返さない)" 409
expect "残高そのまま" 1000 "$(myBalance $ALICE)"
req $R1 POST /api/reception/charge "{\"lookupId\":\"$L1\",\"requestId\":\"$(rid)\",\"cashAmount\":0}"; check "0円は拒否" 400
req $R1 POST /api/reception/charge "{\"lookupId\":\"$L1\",\"requestId\":\"$(rid)\",\"cashAmount\":1000001}"; check "上限超過は拒否" 400
req $R1 POST /api/reception/charge "{\"lookupId\":\"$L1\",\"requestId\":\"$(rid)\",\"cashAmount\":10.5}"; check "小数は拒否" 400
req $R1 POST /api/reception/charge "{\"lookupId\":\"$L1\",\"requestId\":\"short\",\"cashAmount\":100}"; check "短すぎるリクエストID" 400
req $R2 POST /api/reception/charge "{\"lookupId\":\"$L1\",\"requestId\":\"$(rid)\",\"cashAmount\":100}"; check "他の受付の読み取りは使えない" 400; expect "コード" LOOKUP_NOT_FOUND "$(jget "['error']['code']")"
req $R2 POST /api/reception/charge "{\"lookupId\":\"$L1\",\"requestId\":\"$REQ1\",\"cashAmount\":1000}"; check "他の受付が同じリクエストIDを使えない" 400

echo "== 同時実行 =="
SAME=$(rid)
for i in 1 2 3 4 5 6; do
  curl -s -o "$TMP/par$i" -w '%{http_code}\n' -X POST -b $R1 -H "Origin: $BASE" -H 'content-type: application/json' \
    --data "{\"lookupId\":\"$L1\",\"requestId\":\"$SAME\",\"cashAmount\":500}" $BASE/api/reception/charge > "$TMP/parcode$i" &
done; wait
ok=0; for i in 1 2 3 4 5 6; do c=$(cat "$TMP/parcode$i"); [ "$c" = "200" ] || [ "$c" = "201" ] && ok=$((ok+1)); done
expect "同じIDの同時6リクエストはすべて成功扱い" 6 $ok
expect "ただし台帳は1件だけ" 1 "$(sqlv "SELECT count(*) FROM wallet_ledger WHERE idempotency_key='$SAME'")"
expect "残高は500だけ増える" 1500 "$(myBalance $ALICE)"
for i in $(seq 1 10); do
  curl -s -o /dev/null -X POST -b $R1 -H "Origin: $BASE" -H 'content-type: application/json' \
    --data "{\"lookupId\":\"$L1\",\"requestId\":\"$(rid)\",\"cashAmount\":100}" $BASE/api/reception/charge &
done; wait
expect "別IDの同時10チャージ(100円)がすべて反映" 2500 "$(myBalance $ALICE)"
expect "balance_after が重複しない(直列化されている)" 12 "$(sqlv "SELECT count(DISTINCT balance_after) FROM wallet_ledger")"

echo "== 払戻し =="
lookup $R1 "$Q3"; check "AliceのQR(Q3)を読み取り" 200; L3=$(jget "['lookupId']"); expect "読み取り時の残高" 2500 "$(jget "['wallet']['balance']")"
req $R1 POST /api/reception/payout "{\"lookupId\":\"$L3\",\"requestId\":\"$(rid)\",\"expectedBalance\":2499}"; check "画面の残高と違えば拒否" 409; expect "コード" BALANCE_CHANGED "$(jget "['error']['code']")"
expect "拒否時は残高不変" 2500 "$(myBalance $ALICE)"
PREQ=$(rid)
req $R1 POST /api/reception/payout "{\"lookupId\":\"$L3\",\"requestId\":\"$PREQ\",\"expectedBalance\":2500}"; check "全額払戻し" 201
expect "現金" 2500 "$(jget "['cashAmount']")"; expect "残高0" 0 "$(jget "['balanceAfter']")"
req $R1 POST /api/reception/payout "{\"lookupId\":\"$L3\",\"requestId\":\"$PREQ\",\"expectedBalance\":2500}"; check "払戻しの再送" 200; expect "再送フラグ" True "$(jget "['replayed']")"
expect "二重払戻しされない" 0 "$(myBalance $ALICE)"
req $R1 POST /api/reception/payout "{\"lookupId\":\"$L3\",\"requestId\":\"$(rid)\",\"expectedBalance\":2500}"; check "残高0で再度の払戻しは拒否" 409
expect "払戻しの台帳は1件" 1 "$(sqlv "SELECT count(*) FROM wallet_ledger WHERE kind='PAYOUT'")"
expect "現金台帳の出金は1件(2500円)" "2500" "$(sqlv "SELECT COALESCE(SUM(amount),0) FROM cash_events WHERE kind='PAYOUT'")"
# 同時払戻し(別リクエストID): 1回だけ成功する
Q4=$(newQr $ALICE); lookup $R1 "$Q4"; L4=$(jget "['lookupId']")
req $R1 POST /api/reception/charge "{\"lookupId\":\"$L4\",\"requestId\":\"$(rid)\",\"cashAmount\":700}"; check "再チャージ(払戻し後も使える)" 201
for i in 1 2 3 4; do
  curl -s -o /dev/null -w '%{http_code}\n' -X POST -b $R1 -H "Origin: $BASE" -H 'content-type: application/json' \
    --data "{\"lookupId\":\"$L4\",\"requestId\":\"$(rid)\",\"expectedBalance\":700}" $BASE/api/reception/payout > "$TMP/pp$i" &
done; wait
okp=0; for i in 1 2 3 4; do [ "$(cat "$TMP/pp$i")" = "201" ] && okp=$((okp+1)); done
expect "別IDの同時4払戻しのうち成功は1回だけ" 1 $okp
expect "残高は0(マイナスにならない)" 0 "$(myBalance $ALICE)"

echo "== 訂正 =="
Q5=$(newQr $BOB); lookup $R1 "$Q5"; L5=$(jget "['lookupId']")
req $R1 POST /api/reception/charge "{\"lookupId\":\"$L5\",\"requestId\":\"$(rid)\",\"cashAmount\":300}"; check "Bobに300円チャージ" 201; BLED=$(jget "['ledgerId']")
CREQ=$(rid)
req $R1 POST /api/reception/charge/$BLED/correct "{\"requestId\":\"$CREQ\",\"newCashAmount\":200,\"reason\":\"入力ミス\"}"; check "300→200に訂正" 201
expect "残高200" 200 "$(myBalance $BOB)"
req $R1 POST /api/reception/charge/$BLED/correct "{\"requestId\":\"$CREQ\",\"newCashAmount\":200,\"reason\":\"入力ミス\"}"; check "訂正の再送" 200; expect "再送フラグ" True "$(jget "['replayed']")"
expect "訂正は二重適用されない" 200 "$(myBalance $BOB)"
req $R1 POST /api/reception/charge/$BLED/correct "{\"requestId\":\"$(rid)\",\"newCashAmount\":200,\"reason\":\"同じ\"}"; check "同額への訂正は拒否" 400; expect "コード" NO_CHANGE "$(jget "['error']['code']")"
req $R1 POST /api/reception/charge/$BLED/correct "{\"requestId\":\"$(rid)\",\"newCashAmount\":400,\"reason\":\"やはり400\"}"; check "200→400に再訂正(元の記録は残る)" 201
expect "残高400" 400 "$(myBalance $BOB)"
req $R1 POST /api/reception/charge/$BLED/correct "{\"requestId\":\"$(rid)\",\"newCashAmount\":400}"; check "理由なしは拒否" 400
req $R2 POST /api/reception/charge/$BLED/correct "{\"requestId\":\"$(rid)\",\"newCashAmount\":350,\"reason\":\"別の受付が訂正\"}"; check "別の受付も訂正できる" 201
expect "残高350" 350 "$(myBalance $BOB)"
expect "元のチャージ台帳は書き換わっていない(300のまま)" 300 "$(sqlv "SELECT amount FROM wallet_ledger WHERE id='$BLED'")"
expect "有効な受領額=300+(-100)+200+(-50)=350" 350 "$(sqlv "SELECT SUM(e.amount) FROM cash_events e JOIN wallet_ledger l ON l.id=e.ledger_id WHERE l.id='$BLED' OR l.corrects_ledger_id='$BLED'")"
req $R1 POST /api/reception/charge/$(rid | head -c 26)/correct "{\"requestId\":\"$(rid)\",\"newCashAmount\":1,\"reason\":\"x\"}"; check "存在しないチャージは404(または検証エラー)" 404
# 使われた分は訂正できない: 残高を払い戻して0にしてから減額訂正
Q6=$(newQr $BOB); lookup $R1 "$Q6"; L6=$(jget "['lookupId']")
req $R1 POST /api/reception/payout "{\"lookupId\":\"$L6\",\"requestId\":\"$(rid)\",\"expectedBalance\":350}"; check "Bobの残高を全額払戻し" 201
req $R1 POST /api/reception/charge/$BLED/correct "{\"requestId\":\"$(rid)\",\"newCashAmount\":10,\"reason\":\"減額\"}"; check "残高不足の減額訂正は拒否" 409; expect "コード" INSUFFICIENT_FOR_CORRECTION "$(jget "['error']['code']")"
expect "拒否時は残高不変" 0 "$(myBalance $BOB)"

echo "== 途中回収 =="
DREQ=$(rid)
req $R1 POST /api/reception/cash/drop "{\"requestId\":\"$DREQ\",\"amount\":1000,\"note\":\"金庫へ\"}"; check "1000円を途中回収" 201
req $R1 POST /api/reception/cash/drop "{\"requestId\":\"$DREQ\",\"amount\":1000,\"note\":\"金庫へ\"}"; check "再送" 200; expect "再送フラグ" True "$(jget "['replayed']")"
expect "途中回収は1件だけ" 1 "$(sqlv "SELECT count(*) FROM cash_events WHERE kind='DROP'")"
req $R1 POST /api/reception/cash/drop "{\"requestId\":\"$(rid)\",\"amount\":0}"; check "0円は拒否" 400

echo "== 集計(受付A) =="
req $R1 GET /api/reception/summary; check "受付Aの集計" 200
# 受付Aの期待額を DB から独立に計算して突き合わせる
EXP_A=$(sqlv "SELECT COALESCE(SUM(CASE kind WHEN 'CHARGE' THEN amount WHEN 'PAYOUT' THEN -amount WHEN 'DROP' THEN -amount ELSE amount END),0) FROM cash_events WHERE reception_user_id='$RA_ID'")
expect "APIの期待現金額 = DBからの独立計算" "$EXP_A" "$(jget "['totals']['expected']")"
echo "     受付A: $(jget "['totals']")"
expect "締めの単位の既定は日次" DAY "$(jget "['closingMode']")"
expect "日次のとき受付は自分で締められない" False "$(jget "['canCloseSelf']")"

echo "== 整合性(全体) =="
expect "全ウォレットで 残高 = 台帳の合計" 0 "$(sqlv "SELECT count(*) FROM wallets w WHERE w.balance <> COALESCE((SELECT SUM(amount) FROM wallet_ledger l WHERE l.wallet_id=w.id),0)")"
expect "最後の台帳の balance_after = 残高" 0 "$(sqlv "SELECT count(*) FROM wallets w WHERE w.balance <> COALESCE((SELECT balance_after FROM wallet_ledger l WHERE l.wallet_id=w.id ORDER BY l.created_at DESC, l.id DESC LIMIT 1),0)")"
expect "ポイントの流入 − 流出 = 残高の合計" "$(sqlv "SELECT COALESCE(SUM(balance),0) FROM wallets")" "$(sqlv "SELECT COALESCE(SUM(amount),0) FROM wallet_ledger")"
expect "台帳に対応する現金イベントが無い台帳はない" 0 "$(sqlv "SELECT count(*) FROM wallet_ledger l WHERE NOT EXISTS (SELECT 1 FROM cash_events e WHERE e.ledger_id=l.id)")"
expect "現金イベントの金額 × 通貨比率(1円=1pt) = 台帳の金額(符号込み)" 0 "$(sqlv "SELECT count(*) FROM cash_events e JOIN wallet_ledger l ON l.id=e.ledger_id WHERE (e.kind IN ('CHARGE','CORRECTION') AND e.amount <> l.amount) OR (e.kind='PAYOUT' AND e.amount <> -l.amount)")"
expect "台帳は書き換え不可(トリガ)" 1 "$(npx wrangler d1 execute DB --local --command "UPDATE wallet_ledger SET amount = amount + 1" 2>&1 | grep -c 'append-only')"

echo "== 締め =="
req $R1 POST /api/cash/closings '{"target":"SELF"}'; check "日次設定では受付は締められない" 403
req $R1 POST /api/cash/closings '{"target":"ALL"}'; check "受付は全体を締められない" 403
req $ADMIN GET /api/cash/admin-summary; check "管理者の現金集計" 200; echo "     合計: $(jget "['total']")"
req $R1 GET /api/cash/admin-summary; check "受付は管理者の集計を見られない" 403
req $ADMIN PUT /api/admin/settings/operations '{"closingMode":"SHIFT","qrTtlSeconds":30}'; check "QR有効時間30秒は拒否" 400
req $ADMIN PUT /api/admin/settings/operations '{"closingMode":"SHIFT","qrTtlSeconds":300}'; check "締めの単位を担当者交代ごとに変更" 200
req $R1 GET /api/reception/summary; expect "受付が自分で締められる" True "$(jget "['canCloseSelf']")"
# 実運用に近づけるため、締める前に受付Aが十分な額をチャージして、期待現金額を正の値にしておく
Q8=$(newQr $ALICE); lookup $R1 "$Q8"; L8=$(jget "['lookupId']")
req $R1 POST /api/reception/charge "{\"lookupId\":\"$L8\",\"requestId\":\"$(rid)\",\"cashAmount\":5000}"; check "締め前に5000円チャージ" 201
req $R1 GET /api/reception/summary
EXP_A=$(jget "['totals']['expected']")
expect "期待額は正の値" True "$([ "$EXP_A" -gt 0 ] && echo True || echo False)"
req $R1 POST /api/cash/closings '{"target":"SELF","countedAmount":'$((EXP_A - 30))',"note":"30円足りない"}'; check "受付Aが自分の分を締める" 201
expect "期待額" "$EXP_A" "$(jget "['closing']['expectedAmount']")"
expect "差異(数えた額−期待額)" -30 "$(jget "['closing']['difference']")"
expect "締め種別" SHIFT "$(jget "['closing']['scopeKind']")"
req $R1 GET /api/reception/summary; expect "締め後の未締め件数は0" 0 "$(jget "['totals']['eventCount']")"; expect "締め後の期待額は0" 0 "$(jget "['totals']['expected']")"
req $R1 POST /api/cash/closings '{"target":"SELF"}'; check "続けて締めると対象なしで409" 409; expect "コード" NOTHING_TO_CLOSE "$(jget "['error']['code']")"
expect "締めた現金イベントは変更不可(トリガ)" 1 "$(npx wrangler d1 execute DB --local --command "UPDATE cash_events SET amount = amount + 1 WHERE closing_id IS NOT NULL" 2>&1 | grep -c 'immutable')"
expect "締めは書き換え不可(トリガ)" 1 "$(npx wrangler d1 execute DB --local --command "UPDATE cash_closings SET expected_amount = 0" 2>&1 | grep -c 'immutable')"
# 締め後の訂正は新しい(未締めの)イベントになる
req $R1 POST /api/reception/charge/$BLED/correct "{\"requestId\":\"$(rid)\",\"newCashAmount\":0,\"reason\":\"締め後の訂正\"}"; check "残高0の状態での減額訂正は拒否" 409
# 受付Bの分を管理者が締める
req $ADMIN POST /api/cash/closings "{\"target\":\"USER\",\"userId\":\"$RA_ID\"}"; check "未締めのない担当者を指定すると対象なし" 409
req $ADMIN POST /api/cash/closings '{"target":"ALL","countedAmount":0}'; check "管理者が全受付を締める(Bの分)" 201; echo "     $(jget "['closing']")"
req $ADMIN GET /api/cash/closings; check "締めの履歴(管理者)" 200; expect "履歴は2件" 2 "$(python3 -I -c "import json;print(len(json.load(open('$TMP/body'))['closings']))")"

echo "== 停止中のお客様 =="
Q7=$(newQr $BOB); lookup $R1 "$Q7"; L7=$(jget "['lookupId']")
req $ADMIN GET '/api/admin/users?role=CUSTOMER'; BOBID=$(python3 -I -c "import json;print([u['id'] for u in json.load(open('$TMP/body'))['users'] if u['nickname']=='ボブ'][0])")
req $ADMIN PATCH /api/admin/users/$BOBID/status '{"status":"SUSPENDED"}'; check "Bobを停止" 200
req $R1 POST /api/reception/charge "{\"lookupId\":\"$L7\",\"requestId\":\"$(rid)\",\"cashAmount\":500}"; check "停止中のお客様にはチャージできない" 409; expect "コード" WALLET_INACTIVE "$(jget "['error']['code']")"
expect "チャージの台帳は作られていない" 0 "$(sqlv "SELECT count(*) FROM wallet_ledger l JOIN wallets w ON w.id=l.wallet_id JOIN users u ON u.id=w.owner_user_id WHERE u.id='$BOBID' AND l.amount=500")"
expect "失敗した操作の監査ログは残らない(cash.charge は成功分のみ)" "$(sqlv "SELECT count(*) FROM wallet_ledger WHERE kind='CHARGE'")" "$(sqlv "SELECT count(*) FROM audit_logs WHERE action='cash.charge'")"

echo
echo "結果: pass=$pass fail=$fail"
[ $fail -eq 0 ]
