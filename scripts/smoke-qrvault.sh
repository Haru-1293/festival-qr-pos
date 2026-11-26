#!/usr/bin/env bash
# QRの再表示・印刷デザインのスモークテスト。
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
req $ADMIN POST /api/admin/shops '{"name":"3B たこ焼き","displayName":"3B たこ焼き"}'; SB=$(jget "['shop']['id']")
req $ADMIN POST /api/admin/users/shop-manager "{\"shopId\":\"$SA\",\"loginId\":\"mgr-a\",\"password\":\"mgrpass123\",\"nickname\":\"A責任者\"}"
req $ADMIN POST /api/admin/users/shop-manager "{\"shopId\":\"$SB\",\"loginId\":\"mgr-b\",\"password\":\"mgrpass123\",\"nickname\":\"B責任者\"}"
req $MGR POST /api/auth/login '{"loginId":"mgr-a","password":"mgrpass123"}'
req $MGRB POST /api/auth/login '{"loginId":"mgr-b","password":"mgrpass123"}'
req $MGR POST /api/shops/$SA/staff '{"loginId":"clerk-a","password":"clerkpass1","nickname":"A店員"}'; CID=$(jget "['id']")
req $CLERK POST /api/auth/login '{"loginId":"clerk-a","password":"clerkpass1"}'

echo "== 受付ログインQRの再表示 =="
req $ADMIN POST /api/admin/users/reception '{"nickname":"受付A","loginId":"recep-a","password":"recepass123"}'; check "受付を登録" 201
RID=$(jget "['userId']"); TOK1=$(jget "['token']")
req $ADMIN GET /api/admin/users/$RID/login-qr; check "発行後に再表示できる" 200
expect "同じQRが返る" "$TOK1" "$(jget "['token']")"
req $ADMIN GET /api/admin/users/$RID/login-qr; expect "何度でも同じ" "$TOK1" "$(jget "['token']")"
expect "DBには平文で入っていない" 1 "$(sqlv "SELECT token_enc IS NOT NULL AND token_enc NOT LIKE '%FES1%' AND LENGTH(token_enc) > 30 FROM reception_login_qrs WHERE user_id='$RID' AND revoked_at IS NULL")"
req $MGR GET /api/admin/users/$RID/login-qr; check "店舗責任者は見られない" 403
req $R1 POST /api/auth/login '{"loginId":"recep-a","password":"recepass123"}'; check "受付(ID)ログイン" 200
req $R1 GET /api/admin/users/$RID/login-qr; check "受付自身も見られない" 403
req $ANON POST /api/auth/reception-login "{\"token\":\"$TOK1\"}"; check "QRでログインできる" 200
req $ADMIN POST /api/admin/users/$RID/reception-qr '{"reason":"紛失"}'; check "再発行" 200; TOK2=$(jget "['token']")
req $ADMIN GET /api/admin/users/$RID/login-qr; expect "再発行後は新しいQR" "$TOK2" "$(jget "['token']")"
req $ANON POST /api/auth/reception-login "{\"token\":\"$TOK1\"}"; check "古いQRは使えない" 401
req $ADMIN GET /api/admin/users/00000000000000000000000000/login-qr; check "存在しない担当者は404" 404
req $ADMIN POST /api/admin/users/$RID/reception-qr/revoke '{"reason":"テスト"}'; check "失効" 200
req $ADMIN GET /api/admin/users/$RID/login-qr; check "失効後は表示できない" 404
expect "閲覧が監査ログに残る" 3 "$(sqlv "SELECT COUNT(*) FROM audit_logs WHERE action='login_qr.view'")"
# 保存前に発行された(token_enc が NULL の)QRは再表示できない
req $ADMIN POST /api/admin/users/reception '{"nickname":"受付旧"}'; OLDR=$(jget "['userId']")
sql "UPDATE reception_login_qrs SET token_enc = NULL WHERE user_id='$OLDR'" >/dev/null
req $ADMIN GET /api/admin/users/$OLDR/login-qr; check "保存前のQRは404" 404
expect "コード" QR_NOT_STORED "$(jget "['error']['code']")"

echo "== 店員ログインQRの再表示 =="
req $MGR POST /api/shops/$SA/staff/$CID/qr '{}'; check "店員QRを発行" 200; CT=$(jget "['token']")
req $MGR GET /api/shops/$SA/staff/$CID/qr; check "責任者が再表示" 200
expect "同じQR" "$CT" "$(jget "['token']")"
req $MGRB GET /api/shops/$SB/staff/$CID/qr; check "他店の責任者は見られない(店舗違い)" 404
req $MGRB GET /api/shops/$SA/staff/$CID/qr; check "他店の責任者は自店以外を見られない" 403
req $CLERK POST /api/auth/login '{"loginId":"clerk-a","password":"clerkpass1"}'
req $CLERK GET /api/shops/$SA/staff/$CID/qr; check "店員は見られない" 403
req $ADMIN GET /api/shops/$SA/staff/$CID/qr; check "全体管理者は見られる" 200

echo "== カードQRの再表示 =="
req $ADMIN POST /api/cards/issue '{"count":3}'; check "カード3枚発行" 201
python3 -I -c "
import json;d=json.load(open('$TMP/body'))['cards']
open('$TMP/ids','w').write(' '.join(c['id'] for c in d));open('$TMP/toks','w').write(' '.join(c['token'] for c in d))"
read -r C1 C2 C3 < $TMP/ids; read -r T1 T2 T3 < $TMP/toks
req $ADMIN POST /api/cards/qr-batch "{\"ids\":[\"$C1\",\"$C2\",\"$C3\"]}"; check "まとめて再表示" 200
expect "3枚" 3 "$(python3 -I -c "import json;print(len(json.load(open('$TMP/body'))['cards']))")"
expect "同じQR" "$T1 $T2 $T3" "$(python3 -I -c "import json;print(' '.join(c['token'] for c in json.load(open('$TMP/body'))['cards']))")"
expect "平文で保存されていない" 3 "$(sqlv "SELECT COUNT(*) FROM cards WHERE qr_enc IS NOT NULL AND qr_enc NOT LIKE '%FES1%'")"
req $ADMIN POST /api/cards/qr-batch '{"ids":[]}'; check "空は400" 400
req $MGR POST /api/cards/qr-batch "{\"ids\":[\"$C1\"]}"; check "責任者は不可" 403
req $ADMIN POST /api/cards/$C2/regenerate; check "QRを作り直し" 200; T2N=$(jget "['card']['token']")
req $ADMIN POST /api/cards/qr-batch "{\"ids\":[\"$C2\"]}"; expect "作り直し後は新しいQR" "$T2N" "$(python3 -I -c "import json;print(json.load(open('$TMP/body'))['cards'][0]['token'])")"
req $ADMIN POST /api/cards/$C3/delete '{"reason":"テスト","walletAction":"KEEP"}'; check "カード削除" 200
req $ADMIN POST /api/cards/qr-batch "{\"ids\":[\"$C1\",\"$C3\"]}"; expect "削除済みは含まれない" 1 "$(python3 -I -c "import json;print(len(json.load(open('$TMP/body'))['cards']))")"
sql "UPDATE cards SET qr_enc = NULL WHERE id='$C1'" >/dev/null
req $ADMIN POST /api/cards/qr-batch "{\"ids\":[\"$C1\"]}"; expect "保存前のカードはmissing" 1 "$(python3 -I -c "import json;print(len(json.load(open('$TMP/body'))['missing']))")"
expect "閲覧が監査ログに残る" 3 "$(sqlv "SELECT COUNT(*) FROM audit_logs WHERE action='card_qr.view'")"

echo "== 印刷デザイン =="
PNG="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
LAY='{"widthMm":90,"heightMm":120,"bg":"#ffffff","fit":"cover","gapMm":6,"elements":[{"key":"qr","visible":true,"x":20,"y":42,"w":60,"fontMm":0,"align":"center","color":"#000000","bold":false},{"key":"name","visible":true,"x":5,"y":17,"w":90,"fontMm":7,"align":"center","color":"#000000","bold":true}]}'
req $ADMIN POST /api/print-templates "{\"kind\":\"LOGIN\",\"name\":\"体育祭風\",\"layout\":$LAY,\"image\":\"$PNG\"}"; check "デザインを作る" 201; TP=$(jget "['id']")
req $ADMIN POST /api/print-templates "{\"kind\":\"LOGIN\",\"name\":\"画像なし\",\"layout\":$LAY,\"image\":null}"; check "画像なしも作れる" 201
req $ADMIN GET "/api/print-templates?kind=LOGIN"; expect "一覧は2件" 2 "$(python3 -I -c "import json;print(len(json.load(open('$TMP/body'))['templates']))")"
expect "一覧に画像本体は含まない" 0 "$(python3 -I -c "import json;print(sum('image' in t for t in json.load(open('$TMP/body'))['templates']))")"
req $ADMIN GET "/api/print-templates?kind=CARD"; expect "種類ごとに分かれる" 0 "$(python3 -I -c "import json;print(len(json.load(open('$TMP/body'))['templates']))")"
req $ADMIN GET /api/print-templates/$TP; check "1件取得(画像つき)" 200
expect "画像が返る" "$PNG" "$(jget "['template']['image']")"
req $MGR GET "/api/print-templates?kind=LOGIN"; check "店舗責任者は読める" 200
req $MGR GET /api/print-templates/$TP; check "責任者は画像も読める" 200
req $MGR POST /api/print-templates "{\"kind\":\"LOGIN\",\"name\":\"x\",\"layout\":$LAY,\"image\":null}"; check "責任者は作れない" 403
req $MGR DELETE /api/print-templates/$TP; check "責任者は消せない" 403
req $CLERK POST /api/auth/login '{"loginId":"clerk-a","password":"clerkpass1"}'
req $CLERK GET "/api/print-templates?kind=LOGIN"; check "店員は読めない" 403
req $ANON GET "/api/print-templates?kind=LOGIN"; check "未ログインは読めない" 401
req $ADMIN POST /api/print-templates "{\"kind\":\"LOGIN\",\"name\":\"bad\",\"layout\":$LAY,\"image\":\"data:text/html;base64,PHNjcmlwdD4=\"}"; check "画像以外は不可" 400
req $ADMIN POST /api/print-templates "{\"kind\":\"LOGIN\",\"name\":\"bad\",\"layout\":{\"widthMm\":5,\"heightMm\":120,\"bg\":\"#ffffff\",\"fit\":\"cover\",\"gapMm\":0,\"elements\":[]},\"image\":null}"; check "大きさ・要素の検証" 400
req $ADMIN POST /api/print-templates "{\"kind\":\"LOGIN\",\"name\":\"\",\"layout\":$LAY,\"image\":null}"; check "名前は必須" 400
BIG=$(python3 -I -c "print('data:image/png;base64,'+'A'*950000)")
echo "{\"kind\":\"LOGIN\",\"name\":\"big\",\"layout\":$LAY,\"image\":\"$BIG\"}" > $TMP/big.json
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -b $ADMIN -H "Origin: $BASE" -H 'content-type: application/json' --data @$TMP/big.json $BASE/api/print-templates); expect "大きすぎる画像は400" 400 "$code"
req $ADMIN PUT /api/print-templates/$TP "{\"name\":\"体育祭風v2\",\"layout\":$LAY,\"image\":null}"; check "上書き保存" 200
req $ADMIN GET /api/print-templates/$TP; expect "名前が変わる" "体育祭風v2" "$(jget "['template']['name']")"; expect "画像を外せる" None "$(jget "['template']['image']")"
req $ADMIN PUT /api/print-templates/00000000000000000000000000 "{\"name\":\"x\",\"layout\":$LAY,\"image\":null}"; check "存在しないデザインは404" 404
for i in $(seq 1 18); do curl -s -o /dev/null -X POST -b $ADMIN -H "Origin: $BASE" -H 'content-type: application/json' --data "{\"kind\":\"LOGIN\",\"name\":\"d$i\",\"layout\":$LAY,\"image\":null}" $BASE/api/print-templates; done
req $ADMIN POST /api/print-templates "{\"kind\":\"LOGIN\",\"name\":\"21件目\",\"layout\":$LAY,\"image\":null}"; check "1種類20件まで" 409
req $ADMIN DELETE /api/print-templates/$TP; check "削除" 200
req $ADMIN GET /api/print-templates/$TP; check "消えている" 404
expect "作成・更新・削除が監査ログに残る" 1 "$(sqlv "SELECT COUNT(DISTINCT action)=3 FROM audit_logs WHERE action LIKE 'print_template.%'")"

echo
echo "結果: pass=$pass fail=$fail"
[ "$fail" = 0 ]
