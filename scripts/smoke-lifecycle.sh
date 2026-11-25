#!/usr/bin/env bash
# 全体の有効期限・規約・退会・全データ削除のスモークテスト。
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
echo "== 準備 =="
curl -s -o /dev/null -X POST -H "Origin: $BASE" -H 'content-type: application/json' -H "x-setup-token: $SETUP_TOKEN" -c $ADMIN --data '{"loginId":"admin","password":"adminpass1","nickname":"運営"}' $BASE/api/setup/admin
req $ADMIN POST /api/auth/login '{"loginId":"admin","password":"adminpass1"}'; check "管理者ログイン" 200
req $ADMIN POST /api/admin/shops '{"name":"3A 焼きそば","displayName":"3A 焼きそば"}'; SA=$(jget "['shop']['id']")
req $ADMIN POST /api/admin/users/reception '{"nickname":"受付A","loginId":"recep-a","password":"recepass123"}'
req $R1 POST /api/auth/login '{"loginId":"recep-a","password":"recepass123"}'
req $ALICE POST /api/auth/register '{"email":"alice@example.com","password":"alicepass1","nickname":"アリス"}'; check "規約なしで登録できる" 201
req $BOB POST /api/auth/register '{"email":"bob@example.com","password":"bobpass123","nickname":"ボブ"}'; check "ボブ登録" 201
charge $R1 $ALICE 3000; check "チャージ(アリス)" 201
charge $R1 $BOB 1000; check "チャージ(ボブ)" 201

echo "== 全体の有効期限 =="
req $ALICE PUT /api/admin/system/global-expiry '{"date":"2030-01-01"}'; check "顧客は設定できない" 403
req $ADMIN PUT /api/admin/system/global-expiry '{"date":"2020-01-01"}'; check "過去の日付は不可" 400
FAR=$(python3 -I -c "import datetime;print((datetime.date.today()+datetime.timedelta(days=300)).isoformat())")
req $ADMIN PUT /api/admin/system/global-expiry "{\"date\":\"$FAR\"}"; check "184日超は不可" 400
D30=$(python3 -I -c "import datetime;print((datetime.date.today()+datetime.timedelta(days=30)).isoformat())")
req $ADMIN PUT /api/admin/system/global-expiry "{\"date\":\"$D30\"}"; check "全体の期限を設定" 200
expect "ウォレットが2件そろう" 2 "$(jget "['updated']['wallets']")"
EXP=$(python3 -I -c "import datetime;print(int(datetime.datetime.fromisoformat('${D30}T23:59:59.999+09:00').timestamp()*1000))")
expect "アリスのウォレット期限=全体期限" "$EXP" "$(sqlv "SELECT w.expires_at FROM wallets w JOIN users u ON u.id=w.owner_user_id WHERE u.login_id='alice@example.com'")"
req $ALICE GET /api/settings/public; expect "公開設定に全体期限" "$D30" "$(jget "['globalExpiry']")"
req $ADMIN GET /api/admin/system/global-expiry; expect "削除はまだできない" False "$(jget "['globalExpiry']['canReset']")"
req $ADMIN PUT /api/admin/system/global-expiry "{\"date\":\"$D30\"}"; check "同じ日付の再設定も通る" 200

echo "== 利用規約・プライバシーポリシー =="
req $ALICE PUT /api/admin/system/legal/TERMS '{"bodyMd":"# 規約"}'; check "顧客は編集できない" 403
req $ADMIN PUT /api/admin/system/legal/TERMS '{"bodyMd":"# 利用規約\n\n第1条 ..."}'; check "規約 第1版" 200
expect "版=1" 1 "$(jget "['document']['version']")"
req $ADMIN PUT /api/admin/system/legal/TERMS '{"bodyMd":"# 利用規約\n\n第1条 ..."}'; check "同じ内容は不可" 409
req $ADMIN PUT /api/admin/system/legal/TERMS '{"bodyMd":"# 利用規約(改)\n\n第1条 ..."}'; check "規約 第2版" 200
req $ADMIN PUT /api/admin/system/legal/PRIVACY '{"bodyMd":"# プライバシーポリシー"}'; check "PP 第1版" 200
req $ADMIN PUT /api/admin/system/legal/TERMS '{"bodyMd":"   "}'; check "空は不可" 400
req $ADMIN PUT /api/admin/system/legal/OTHER '{"bodyMd":"x"}'; check "種類不正" 400
req $ANON GET /api/settings/legal/terms; check "未ログインで読める" 200
expect "現行は第2版" 2 "$(jget "['document']['version']")"
req $ANON GET /api/settings/public; expect "公開設定の版" "2 1" "$(jget "['legal']['TERMS']") $(jget "['legal']['PRIVACY']")"
req $ADMIN GET /api/admin/system/legal/TERMS; expect "版の一覧" 2 "$(python3 -I -c "import json;print(len(json.load(open('$TMP/body'))['versions']))")"
req $ADMIN GET /api/admin/system/legal/TERMS/1; check "旧版を読める" 200
req $ANON POST /api/auth/register '{"email":"carol@example.com","password":"carolpass1","nickname":"キャロル"}'; check "同意なしは登録不可" 400
req $ANON POST /api/auth/register '{"email":"carol@example.com","password":"carolpass1","nickname":"キャロル","agree":false}'; check "agree=false も不可" 400
req $ANON POST /api/auth/register '{"email":"carol@example.com","password":"carolpass1","nickname":"キャロル","agree":true}'; check "同意して登録" 201
expect "同意した版を記録" "2 1" "$(sqlv "SELECT terms_version || ' ' || privacy_version FROM users WHERE login_id='carol@example.com'")"
expect "新規ウォレットも全体期限以内" 1 "$(sqlv "SELECT w.expires_at <= $EXP FROM wallets w JOIN users u ON u.id=w.owner_user_id WHERE u.login_id='carol@example.com'")"
audit=$(sqlv "SELECT COUNT(*) FROM audit_logs WHERE action='legal.update'"); expect "規約の更新が監査ログに残る" 3 "$audit"

echo "== 利用者の自己退会 =="
req $BOB POST /api/auth/delete-account '{"password":"wrong-password"}'; check "パスワード違いは不可" 401
req $BOB POST /api/auth/delete-account '{"password":"bobpass123"}'; check "残高があると退会できない" 409
expect "コード" BALANCE_NOT_ZERO "$(jget "['error']['code']")"
expect "ユーザーはそのまま" ACTIVE "$(sqlv "SELECT status FROM users WHERE login_id='bob@example.com'")"
# 残高を0にする(受付での払戻し)
req $R1 POST /api/reception/lookup "{\"token\":\"$(newQr $BOB)\"}"; LK=$(jget "['lookupId']")
req $R1 POST /api/reception/payout "{\"lookupId\":\"$LK\",\"requestId\":\"$(rid)\",\"expectedBalance\":1000}"; check "払戻し" 201
expect "払戻しで残高0" 0 "$(myBalance $BOB)"
req $ADMIN POST /api/auth/delete-account '{"password":"adminpass1"}'; check "管理者は退会APIを使えない" 403
req $BOB POST /api/auth/delete-account '{"password":"bobpass123"}'; check "残高0なら退会できる" 200
expect "状態=DELETED" DELETED "$(sqlv "SELECT status FROM users WHERE login_id='bob@example.com'")"
expect "退会日時が入る" 1 "$(sqlv "SELECT deleted_at IS NOT NULL FROM users WHERE login_id='bob@example.com'")"
expect "ウォレットは閉鎖" CLOSED "$(sqlv "SELECT w.status FROM wallets w JOIN users u ON u.id=w.owner_user_id WHERE u.login_id='bob@example.com'")"
expect "履歴(台帳)は残る" 1 "$(sqlv "SELECT COUNT(*)>=2 FROM wallet_ledger l JOIN wallets w ON w.id=l.wallet_id JOIN users u ON u.id=w.owner_user_id WHERE u.login_id='bob@example.com'")"
expect "監査ログが残る" 1 "$(sqlv "SELECT COUNT(*) FROM audit_logs WHERE action='account.self_delete'")"
req $BOB GET /api/auth/me; check "退会後はセッション無効" 401
req $BOB POST /api/auth/login '{"loginId":"bob@example.com","password":"bobpass123"}'; check "退会後はログイン不可" 401
req $ADMIN GET "/api/admin/users?role=CUSTOMER"; expect "一覧には出ない" 0 "$(python3 -I -c "import json;print(sum(1 for u in json.load(open('$TMP/body'))['users'] if u['loginId']=='bob@example.com'))")"

echo "== 全データ削除 =="
req $ADMIN POST /api/admin/system/reset "{\"phrase\":\"全データを削除\",\"password\":\"adminpass1\"}"; check "期限前は削除できない" 409
expect "コード" RESET_NOT_ALLOWED "$(jget "['error']['code']")"
# 期限を2か月前にしてしまう(DBを直接。APIは過去日を受け付けない)
OLD=$(python3 -I -c "import datetime;print((datetime.date.today()-datetime.timedelta(days=62)).isoformat())")
sql "UPDATE settings SET value='{\"date\":\"$OLD\"}' WHERE key='expiry.global'" >/dev/null
req $ADMIN GET /api/admin/system/global-expiry; expect "削除可能になる" True "$(jget "['globalExpiry']['canReset']")"
NEAR=$(python3 -I -c "import datetime;print((datetime.date.today()-datetime.timedelta(days=20)).isoformat())")
sql "UPDATE settings SET value='{\"date\":\"$NEAR\"}' WHERE key='expiry.global'" >/dev/null
req $ADMIN GET /api/admin/system/global-expiry; expect "期限切れ20日後はまだ不可" False "$(jget "['globalExpiry']['canReset']")"
req $ANON POST /api/auth/register '{"email":"late@example.com","password":"latepass12","nickname":"遅れ","agree":true}'; check "期限後は新規登録できない" 409
expect "コード" SERVICE_EXPIRED "$(jget "['error']['code']")"
sql "UPDATE settings SET value='{\"date\":\"$OLD\"}' WHERE key='expiry.global'" >/dev/null
req $ALICE POST /api/admin/system/reset '{"phrase":"全データを削除","password":"alicepass1"}'; check "顧客は削除できない" 403
req $ADMIN POST /api/admin/system/reset '{"phrase":"削除","password":"adminpass1"}'; check "確認文言の違い" 400
req $ADMIN POST /api/admin/system/reset '{"phrase":"全データを削除","password":"wrong"}'; check "パスワード違い" 401
expect "まだ消えていない" 1 "$(sqlv "SELECT COUNT(*)>0 FROM wallet_ledger")"
req $ADMIN POST /api/admin/system/reset '{"phrase":"全データを削除","password":"adminpass1"}'; check "全データ削除" 200
expect "台帳が空" 0 "$(sqlv "SELECT COUNT(*) FROM wallet_ledger")"
expect "店舗が空" 0 "$(sqlv "SELECT COUNT(*) FROM shops")"
expect "カードが空" 0 "$(sqlv "SELECT COUNT(*) FROM cards")"
expect "ウォレットが空" 0 "$(sqlv "SELECT COUNT(*) FROM wallets")"
expect "利用者は管理者だけ" "ADMIN" "$(sqlv "SELECT group_concat(DISTINCT role) FROM users")"
expect "監査ログは削除の記録だけ" "system.reset" "$(sqlv "SELECT group_concat(action) FROM audit_logs")"
expect "規約は残る" 3 "$(sqlv "SELECT COUNT(*) FROM legal_documents")"
expect "全体期限の設定は外れる" 0 "$(sqlv "SELECT COUNT(*) FROM settings WHERE key='expiry.global'")"
expect "履歴保護トリガが復元されている(監査ログ)" 2 "$(sqlv "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name IN ('audit_logs_no_update','audit_logs_no_delete')")"
expect "履歴保護トリガが復元されている(全体)" 1 "$(sqlv "SELECT COUNT(*)>=18 FROM sqlite_master WHERE type='trigger' AND sql LIKE '%RAISE%'")"
sql "DELETE FROM audit_logs" >/dev/null 2>&1
expect "復元後も監査ログは消せない" 1 "$(sqlv "SELECT COUNT(*) FROM audit_logs")"
req $ADMIN GET /api/auth/me; check "管理者のログインは維持" 200
req $ALICE POST /api/auth/login '{"loginId":"alice@example.com","password":"alicepass1"}'; check "利用者のアカウントは消えている" 401
req $ADMIN POST /api/admin/shops '{"name":"新店","displayName":"新店"}'; check "削除後に新しく始められる" 201
req $ADMIN PUT /api/admin/system/global-expiry "{\"date\":\"$D30\"}"; check "次の期限を設定できる" 200

echo
echo "結果: pass=$pass fail=$fail"
[ "$fail" = 0 ]
