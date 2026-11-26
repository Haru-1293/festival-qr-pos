#!/usr/bin/env bash
# 受付でのカード有効化(チャージ同時)・残高照会のスモークテスト。
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
echo "== 準備 =="
curl -s -o /dev/null -X POST -H "Origin: $BASE" -H 'content-type: application/json' -H "x-setup-token: $SETUP_TOKEN" -c $ADMIN --data '{"loginId":"admin","password":"adminpass1","nickname":"運営"}' $BASE/api/setup/admin
req $ADMIN POST /api/auth/login '{"loginId":"admin","password":"adminpass1"}'; check "管理者ログイン" 200
req $ADMIN POST /api/admin/shops '{"name":"3A 焼きそば","displayName":"3A 焼きそば"}'; SA=$(jget "['shop']['id']")
req $ADMIN POST /api/admin/users/shop-manager "{\"shopId\":\"$SA\",\"loginId\":\"mgr-a\",\"password\":\"mgrpass123\",\"nickname\":\"A責任者\"}"
req $MGR POST /api/auth/login '{"loginId":"mgr-a","password":"mgrpass123"}'; check "責任者ログイン" 200
req $MGR POST /api/shops/$SA/staff '{"loginId":"clerk-a","password":"clerkpass1","nickname":"A店員"}'
req $CLERK POST /api/auth/login '{"loginId":"clerk-a","password":"clerkpass1"}'; check "店員ログイン" 200
req $ADMIN POST /api/admin/users/reception '{"nickname":"受付A","loginId":"recep-a","password":"recepass123"}'
req $R1 POST /api/auth/login '{"loginId":"recep-a","password":"recepass123"}'; check "受付ログイン" 200
req $ADMIN POST /api/cards/issue '{"count":4}'; check "カード4枚発行" 201
python3 -I -c "
import json;d=json.load(open('$TMP/body'))['cards']
open('$TMP/ids','w').write(' '.join(c['id'] for c in d));open('$TMP/toks','w').write(' '.join(c['token'] for c in d))"
read -r C1 C2 C3 C4 < $TMP/ids; read -r T1 T2 T3 T4 < $TMP/toks

echo "== 未有効カードの扱い =="
lookup $R1 $T1; check "未有効カードの照会は403" 403
expect "コード" CARD_NOT_ACTIVATED "$(jget "['error']['code']")"

echo "== 受付での有効化(チャージなし) =="
req $R1 POST /api/reception/activate-card "{\"token\":\"$T1\",\"nickname\":\"たろう\",\"pin\":\"1234\",\"requestId\":\"$(rid)\"}"; check "有効化のみ" 201
expect "チャージなし" None "$(jget "['charge']")"
expect "残高0" 0 "$(jget "['lookup']['wallet']['balance']")"
expect "カードがACTIVE" ACTIVE "$(sqlv "SELECT status FROM cards WHERE id='$C1'")"
expect "ニックネーム" たろう "$(sqlv "SELECT nickname FROM cards WHERE id='$C1'")"
expect "監査ログ(有効化)" 1 "$(sqlv "SELECT COUNT(*) FROM audit_logs WHERE action='card.activate'")"
req $R1 POST /api/reception/activate-card "{\"token\":\"$T1\",\"nickname\":\"もう一度\",\"pin\":\"1234\",\"requestId\":\"$(rid)\"}"; check "有効化済みを再度は409" 409
lookup $R1 $T1; check "有効化後は読み取れる" 200

echo "== 受付での有効化 + チャージ =="
RQ=$(rid)
req $R1 POST /api/reception/activate-card "{\"token\":\"$T2\",\"nickname\":\"はなこ\",\"pin\":\"4321\",\"cashAmount\":1000,\"requestId\":\"$RQ\"}"; check "有効化+1000円チャージ" 201
expect "チャージ結果" 1000 "$(jget "['charge']['cashAmount']")"
BAL=$(jget "['lookup']['wallet']['balance']")
expect "残高が反映" "$BAL" "$(sqlv "SELECT w.balance FROM wallets w JOIN cards c ON c.wallet_id=w.id WHERE c.id='$C2'")"
expect "現金台帳に1件" 1 "$(sqlv "SELECT COUNT(*) FROM cash_events WHERE kind='CHARGE'")"
expect "チャージの現金額" 1000 "$(sqlv "SELECT amount FROM cash_events WHERE kind='CHARGE' LIMIT 1")"
req $R1 POST /api/reception/activate-card "{\"token\":\"$T2\",\"nickname\":\"はなこ\",\"pin\":\"4321\",\"cashAmount\":1000,\"requestId\":\"$RQ\"}"; check "同じ操作の再送は前回の結果" 200
expect "再送フラグ" True "$(jget "['replayed']")"
expect "二重にチャージされない" 1 "$(sqlv "SELECT COUNT(*) FROM cash_events WHERE kind='CHARGE'")"
expect "残高は変わらない" "$BAL" "$(sqlv "SELECT w.balance FROM wallets w JOIN cards c ON c.wallet_id=w.id WHERE c.id='$C2'")"

echo "== 入力の検証・権限 =="
req $R1 POST /api/reception/activate-card "{\"token\":\"$T3\",\"nickname\":\"\",\"pin\":\"1234\",\"requestId\":\"$(rid)\"}"; check "ニックネーム空は400" 400
req $R1 POST /api/reception/activate-card "{\"token\":\"$T3\",\"nickname\":\"x\",\"pin\":\"12\",\"requestId\":\"$(rid)\"}"; check "PINが4桁でない" 400
req $R1 POST /api/reception/activate-card "{\"token\":\"$T3\",\"nickname\":\"x\",\"pin\":\"1234\",\"cashAmount\":-5,\"requestId\":\"$(rid)\"}"; check "マイナスの現金は400" 400
req $R1 POST /api/reception/activate-card "{\"token\":\"FES1:U:abc\",\"nickname\":\"x\",\"pin\":\"1234\",\"requestId\":\"$(rid)\"}"; check "カード以外のQRは400" 400
req $R1 POST /api/reception/activate-card "{\"token\":\"FES1:C:doesnotexist0000000000000000\",\"nickname\":\"x\",\"pin\":\"1234\",\"requestId\":\"$(rid)\"}"; check "未登録のカードは400" 400
expect "失敗したカードはISSUEDのまま" ISSUED "$(sqlv "SELECT status FROM cards WHERE id='$C3'")"
req $CLERK POST /api/reception/activate-card "{\"token\":\"$T3\",\"nickname\":\"x\",\"pin\":\"1234\",\"requestId\":\"$(rid)\"}"; check "店員は受付の有効化はできない" 403
req $ANON POST /api/reception/activate-card "{\"token\":\"$T3\",\"nickname\":\"x\",\"pin\":\"1234\",\"requestId\":\"$(rid)\"}"; check "未ログインは401" 401
req $ADMIN POST /api/cards/$C4/delete '{"reason":"テスト","walletAction":"KEEP"}'
req $R1 POST /api/reception/activate-card "{\"token\":\"$T4\",\"nickname\":\"x\",\"pin\":\"1234\",\"requestId\":\"$(rid)\"}"; check "削除済みのカードは有効化できない" 400

echo "== 有効化したPINで払い戻しできる =="
lookup $R1 $T2; LK=$(jget "['lookupId']"); B2=$(jget "['wallet']['balance']")
req $R1 POST /api/reception/payout "{\"lookupId\":\"$LK\",\"requestId\":\"$(rid)\",\"expectedBalance\":$B2,\"pin\":\"0000\"}"; check "違うPINは拒否" 403
req $R1 POST /api/reception/payout "{\"lookupId\":\"$LK\",\"requestId\":\"$(rid)\",\"expectedBalance\":$B2,\"pin\":\"4321\"}"; check "設定したPINで払い戻し" 201

echo "== 期限・全体の有効期限 =="
req $ADMIN POST /api/cards/issue '{"count":1}'; T5=$(jget "['cards'][0]['token']")
FAR=$(python3 -I -c "import time;print(int((time.time()+400*86400)*1000))")
req $R1 POST /api/reception/activate-card "{\"token\":\"$T5\",\"nickname\":\"期限\",\"pin\":\"1234\",\"requestId\":\"$(rid)\"}"; check "期限つきでも有効化できる" 201

echo "== 残高照会 =="
req $ADMIN POST /api/cards/issue '{"count":1}'; T6=$(jget "['cards'][0]['token']")
req $R1 POST /api/reception/activate-card "{\"token\":\"$T6\",\"nickname\":\"照会\",\"pin\":\"1111\",\"cashAmount\":500,\"requestId\":\"$(rid)\"}"; check "照会用カードを準備" 201
EXPECT_BAL=$(jget "['lookup']['wallet']['balance']")
for who in ADMIN MGR CLERK; do
  jar=${!who}
  req $jar POST /api/balance/inquiry "{\"token\":\"$T6\"}"; check "$who は残高照会できる" 200
  expect "$who: 残高" "$EXPECT_BAL" "$(jget "['balance']")"
  expect "$who: ニックネーム" 照会 "$(jget "['nickname']")"
  expect "$who: 状態" ACTIVE "$(jget "['status']")"
done
expect "照会しても残高は変わらない" "$EXPECT_BAL" "$(sqlv "SELECT w.balance FROM wallets w JOIN cards c ON c.wallet_id=w.id WHERE c.nickname='照会'")"
lookup $R1 $T6; check "照会してもQRは使える(消費されない)" 200
req $R1 POST /api/balance/inquiry "{\"token\":\"$T6\"}"; check "受付も残高照会できる" 200
expect "受付: 残高" "$EXPECT_BAL" "$(jget "['balance']")"
req $ANON POST /api/balance/inquiry "{\"token\":\"$T6\"}"; check "未ログインは401" 401
req $ALICE POST /api/auth/register '{"email":"alice@example.com","password":"alicepass1","nickname":"alice"}'
req $ALICE POST /api/balance/inquiry "{\"token\":\"$T6\"}"; check "利用者は不可" 403
req $CLERK POST /api/balance/inquiry '{"token":"FES1:U:abc"}'; check "カード以外のQRは400" 400
req $CLERK POST /api/balance/inquiry '{"token":"FES1:C:doesnotexist0000000000000000"}'; check "未登録のカードは400" 400
req $CLERK POST /api/balance/inquiry "{\"token\":\"$T3\"}"; check "未有効のカードも照会できる" 200
expect "未有効の状態" ISSUED "$(jget "['status']")"
expect "未有効の残高は0" 0 "$(jget "['balance']")"
expect "照会が監査ログに残る" 5 "$(sqlv "SELECT COUNT(*) FROM audit_logs WHERE action='card.balance_view'")"
expect "照会者が記録される" 1 "$(sqlv "SELECT COUNT(DISTINCT actor_user_id)>=3 FROM audit_logs WHERE action='card.balance_view'")"
req $ADMIN POST /api/cards/$C3/suspend '{"reason":"テスト"}' ; req $CLERK POST /api/balance/inquiry "{\"token\":\"$T3\"}"; check "停止中でも照会できる" 200

echo "== PINの決め方: 発行時にランダムなPIN =="
req $ADMIN POST /api/cards/issue '{"count":3,"pinMode":"ISSUE"}'; check "発行時PINのカードを3枚発行" 201
python3 -I -c "
import json;d=json.load(open('$TMP/body'))['cards']
open('$TMP/p_ids','w').write(' '.join(c['id'] for c in d));open('$TMP/p_toks','w').write(' '.join(c['token'] for c in d));open('$TMP/p_pins','w').write(' '.join(c['pin'] for c in d))
print('modes', {c['pinMode'] for c in d}, 'pins4', all(len(c['pin'])==4 and c['pin'].isdigit() for c in d))"
read -r P1 P2 P3 < $TMP/p_ids; read -r PT1 PT2 PT3 < $TMP/p_toks; read -r PP1 PP2 PP3 < $TMP/p_pins
expect "PINが4桁の数字" 1 "$(python3 -I -c "print(int(all(len(x)==4 and x.isdigit() for x in '$PP1 $PP2 $PP3'.split())))")"
expect "PINが平文でDBに入っていない" 0 "$(sqlv "SELECT COUNT(*) FROM cards WHERE pin_enc LIKE '%$PP1%' AND id='$P1'")"
expect "pin_modeがISSUE" 3 "$(sqlv "SELECT COUNT(*) FROM cards WHERE pin_mode='ISSUE'")"
req $ADMIN POST /api/cards/qr-batch "{\"ids\":[\"$P1\"]}"; check "あとからPINも再表示できる" 200
expect "再表示のPINが同じ" "$PP1" "$(jget "['cards'][0]['pin']")"
req $R1 POST /api/reception/card-info "{\"token\":\"$PT1\"}"; check "受付: カード情報" 200
expect "受付: PINの決め方" ISSUE "$(jget "['pinMode']")"
req $R1 POST /api/reception/card-info "{\"token\":\"$T5\"}"; expect "ユーザー設定カードはUSER" ACTIVE "$(jget "['status']")"
req $R1 POST /api/reception/activate-card "{\"token\":\"$PT1\",\"nickname\":\"かな\",\"cashAmount\":300,\"requestId\":\"$(rid)\"}"; check "受付: PIN入力なしで有効化+チャージ" 201
expect "有効化後は発行時PINの暗号文が消える" "" "$(sqlv "SELECT COALESCE(pin_enc,'') FROM cards WHERE id='$P1'")"
req $R1 POST /api/reception/lookup "{\"token\":\"$PT1\"}"; check "有効化したカードを読み取れる" 200; LKP=$(jget "['lookupId']"); BP=$(jget "['wallet']['balance']")
req $R1 POST /api/reception/payout "{\"lookupId\":\"$LKP\",\"requestId\":\"$(rid)\",\"expectedBalance\":$BP,\"pin\":\"$(python3 -I -c "print('0000' if '$PP1'!='0000' else '1111')")\"}"; check "違うPINは拒否" 403
req $R1 POST /api/reception/payout "{\"lookupId\":\"$LKP\",\"requestId\":\"$(rid)\",\"expectedBalance\":$BP,\"pin\":\"$PP1\"}"; check "印字されたPINで払い戻せる" 201
req $ADMIN POST /api/cards/qr-batch "{\"ids\":[\"$P1\"]}"; expect "有効化後はPINを返さない" None "$(jget "['cards'][0]['pin']")"
req $ADMIN POST /api/cards/$P2/activate '{"nickname":"管理者有効化"}'; check "管理者: 発行時PINのカードはPINなしで有効化" 201
req $ADMIN POST /api/cards/$P3/regenerate '{}'; check "未有効の再生成" 200
expect "再生成してもPINは同じ" "$PP3" "$(jget "['card']['pin']")"
req $ADMIN POST /api/cards/issue '{"count":1,"pinMode":"USER"}'; U1=$(jget "['cards'][0]['id']"); expect "ユーザー設定のカードにはPINがない" None "$(jget "['cards'][0]['pin']")"
req $ADMIN POST /api/cards/$U1/activate '{"nickname":"PINなし"}'; check "ユーザー設定のカードでPINなしは400" 400
req $ADMIN POST /api/cards/issue '{"count":1,"pinMode":"BAD"}'; check "不正なpinModeは400" 400

echo
echo "結果: pass=$pass fail=$fail"
[ "$fail" = 0 ]
