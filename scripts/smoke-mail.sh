#!/usr/bin/env bash
# メール送信の設定とパスワード再設定のスモークテスト(偽のSMTP/OAuth2サーバー scripts/mail-fake.py を使う)。
# 前提: ローカルで `vite preview --port 4173` が動いていて、DBが空(migration 適用直後)であること。
BASE=${BASE:-http://127.0.0.1:4173}
SETUP_TOKEN=${SETUP_TOKEN:-local-setup-token-for-testing}
TMP=$(mktemp -d); MD=$TMP/mail
pass=0; fail=0
cd "$(dirname "$0")/.." || exit 1

pkill -f "mail-fa[k]e.py" 2>/dev/null; sleep 0.3
python3 scripts/mail-fake.py "$MD" > $TMP/fake.log 2>&1 &
FAKE=$!; trap 'kill $FAKE 2>/dev/null' EXIT
for i in $(seq 1 20); do grep -q ready $TMP/fake.log && break; sleep 0.3; done

req() { local jar=$1 method=$2 path=$3 body=${4:-}
  local args=(-s -o "$TMP/body" -w '%{http_code}' -X "$method" -b "$jar" -c "$jar" -H "Origin: $BASE")
  [ -n "$body" ] && args+=(-H 'content-type: application/json' --data "$body")
  curl "${args[@]}" "$BASE$path" > "$TMP/code"; }
code() { cat "$TMP/code"; }
body() { cat "$TMP/body"; }
jget() { python3 -I -c "import sys,json;d=json.load(open('$TMP/body'));print(eval('d'+sys.argv[1]))" "$1"; }
check() { if [ "$(code)" = "$2" ]; then pass=$((pass+1)); echo "  ok   $1 ($2)"; else fail=$((fail+1)); echo "  FAIL $1: expected $2 got $(code): $(body | head -c 300)"; fi; }
expect() { if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "  ok   $1 ($3)"; else fail=$((fail+1)); echo "  FAIL $1: expected '$2' got '$3'"; fi; }
sqlx() { npx wrangler d1 execute DB --local --command "$1" >/dev/null 2>&1; }
sqlv() { npx wrangler d1 execute DB --local --json --command "$1" 2>/dev/null | python3 -I -c "import json,sys;r=json.load(sys.stdin)[0]['results'];print(list(r[0].values())[0] if r else '')"; }
nmail() { ls $MD/*.json 2>/dev/null | wc -l | tr -d ' '; }
waitmail() { for i in $(seq 1 30); do [ "$(nmail)" -ge "$1" ] && return 0; sleep 0.3; done; return 1; }
mailf() { python3 -I - "$MD" "$1" "$2" <<'PY'
import sys,json,base64,email,glob
files=sorted(glob.glob(sys.argv[1]+'/*.json')); d=json.load(open(files[int(sys.argv[2])-1]))
m=email.message_from_string(d['data'])
subj=str(email.header.make_header(email.header.decode_header(m['Subject'])))
text=m.get_payload(decode=True).decode()
print({'auth':d['auth'],'to':d['to'],'subject':subj,'text':text,'from':d['from']}[sys.argv[3]] if sys.argv[3]!='token' else text.split('token=')[1].split()[0])
PY
}
ADMIN=$TMP/admin.jar; ALICE=$TMP/alice.jar; ALICE2=$TMP/alice2.jar; ANON=$TMP/anon.jar; MGR=$TMP/mgr.jar

echo "== 準備 =="
curl -s -o /dev/null -X POST -H "Origin: $BASE" -H 'content-type: application/json' -H "x-setup-token: $SETUP_TOKEN" -c $ADMIN --data '{"loginId":"admin","password":"adminpass1","nickname":"運営","recoveryEmail":"owner@example.com"}' $BASE/api/setup/admin
req $ADMIN POST /api/auth/login '{"loginId":"admin","password":"adminpass1"}'; check "管理者ログイン" 200
req $ALICE POST /api/auth/register '{"email":"alice@example.com","password":"alicepass1","nickname":"アリス"}'; check "顧客登録" 201
req $ADMIN POST /api/admin/shops '{"name":"3A","displayName":"3A"}'; SA=$(jget "['shop']['id']")
req $ADMIN POST /api/admin/users/shop-manager "{\"shopId\":\"$SA\",\"loginId\":\"mgr-a\",\"password\":\"mgrpass123\",\"nickname\":\"責任者\"}"
req $MGR POST /api/auth/login '{"loginId":"mgr-a","password":"mgrpass123"}'; check "責任者ログイン" 200

echo "== メール未設定 =="
req $ANON GET /api/settings/public; expect "再設定は使えない(顧客)" False "$(jget "['passwordReset']")"
req $ANON POST /api/auth/password-reset/request '{"loginId":"alice@example.com"}'; check "依頼は常に200" 200
sleep 1; expect "メールは出ない" 0 "$(nmail)"
req $ADMIN GET /api/admin/mail; check "メール設定を取得" 200
expect "管理者の再設定用メール" owner@example.com "$(jget "['recoveryEmail']")"
req $MGR GET /api/admin/mail; check "責任者は見られない" 403
req $ANON GET /api/admin/mail; check "未ログインは不可" 401

echo "== メインの登録(SMTP・パスワード) =="
P='{"provider":"SMTP","auth":"PASSWORD","fromAddress":"noreply@example.com","fromName":"学園祭","host":"127.0.0.1","port":2525,"security":"NONE","username":"mailuser","password":"mailpass"}'
req $ADMIN PUT /api/admin/mail/accounts/PRIMARY "$P"; check "登録" 200
req $MGR PUT /api/admin/mail/accounts/PRIMARY "$P"; check "責任者は登録できない" 403
req $ADMIN PUT /api/admin/mail/accounts/PRIMARY '{"provider":"SMTP","auth":"PASSWORD","fromAddress":"noreply@example.com","host":"127.0.0.1","port":2525,"security":"NONE","username":"x"}' ; check "(保存済みの)パスワードを使い続ける" 200
req $ADMIN PUT /api/admin/mail/accounts/PRIMARY '{"provider":"GOOGLE","auth":"PASSWORD","fromAddress":"a@gmail.com"}'; check "新規でパスワード未入力は不可(別方式へ変更)" 200
req $ADMIN PUT /api/admin/mail/accounts/PRIMARY "$P"; check "元に戻す" 200
req $ADMIN PUT /api/admin/mail/accounts/PRIMARY '{"provider":"SMTP","auth":"PASSWORD","fromAddress":"bad","host":"127.0.0.1","port":2525,"security":"NONE"}'; check "メール形式の誤り" 400
req $ADMIN PUT /api/admin/mail/accounts/PRIMARY '{"provider":"SMTP","auth":"OAUTH2","fromAddress":"a@example.com","clientId":"c","clientSecret":"s","authUrl":"ftp://x/","tokenUrl":"https://x/t"}'; check "不正なURLは不可" 400
req $ADMIN GET /api/admin/mail
grep -q "mailpass" $TMP/body && { fail=$((fail+1)); echo "  FAIL パスワードが応答に含まれる"; } || { pass=$((pass+1)); echo "  ok   応答にパスワードを含まない"; }
expect "パスワード保存済み" True "$(jget "['accounts'][0]['hasPassword']")"
case "$(sqlv "SELECT secret_sealed FROM mail_accounts WHERE slot='PRIMARY'")" in *mailpass*) fail=$((fail+1)); echo "  FAIL DBに平文";; *) pass=$((pass+1)); echo "  ok   DBは暗号化";; esac
req $ADMIN POST /api/admin/mail/accounts/PRIMARY/test '{"to":"me@example.com"}'; check "試し送り" 200
expect "試し送りが成功" True "$(jget "['ok']")"
waitmail 1; expect "届いた件名" "【テスト】メール送信の確認" "$(mailf 1 subject)"
expect "宛先" me@example.com "$(mailf 1 to)"
expect "ログイン方式" PASSWORD "$(mailf 1 auth)"
req $ADMIN POST /api/admin/mail/accounts/PRIMARY/test '{"to":"bad"}'; check "宛先の形式" 400
req $ADMIN POST /api/admin/mail/accounts/SUB/test '{"to":"me@example.com"}'; check "未登録の枠" 404

echo "== お客様のパスワード再設定 =="
req $ANON GET /api/settings/public; expect "再設定が使える" True "$(jget "['passwordReset']")"
req $ALICE GET /api/auth/me; check "Aliceログイン中" 200
req $ANON POST /api/auth/password-reset/request '{"loginId":"alice@example.com"}'; check "再設定の依頼" 200
waitmail 2; expect "再設定メール(宛先)" alice@example.com "$(mailf 2 to)"
mailf 2 subject | grep -q "パスワード再設定" && { pass=$((pass+1)); echo "  ok   件名"; } || { fail=$((fail+1)); echo "  FAIL 件名"; }
mailf 2 text | grep -q "1時間" && { pass=$((pass+1)); echo "  ok   本文に有効期限"; } || { fail=$((fail+1)); echo "  FAIL 本文"; }
T1=$(mailf 2 token); echo "  token長=${#T1}"
req $ANON POST /api/auth/password-reset/request '{"loginId":"alice@example.com"}'; check "続けての依頼も200" 200
sleep 1.5; expect "短時間の再送はメールを出さない" 2 "$(nmail)"
req $ANON POST /api/auth/password-reset/request '{"loginId":"nobody@example.com"}'; check "存在しないアカウントも200" 200
sleep 1; expect "メールは出ない" 2 "$(nmail)"
req $ANON POST /api/auth/password-reset/confirm '{"token":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","newPassword":"newpass123"}'; check "でたらめなトークン" 400
req $ANON POST /api/auth/password-reset/confirm "{\"token\":\"$T1\",\"newPassword\":\"short\"}"; check "短いパスワード" 400
req $ANON POST /api/auth/password-reset/confirm "{\"token\":\"$T1\",\"newPassword\":\"newpass123\"}"; check "パスワードを再設定" 200
req $ANON POST /api/auth/password-reset/confirm "{\"token\":\"$T1\",\"newPassword\":\"another123\"}"; check "同じURLは2回使えない" 400
req $ANON POST /api/auth/login '{"loginId":"alice@example.com","password":"alicepass1"}'; check "古いパスワードは不可" 401
req $ALICE2 POST /api/auth/login '{"loginId":"alice@example.com","password":"newpass123"}'; check "新しいパスワードでログイン" 200
req $ALICE GET /api/auth/me; check "もとのログイン(別端末)は切れる" 401
expect "監査ログ(完了)" 1 "$(sqlv "SELECT COUNT(*) FROM audit_logs WHERE action='auth.password_reset_done'")"
sleep 0.5; expect "監査ログ(送信)" 1 "$(sqlv "SELECT COUNT(*) FROM audit_logs WHERE action='auth.password_reset_mail_sent' AND target_id=(SELECT id FROM users WHERE login_id='alice@example.com')")"
case "$(sqlv "SELECT group_concat(before_json || after_json) FROM audit_logs")" in *newpass123*|*"$T1"*) fail=$((fail+1)); echo "  FAIL 監査ログに秘密";; *) pass=$((pass+1)); echo "  ok   監査ログに秘密を含まない";; esac

echo "== 有効期限(1時間) =="
sqlx "UPDATE password_resets SET created_at = created_at - 120000"
req $ANON POST /api/auth/password-reset/request '{"loginId":"alice@example.com"}'; waitmail 3; T2=$(mailf 3 token)
EXP=$(sqlv "SELECT (expires_at - created_at) FROM password_resets ORDER BY created_at DESC LIMIT 1"); expect "有効期間は3600秒" 3600000 "$EXP"
sqlx "UPDATE password_resets SET expires_at = $(date +%s)000 - 1000 WHERE used_at IS NULL"
req $ANON POST /api/auth/password-reset/confirm "{\"token\":\"$T2\",\"newPassword\":\"newpass456\"}"; check "期限切れは不可" 400
expect "コード" RESET_TOKEN_INVALID "$(jget "['error']['code']")"

echo "== オンオフ(顧客) =="
req $ADMIN PUT /api/admin/mail/settings '{"passwordResetEnabled":false,"publicBaseUrl":""}'; check "オフにする" 200
req $ANON GET /api/settings/public; expect "公開設定もオフ" False "$(jget "['passwordReset']")"
sqlx "UPDATE password_resets SET created_at = created_at - 3600000"
req $ANON POST /api/auth/password-reset/request '{"loginId":"alice@example.com"}'; sleep 1.5; expect "オフの間はメールが出ない" 3 "$(nmail)"
req $ADMIN PUT /api/admin/mail/settings '{"passwordResetEnabled":true,"publicBaseUrl":"https://fes.example.com"}'; check "オン+基準URL" 200
req $MGR PUT /api/admin/mail/settings '{"passwordResetEnabled":true,"publicBaseUrl":""}'; check "責任者は変更不可" 403
req $ADMIN PUT /api/admin/mail/settings '{"passwordResetEnabled":true,"publicBaseUrl":"javascript:x"}'; check "不正な基準URL" 400
req $ANON POST /api/auth/password-reset/request '{"loginId":"alice@example.com"}'; waitmail 4
mailf 4 text | grep -q "https://fes.example.com/reset-password?token=" && { pass=$((pass+1)); echo "  ok   基準URLがリンクに使われる"; } || { fail=$((fail+1)); echo "  FAIL 基準URL"; }
req $ADMIN PUT /api/admin/mail/settings '{"passwordResetEnabled":true,"publicBaseUrl":""}'

echo "== サブ(OAuth2)の登録と認可 =="
O="{\"provider\":\"SMTP\",\"auth\":\"OAUTH2\",\"fromAddress\":\"sub@example.com\",\"host\":\"127.0.0.1\",\"port\":2525,\"security\":\"NONE\",\"username\":\"sub@example.com\",\"clientId\":\"cid\",\"clientSecret\":\"csecret\",\"authUrl\":\"http://127.0.0.1:2526/authorize\",\"tokenUrl\":\"http://127.0.0.1:2526/token\",\"scope\":\"mail\"}"
req $ADMIN PUT /api/admin/mail/accounts/SUB "$O"; check "OAuth2で登録" 200
expect "認可が必要" True "$(jget "['needsAuthorization']")"
req $ADMIN POST /api/admin/mail/accounts/SUB/test '{"to":"me@example.com"}'; check "未認可の試し送り" 200
expect "未認可は失敗する" False "$(jget "['ok']")"
req $ADMIN POST /api/admin/mail/accounts/SUB/oauth/start; check "認可の開始" 200
URL=$(jget "['url']"); ST=$(python3 -I -c "import sys,urllib.parse as u;print(u.parse_qs(u.urlparse(sys.argv[1]).query)['state'][0])" "$URL")
case "$URL" in "http://127.0.0.1:2526/authorize?"*client_id=cid*) case "$URL" in *response_type=code*redirect_uri=*%2Fapi%2Fadmin%2Fmail%2Foauth%2Fcallback*scope=mail*) pass=$((pass+1)); echo "  ok   認可URL";; *) fail=$((fail+1)); echo "  FAIL 認可URL: $URL";; esac;; *) fail=$((fail+1)); echo "  FAIL 認可URL: $URL";; esac
curl -s -o /dev/null -w '%{http_code} %{redirect_url}' -b $MGR "$BASE/api/admin/mail/oauth/callback?code=goodcode&state=$ST" > $TMP/code2; echo "  責任者のコールバック: $(cat $TMP/code2)"
case "$(cat $TMP/code2)" in 403*) pass=$((pass+1)); echo "  ok   責任者は不可";; *) fail=$((fail+1)); echo "  FAIL";; esac
curl -s -o /dev/null -w '%{http_code} %{redirect_url}' -b $ADMIN "$BASE/api/admin/mail/oauth/callback?code=badcode&state=$ST" > $TMP/code2
case "$(cat $TMP/code2)" in 302*oauth=error*) pass=$((pass+1)); echo "  ok   認可コードが違うとエラー";; *) fail=$((fail+1)); echo "  FAIL: $(cat $TMP/code2)";; esac
req $ADMIN POST /api/admin/mail/accounts/SUB/oauth/start; ST=$(python3 -I -c "import sys,urllib.parse as u;print(u.parse_qs(u.urlparse(sys.argv[1]).query)['state'][0])" "$(jget "['url']")")
curl -s -o /dev/null -w '%{http_code} %{redirect_url}' -b $ADMIN "$BASE/api/admin/mail/oauth/callback?code=goodcode&state=$ST" > $TMP/code2
case "$(cat $TMP/code2)" in 302*oauth=ok*) pass=$((pass+1)); echo "  ok   認可に成功";; *) fail=$((fail+1)); echo "  FAIL: $(cat $TMP/code2)";; esac
curl -s -o /dev/null -w '%{http_code} %{redirect_url}' -b $ADMIN "$BASE/api/admin/mail/oauth/callback?code=goodcode&state=$ST" > $TMP/code2
case "$(cat $TMP/code2)" in 302*oauth=expired*) pass=$((pass+1)); echo "  ok   stateは1回だけ";; *) fail=$((fail+1)); echo "  FAIL: $(cat $TMP/code2)";; esac
req $ADMIN GET /api/admin/mail
grep -q "RT-1\|csecret" $TMP/body && { fail=$((fail+1)); echo "  FAIL 秘密が応答に含まれる"; } || { pass=$((pass+1)); echo "  ok   応答に秘密を含まない"; }
req $ADMIN POST /api/admin/mail/accounts/SUB/test '{"to":"me@example.com"}'; expect "OAuth2で試し送り" True "$(jget "['ok']")"
N=$(nmail); expect "XOAUTH2で届く" XOAUTH2 "$(mailf $N auth)"

echo "== 全体管理者宛(サブ優先)とフォールバック =="
req $ANON POST /api/auth/password-reset/request '{"loginId":"admin"}'; check "管理者の再設定依頼" 200
waitmail $((N+1)); expect "宛先は再設定用メール" owner@example.com "$(mailf $((N+1)) to)"
expect "管理者宛はサブから" XOAUTH2 "$(mailf $((N+1)) auth)"
echo PASSWORD > $MD/fail
sqlx "UPDATE password_resets SET created_at = created_at - 3600000"
req $ANON POST /api/auth/password-reset/request '{"loginId":"alice@example.com"}'; waitmail $((N+2))
expect "顧客宛はメインが失敗するとサブ" XOAUTH2 "$(mailf $((N+2)) auth)"
expect "メインの失敗が記録される" ERROR "$(sqlv "SELECT last_status FROM mail_accounts WHERE slot='PRIMARY'")"
echo XOAUTH2 > $MD/fail
sqlx "UPDATE password_resets SET created_at = created_at - 3600000"
req $ANON POST /api/auth/password-reset/request '{"loginId":"admin"}'; waitmail $((N+3))
expect "管理者宛はサブが失敗するとメイン" PASSWORD "$(mailf $((N+3)) auth)"
sqlx "UPDATE password_resets SET created_at = created_at - 3600000"
echo BOTH > $MD/fail; rm $MD/fail
echo "== 管理者の再設定 =="
TA=$(mailf $((N+3)) token)
req $ANON POST /api/auth/password-reset/confirm "{\"token\":\"$TA\",\"newPassword\":\"adminnew123\"}"; check "管理者のパスワード再設定" 200
req $ANON POST /api/auth/login '{"loginId":"admin","password":"adminnew123"}'; check "新しいパスワードでログイン" 200
req $ADMIN GET /api/admin/mail; check "古いセッションは切れる" 401
req $ADMIN POST /api/auth/login '{"loginId":"admin","password":"adminnew123"}'
echo "== 再設定用メールアドレスの変更 =="
req $ADMIN PUT /api/admin/mail/recovery-email '{"email":"new-owner@example.com","currentPassword":"wrong"}'; check "現在のパスワードが違う" 401
req $ADMIN PUT /api/admin/mail/recovery-email '{"email":"new-owner@example.com","currentPassword":"adminnew123"}'; check "変更" 200
req $ADMIN GET /api/admin/mail; expect "変更された" new-owner@example.com "$(jget "['recoveryEmail']")"
sqlx "UPDATE password_resets SET created_at = created_at - 3600000"
M=$(nmail); req $ANON POST /api/auth/password-reset/request '{"loginId":"admin"}'; waitmail $((M+1)); expect "新しい宛先に届く" new-owner@example.com "$(mailf $((M+1)) to)"
req $ADMIN PUT /api/admin/mail/recovery-email '{"email":null,"currentPassword":"adminnew123"}'; check "解除" 200
sqlx "UPDATE password_resets SET created_at = created_at - 3600000"
M=$(nmail); req $ANON POST /api/auth/password-reset/request '{"loginId":"admin"}'; sleep 1.5; expect "未登録だと送らない" "$M" "$(nmail)"
echo "== 店員・責任者は対象外 =="
M=$(nmail); req $ANON POST /api/auth/password-reset/request '{"loginId":"mgr-a"}'; check "200" 200; sleep 1; expect "メールは出ない" "$M" "$(nmail)"

echo "== 登録の削除 =="
req $ADMIN DELETE /api/admin/mail/accounts/SUB; check "サブを削除" 200
req $ADMIN DELETE /api/admin/mail/accounts/SUB; check "二重削除は404" 404
echo
echo "pass=$pass fail=$fail"
[ $fail -eq 0 ]
