#!/usr/bin/env bash
# festival-qr-pos ローカルスモークテスト(vite preview が 127.0.0.1:4173 で動いている前提)
BASE=http://127.0.0.1:4173
ORIGIN=$BASE
TMP=$(mktemp -d)
pass=0; fail=0

# req <jar> <METHOD> <path> [json] [extra curl args...] -> 本文を $TMP/body、ステータスを $TMP/code に保存
req() {
  local jar=$1 method=$2 path=$3 body=${4:-}; shift 4 2>/dev/null || shift 3
  local args=(-s -o "$TMP/body" -w '%{http_code}' -X "$method" -b "$jar" -c "$jar" -H "Origin: $ORIGIN")
  if [ -n "$body" ]; then args+=(-H 'content-type: application/json' --data "$body"); fi
  curl "${args[@]}" "$@" "$BASE$path" > "$TMP/code"
}
code() { cat "$TMP/code"; }
body() { cat "$TMP/body"; }
jget() { python3 -I -c "import sys,json;d=json.load(open('$TMP/body'));print(eval('d'+sys.argv[1]))" "$1"; }

check() { # check <name> <expected_code>
  if [ "$(code)" = "$2" ]; then pass=$((pass+1)); echo "  ok   $1 ($2)"; else fail=$((fail+1)); echo "  FAIL $1: expected $2 got $(code): $(body | head -c 200)"; fi
}

ADMIN=$TMP/admin.jar; MGR=$TMP/mgr.jar; CLERK=$TMP/clerk.jar; CUST=$TMP/cust.jar; R1=$TMP/r1.jar; R2=$TMP/r2.jar; ANON=$TMP/anon.jar

echo "== セットアップ =="
req $ANON GET /api/setup/status; check "needsSetup" 200; echo "     $(body)"
req $ANON POST /api/setup/admin '{"loginId":"admin","password":"adminpass1","nickname":"運営"}' -H 'x-setup-token: wrong'; check "誤トークンは拒否" 403
req $ANON POST /api/setup/admin '{"loginId":"admin","password":"adminpass1","nickname":"運営"}' ; check "トークン無しは拒否" 403
curl -s -o "$TMP/body" -w '%{http_code}' -X POST -H "Origin: $ORIGIN" -H 'content-type: application/json' -H 'x-setup-token: local-setup-token-for-testing' -c $ADMIN --data '{"loginId":"admin","password":"adminpass1","nickname":"運営"}' $BASE/api/setup/admin > "$TMP/code"; check "管理者作成" 201
curl -s -o "$TMP/body" -w '%{http_code}' -X POST -H "Origin: $ORIGIN" -H 'content-type: application/json' -H 'x-setup-token: local-setup-token-for-testing' --data '{"loginId":"admin2","password":"adminpass1","nickname":"x"}' $BASE/api/setup/admin > "$TMP/code"; check "2人目の管理者は作れない" 409
req $ANON GET /api/setup/status; echo "     $(body)"

echo "== CSRF / 認証 =="
curl -s -o "$TMP/body" -w '%{http_code}' -X POST -b $ADMIN -H 'content-type: application/json' --data '{"name":"x","displayName":"x"}' $BASE/api/admin/shops > "$TMP/code"; check "Origin無しのPOSTは拒否" 403
curl -s -o "$TMP/body" -w '%{http_code}' -X POST -b $ADMIN -H 'Origin: http://evil.example' -H 'content-type: application/json' --data '{"name":"x","displayName":"x"}' $BASE/api/admin/shops > "$TMP/code"; check "他オリジンのPOSTは拒否" 403
req $ANON GET /api/admin/shops; check "未ログインで管理APIは401" 401
req $ANON POST /api/auth/login '{"loginId":"admin","password":"wrong-pass"}'; check "誤パスワード" 401
req $ANON POST /api/auth/login '{"loginId":"nobody","password":"wrong-pass"}'; check "存在しないID" 401

echo "== 店舗・店舗責任者 =="
req $ADMIN POST /api/admin/shops '{"name":"2A 焼きそば","displayName":"2A 焼きそば"}'; check "店舗A作成" 201; SHOP_A=$(jget "['shop']['id']")
req $ADMIN POST /api/admin/shops '{"name":"3B たこ焼き","displayName":"3B たこ焼き"}'; check "店舗B作成" 201; SHOP_B=$(jget "['shop']['id']")
req $ADMIN POST /api/admin/users/shop-manager "{\"shopId\":\"$SHOP_A\",\"loginId\":\"mgr-a\",\"password\":\"mgrpass123\",\"nickname\":\"A責任者\"}"; check "店舗責任者作成" 201
req $ADMIN POST /api/admin/users/shop-manager "{\"shopId\":\"$SHOP_A\",\"loginId\":\"MGR-A\",\"password\":\"mgrpass123\",\"nickname\":\"重複\"}"; check "ログインID重複(大文字小文字無視)" 409
req $MGR POST /api/auth/login '{"loginId":"mgr-a","password":"mgrpass123"}'; check "店舗責任者ログイン" 200

echo "== 店員登録(店舗責任者が行う) =="
req $MGR POST /api/shops/$SHOP_A/staff '{"loginId":"clerk-a1","password":"clerkpass1","nickname":"A店員1"}'; check "自店舗に店員登録" 201; CLERK_ID=$(jget "['id']")
req $MGR POST /api/shops/$SHOP_B/staff '{"loginId":"clerk-b1","password":"clerkpass1","nickname":"B店員"}'; check "他店舗への登録は403" 403
req $MGR GET /api/shops/$SHOP_B/staff; check "他店舗のスタッフ一覧は403" 403
req $MGR GET /api/admin/shops; check "店舗責任者は管理APIに入れない" 403
req $CLERK POST /api/auth/login '{"loginId":"clerk-a1","password":"clerkpass1"}'; check "店員ログイン" 200
req $CLERK POST /api/shops/$SHOP_A/staff '{"loginId":"clerk-a2","password":"clerkpass1","nickname":"x"}'; check "店員は店員を登録できない" 403
req $CLERK GET /api/admin/users; check "店員は管理APIに入れない" 403
req $MGR POST /api/shops/$SHOP_A/staff/$CLERK_ID/reset-password '{"password":"newclerkpass"}'; check "店員のPW再設定(店舗責任者)" 200
req $CLERK GET /api/auth/me; check "PW再設定で店員のセッションは破棄" 401
req $ANON POST /api/auth/login '{"loginId":"clerk-a1","password":"clerkpass1"}'; check "旧パスワードは使えない" 401
req $CLERK POST /api/auth/login '{"loginId":"clerk-a1","password":"newclerkpass"}'; check "新パスワードでログイン" 200

echo "== 受付担当者(恒久ログインQR・同時1端末) =="
req $ADMIN POST /api/admin/users/reception '{"nickname":"受付1"}'; check "受付担当者作成+QR発行" 201; RID=$(jget "['userId']"); T1=$(jget "['token']"); echo "     token形式: ${T1:0:12}… (len ${#T1})"
req $R1 POST /api/auth/reception-login "{\"token\":\"$T1\"}"; check "端末1でQRログイン" 200
req $R1 GET /api/auth/me; check "端末1: me" 200
req $R2 POST /api/auth/reception-login "{\"token\":\"$T1\"}"; check "端末2で同じQRログイン" 200
req $R1 GET /api/auth/me; check "端末1は強制ログアウト(同時1端末)" 401
req $R2 GET /api/auth/me; check "端末2は有効" 200
req $R2 GET /api/admin/shops; check "受付は管理APIに入れない" 403
req $ANON POST /api/auth/reception-login '{"token":"FES1:R:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'; check "でたらめなQRは拒否" 401
req $ANON POST /api/auth/login '{"loginId":"x","password":"y"}' ; true
req $ADMIN POST /api/admin/users/$RID/reception-qr '{"reason":"紛失"}'; check "QR再発行" 200; T2=$(jget "['token']")
req $R2 GET /api/auth/me; check "再発行で既存セッションは破棄" 401
req $R1 POST /api/auth/reception-login "{\"token\":\"$T1\"}"; check "旧QRは即時失効" 401
req $R1 POST /api/auth/reception-login "{\"token\":\"$T2\"}"; check "新QRでログイン" 200
req $ADMIN POST /api/admin/users/$RID/reception-qr/revoke '{"reason":"テスト失効"}'; check "QR失効" 200
req $R2 POST /api/auth/reception-login "{\"token\":\"$T2\"}"; check "失効したQRは使えない" 401
req $ADMIN POST /api/admin/users/$RID/reception-qr/revoke '{}'; check "失効の理由は必須" 400
req $ANON POST /api/auth/login '{"loginId":"受付1","password":"x"}'; check "受付はパスワードログイン不可" 401

echo "== 顧客 =="
req $CUST POST /api/auth/register '{"email":"Taro@Example.com","password":"custpass12","nickname":"たろう"}'; check "顧客登録" 201; echo "     $(body)"
req $ANON POST /api/auth/register '{"email":"taro@example.com","password":"custpass12","nickname":"たろう2"}'; check "メール重複(小文字化)" 409
req $ANON POST /api/auth/register '{"email":"bad","password":"short","nickname":""}'; check "入力検証" 400
req $CUST GET /api/auth/me; check "顧客 me" 200
req $CUST GET /api/admin/users; check "顧客は管理APIに入れない" 403
req $CUST GET /api/shops/$SHOP_A/staff; check "顧客は店舗APIに入れない" 403
CID=$(python3 -I -c "import json;print(json.load(open('$TMP/body')) if False else '')")
req $ADMIN GET '/api/admin/users?role=CUSTOMER'; check "管理者が顧客一覧" 200; CUID=$(jget "['users'][0]['id']")
req $ADMIN POST /api/admin/users/$CUID/reset-password '{"password":"resetpass99"}'; check "管理者が顧客PW再設定" 200
req $CUST GET /api/auth/me; check "再設定で顧客セッション破棄" 401
req $CUST POST /api/auth/login '{"loginId":"taro@example.com","password":"resetpass99"}'; check "再設定後ログイン" 200
req $CUST POST /api/auth/change-password '{"currentPassword":"bad","newPassword":"another-pass1"}'; check "PW変更: 現在のPW誤り" 401
req $CUST POST /api/auth/change-password '{"currentPassword":"resetpass99","newPassword":"another-pass1"}'; check "PW変更" 200
req $ADMIN PATCH /api/admin/users/$CUID/status '{"status":"SUSPENDED"}'; check "利用停止" 200
req $CUST GET /api/auth/me; check "停止中は即ログアウト" 401
req $ANON POST /api/auth/login '{"loginId":"taro@example.com","password":"another-pass1"}'; check "停止中はログイン不可" 401
req $ADMIN GET /api/auth/me; AID=$(jget "['user']['id']")
req $ADMIN PATCH /api/admin/users/$AID/status '{"status":"SUSPENDED"}'; check "自分自身は停止できない" 400

echo "== 設定 =="
req $ANON GET /api/settings/public; check "公開設定" 200; echo "     $(body)"
req $ADMIN PUT /api/admin/settings/currency '{"name":"学祭ポイント","shortName":"フェスポ","symbolPosition":"after","allowDecimals":false,"yenPerUnit":1,"description":"1フェスポ=1円"}'; check "通貨変更" 200
req $ANON GET /api/settings/public; echo "     $(body)"
req $ADMIN PUT /api/admin/settings/currency '{"name":"x","shortName":"x","symbolPosition":"after","allowDecimals":true,"yenPerUnit":1,"description":""}'; check "小数は未対応のため拒否" 400
req $MGR PUT /api/admin/settings/currency '{"name":"x","shortName":"x","symbolPosition":"after","allowDecimals":false,"yenPerUnit":1,"description":""}'; check "店舗責任者は通貨を変更できない" 403

echo "== ログアウト =="
req $ADMIN POST /api/auth/logout '{}'; check "ログアウト" 200
req $ADMIN GET /api/auth/me; check "ログアウト後は401" 401

echo
echo "結果: pass=$pass fail=$fail"
echo "$TMP" > /tmp/claude-0/smoke_tmp_path
[ $fail -eq 0 ]
