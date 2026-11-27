#!/usr/bin/env bash
# カードデザインの背景画像(R2 / D1)のスモークテスト。R2のテストは、R2バインディング IMAGES があるときだけ行う。
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

# 画像ファイル(中身の先頭だけ本物のPNG/JPEG/WebPの印。大きさは自由)
mk() { python3 -I - "$1" "$2" "$3" <<'PY'
import sys,os
kind,size,out=sys.argv[1],int(sys.argv[2]),sys.argv[3]
head={'png':b'\x89PNG\r\n\x1a\n','jpg':b'\xff\xd8\xff\xe0','webp':b'RIFF\x00\x00\x00\x00WEBPVP8 ','fake':b'NOTANIMAGE123456'}[kind]
open(out,'wb').write(head+os.urandom(max(0,size-len(head))))
PY
}
upload() { # upload <jar> <content-type> <file>
  curl -s -o "$TMP/body" -w '%{http_code}' -X POST -b "$1" -H "Origin: $BASE" -H "content-type: $2" --data-binary @"$3" $BASE/api/print-templates/images > "$TMP/code"
}
LAY='{"widthMm":55,"heightMm":85,"bg":"#ffffff","fit":"cover","gapMm":4,"elements":[{"key":"qr","visible":true,"x":15,"y":14,"w":70,"fontMm":0,"align":"center","color":"#000000","bold":false}]}'

echo "== 保存先の確認 =="
req $ADMIN GET /api/print-templates/storage; check "管理者は保存先を確認できる" 200
MODE=$(jget "['mode']"); echo "  mode=$MODE"
req $MGR GET /api/print-templates/storage; check "店舗責任者も確認できる" 200
req $CLERK GET /api/print-templates/storage; check "店員は不可" 403

if [ "$MODE" = "r2" ]; then
echo "== R2: アップロード =="
expect "上限は10MB" 10000000 "$(req $ADMIN GET /api/print-templates/storage; jget "['maxBytes']")"
mk png 3000000 $TMP/big.png
upload $ADMIN image/png $TMP/big.png; check "3MBのPNGをアップロード" 201
K1=$(jget "['key']"); expect "キーの形式" 1 "$(python3 -I -c "import re;print(int(bool(re.fullmatch(r'[0-9A-Za-z]{26}\.png','$K1'))))")"
mk jpg 9500000 $TMP/near.jpg
upload $ADMIN image/jpeg $TMP/near.jpg; check "9.5MBのJPEGもアップロードできる" 201; KJ=$(jget "['key']")
mk webp 20000 $TMP/s.webp
upload $ADMIN image/webp $TMP/s.webp; check "WebP" 201
mk png 10500000 $TMP/huge.png
upload $ADMIN image/png $TMP/huge.png; check "10MBを超えると拒否" 400
expect "コード" IMAGE_TOO_LARGE "$(jget "['error']['code']")"
mk fake 5000 $TMP/fake.png
upload $ADMIN image/png $TMP/fake.png; check "中身が画像でないものは拒否" 400
upload $ADMIN image/jpeg $TMP/big.png; check "種類と中身が合わないものは拒否" 400
upload $ADMIN image/gif $TMP/s.webp; check "対応していない種類は拒否" 400
upload $ADMIN image/png /dev/null; check "空は拒否" 400
upload $MGR image/webp $TMP/s.webp; check "店舗責任者はアップロード不可" 403
upload $CLERK image/webp $TMP/s.webp; check "店員は不可" 403
upload $ANON image/webp $TMP/s.webp; check "未ログインは401" 401

echo "== R2: デザインの保存と参照 =="
req $ADMIN POST /api/print-templates "{\"kind\":\"CARD\",\"name\":\"R2デザイン\",\"layout\":$LAY,\"imageKey\":\"$K1\"}"; check "画像キーつきで保存" 201; T1=$(jget "['id']")
expect "DBにはキーだけ(data URLは入れない)" "None|$K1" "$(sqlv "SELECT COALESCE(image,'None')||'|'||image_key FROM print_templates WHERE id='$T1'")"
req $ADMIN GET /api/print-templates/$T1; check "デザインを取得" 200
expect "画像はURLで返る" "/api/print-templates/images/$K1" "$(jget "['template']['image']")"
expect "hasImage" True "$(jget "['template']['hasImage']")"
req $ADMIN GET "/api/print-templates?kind=CARD"; expect "一覧のhasImage" True "$(jget "['templates'][0]['hasImage']")"
curl -s -o $TMP/dl.png -D $TMP/hdr -b $ADMIN -H "Origin: $BASE" $BASE/api/print-templates/images/$K1
expect "画像を取得(元と同じバイト列)" "$(sha256sum < $TMP/big.png)" "$(sha256sum < $TMP/dl.png)"
expect "Content-Type" image/png "$(grep -i '^content-type' $TMP/hdr | tr -d '\r' | awk '{print tolower($2)}')"
expect "nosniff" nosniff "$(grep -i '^x-content-type-options' $TMP/hdr | tr -d '\r' | awk '{print tolower($2)}')"
req $MGR GET /api/print-templates/images/$K1; check "店舗責任者も画像を見られる(印刷のため)" 200
req $CLERK GET /api/print-templates/images/$K1; check "店員は不可" 403
req $ANON GET /api/print-templates/images/$K1; check "未ログインは401" 401
req $ADMIN GET /api/print-templates/images/00000000000000000000000000.png; check "存在しない画像は404" 404
req $ADMIN GET "/api/print-templates/images/..%2F..%2Fx.png"; expect "不正なキーは400/404" 1 "$([ "$(code)" = 400 ] || [ "$(code)" = 404 ] && echo 1 || echo 0)"
req $ADMIN POST /api/print-templates "{\"kind\":\"CARD\",\"name\":\"無い画像\",\"layout\":$LAY,\"imageKey\":\"AAAAAAAAAAAAAAAAAAAAAAAAAA.png\"}"; check "アップロードしていないキーは拒否" 400
req $ADMIN POST /api/print-templates "{\"kind\":\"CARD\",\"name\":\"両方\",\"layout\":$LAY,\"imageKey\":\"$K1\",\"image\":\"data:image/png;base64,AAAA\"}"; check "画像とキーを同時に指定は400" 400
req $ADMIN POST /api/print-templates "{\"kind\":\"CARD\",\"name\":\"不正キー\",\"layout\":$LAY,\"imageKey\":\"../../etc/passwd\"}"; check "不正な形式のキーは400" 400

echo "== R2: 差し替え・削除でR2から消える =="
req $ADMIN POST /api/print-templates "{\"kind\":\"CARD\",\"name\":\"同じ画像\",\"layout\":$LAY,\"imageKey\":\"$K1\"}"; check "同じ画像を別デザインでも使う" 201; T2=$(jget "['id']")
req $ADMIN PUT /api/print-templates/$T1 "{\"name\":\"R2デザイン\",\"layout\":$LAY,\"imageKey\":\"$KJ\"}"; check "画像を差し替える" 200
sleep 1
req $ADMIN GET /api/print-templates/images/$K1; check "ほかのデザインが使っている旧画像は残る" 200
req $ADMIN DELETE /api/print-templates/$T2; check "デザインを削除" 200
sleep 1
req $ADMIN GET /api/print-templates/images/$K1; check "どこからも使われなくなった画像はR2から消える" 404
req $ADMIN PUT /api/print-templates/$T1 "{\"name\":\"R2デザイン\",\"layout\":$LAY,\"imageKey\":null}"; check "画像を外す" 200
sleep 1
req $ADMIN GET /api/print-templates/images/$KJ; check "外した画像もR2から消える" 404
expect "画像なしになる" False "$(req $ADMIN GET /api/print-templates/$T1; jget "['template']['hasImage']")"
fi

echo "== D1(縮小data URL)の保存は、どちらのモードでも使える =="
SMALL="data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ"
req $ADMIN POST /api/print-templates "{\"kind\":\"LOGIN\",\"name\":\"インライン\",\"layout\":$LAY,\"image\":\"$SMALL\"}"; check "data URLで保存" 201; TI=$(jget "['id']")
req $ADMIN GET /api/print-templates/$TI; expect "data URLのまま返る" "$SMALL" "$(jget "['template']['image']")"
python3 -I -c "import json;print(json.dumps({'kind':'LOGIN','name':'大きすぎ','layout':json.loads('$LAY'),'image':'data:image/png;base64,'+'A'*950000}))" > $TMP/big.json
curl -s -o "$TMP/body" -w '%{http_code}' -X POST -b $ADMIN -H "Origin: $BASE" -H 'content-type: application/json' --data @$TMP/big.json $BASE/api/print-templates > "$TMP/code"; check "data URLが900KBを超えると拒否" 400
req $ADMIN POST /api/print-templates "{\"kind\":\"LOGIN\",\"name\":\"画像なし\",\"layout\":$LAY}"; check "画像の指定なしでも保存できる" 201
if [ "$MODE" != "r2" ]; then
  mk png 2000 $TMP/none.png; upload $ADMIN image/png $TMP/none.png; check "R2なしのときアップロードは409" 409
  expect "コード" R2_NOT_CONFIGURED "$(jget "['error']['code']")"
  req $ADMIN POST /api/print-templates "{\"kind\":\"CARD\",\"name\":\"キー\",\"layout\":$LAY,\"imageKey\":\"AAAAAAAAAAAAAAAAAAAAAAAAAA.png\"}"; check "R2なしで画像キーは409" 409
fi

echo
echo "結果: pass=$pass fail=$fail"
[ "$fail" = 0 ]
