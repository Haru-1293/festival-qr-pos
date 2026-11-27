#!/usr/bin/env bash
# メニュー画像・マイページの店舗一覧・既存店舗への責任者追加のスモークテスト。
# 前提: ローカルで `vite preview --port 4173` が動いていて、DBが空(migration 適用直後)であること。
BASE=${BASE:-http://127.0.0.1:4173}
SETUP_TOKEN=${SETUP_TOKEN:-local-setup-token-for-testing}
TMP=$(mktemp -d)
pass=0; fail=0
cd "$(dirname "$0")/.." || exit 1

req() { local jar=$1 method=$2 path=$3 body=${4:-}
  local args=(-s -o "$TMP/body" -w '%{http_code}' -X "$method" -b "$jar" -c "$jar" -H "Origin: $BASE")
  [ -n "$body" ] && args+=(-H 'content-type: application/json' --data "$body")
  curl "${args[@]}" "$BASE$path" > "$TMP/code"; }
code() { cat "$TMP/code"; }
body() { cat "$TMP/body"; }
jget() { python3 -I -c "import sys,json;d=json.load(open('$TMP/body'));print(eval('d'+sys.argv[1]))" "$1"; }
check() { if [ "$(code)" = "$2" ]; then pass=$((pass+1)); echo "  ok   $1 ($2)"; else fail=$((fail+1)); echo "  FAIL $1: expected $2 got $(code): $(body | head -c 300)"; fi; }
expect() { if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "  ok   $1 ($3)"; else fail=$((fail+1)); echo "  FAIL $1: expected '$2' got '$3'"; fi; }
sqlv() { npx wrangler d1 execute DB --local --json --command "$1" 2>/dev/null | python3 -I -c "import json,sys;r=json.load(sys.stdin)[0]['results'];print(list(r[0].values())[0] if r else '')"; }
mk() { python3 -I - "$1" "$2" "$3" <<'PY'
import sys,os
kind,size,out=sys.argv[1],int(sys.argv[2]),sys.argv[3]
head={'png':b'\x89PNG\r\n\x1a\n','jpg':b'\xff\xd8\xff\xe0','webp':b'RIFF\x00\x00\x00\x00WEBPVP8 ','fake':b'NOTANIMAGE123456'}[kind]
open(out,'wb').write(head+os.urandom(max(0,size-len(head))))
PY
}
upload() { curl -s -o "$TMP/body" -w '%{http_code}' -X POST -b "$1" -H "Origin: $BASE" -H "content-type: $2" --data-binary @"$4" $BASE/api/catalog/$3/menu-images > "$TMP/code"; }

ADMIN=$TMP/admin.jar; MGR=$TMP/mgr.jar; MGR2=$TMP/mgr2.jar; MGRB=$TMP/mgrb.jar; CLERK=$TMP/clerk.jar; ALICE=$TMP/alice.jar; ANON=$TMP/anon.jar
echo "== 準備 =="
curl -s -o /dev/null -X POST -H "Origin: $BASE" -H 'content-type: application/json' -H "x-setup-token: $SETUP_TOKEN" -c $ADMIN --data '{"loginId":"admin","password":"adminpass1","nickname":"運営"}' $BASE/api/setup/admin
req $ADMIN POST /api/auth/login '{"loginId":"admin","password":"adminpass1"}'; check "管理者ログイン" 200
req $ADMIN POST /api/admin/shops '{"name":"3A 焼きそば","displayName":"3A 焼きそば"}'; SA=$(jget "['shop']['id']")
req $ADMIN POST /api/admin/shops '{"name":"3B たこ焼き","displayName":"3B たこ焼き"}'; SB=$(jget "['shop']['id']")
req $ADMIN POST /api/admin/users/shop-manager "{\"shopId\":\"$SA\",\"loginId\":\"mgr-a\",\"password\":\"mgrpass123\",\"nickname\":\"A責任者\"}"
req $ADMIN POST /api/admin/users/shop-manager "{\"shopId\":\"$SB\",\"loginId\":\"mgr-b\",\"password\":\"mgrpass123\",\"nickname\":\"B責任者\"}"
req $MGR POST /api/auth/login '{"loginId":"mgr-a","password":"mgrpass123"}'; check "A責任者ログイン" 200
req $MGRB POST /api/auth/login '{"loginId":"mgr-b","password":"mgrpass123"}'; check "B責任者ログイン" 200
req $MGR POST /api/shops/$SA/staff '{"loginId":"clerk-a","password":"clerkpass1","nickname":"A店員"}'
req $CLERK POST /api/auth/login '{"loginId":"clerk-a","password":"clerkpass1"}'; check "店員ログイン" 200
req $ALICE POST /api/auth/register '{"email":"alice@example.com","password":"alicepass1","nickname":"アリス"}'

echo "== 責任者の追加(既存の店舗) =="
req $ADMIN GET /api/admin/shops/$SA/managers; check "責任者一覧" 200
expect "最初は1人" 1 "$(jget "['managers'].__len__()")"
req $ADMIN POST /api/admin/users/shop-manager "{\"shopId\":\"$SA\",\"loginId\":\"mgr-a2\",\"password\":\"mgrpass456\",\"nickname\":\"A責任者2\"}"; check "既存店舗に責任者を追加" 201
req $ADMIN GET /api/admin/shops/$SA/managers
expect "2人になる" 2 "$(jget "['managers'].__len__()")"
req $MGR2 POST /api/auth/login '{"loginId":"mgr-a2","password":"mgrpass456"}'; check "追加した責任者でログインできる" 200
req $MGR2 GET /api/catalog/$SA/products; check "追加した責任者がA店の商品を見られる" 200
req $MGR2 GET /api/catalog/$SB/products; check "B店は見られない" 403
req $ADMIN POST /api/admin/users/shop-manager "{\"shopId\":\"$SA\",\"loginId\":\"mgr-a2\",\"password\":\"mgrpass456\",\"nickname\":\"重複\"}"; check "ログインIDの重複は不可" 409
req $MGR GET /api/admin/shops/$SA/managers; check "責任者は一覧を見られない" 403
req $MGR POST /api/admin/users/shop-manager "{\"shopId\":\"$SA\",\"loginId\":\"x1\",\"password\":\"mgrpass456\",\"nickname\":\"x\"}"; check "責任者は追加できない" 403

echo "== メニュー画像 =="
mk png 3000 $TMP/a.png; mk jpg 3000 $TMP/b.jpg; mk fake 3000 $TMP/fake.png; mk png 9000000 $TMP/big.png
upload $MGR image/png $SA $TMP/a.png; check "PNGをアップロード" 201
K1=$(jget "['key']"); URL1=$(jget "['url']"); echo "  key=$K1"
upload $MGR image/png $SA $TMP/fake.png; check "偽の画像は不可" 400
upload $MGR image/gif $SA $TMP/a.png; check "GIFは不可" 400
upload $CLERK image/png $SA $TMP/a.png; check "店員は不可" 403
upload $MGRB image/png $SA $TMP/a.png; check "他店の責任者は不可" 403
upload $ALICE image/png $SA $TMP/a.png; check "利用者は不可" 403
upload $ANON image/png $SA $TMP/a.png; check "未ログインは不可" 401
upload $MGR image/png $SA $TMP/big.png; echo "  大きい画像: $(code)"
[ "$(code)" = "413" -o "$(code)" = "400" -o "$(code)" = "500" ] && { pass=$((pass+1)); echo "  ok   大きい画像は拒否"; } || { fail=$((fail+1)); echo "  FAIL 大きい画像が通った"; }

req $MGR POST /api/catalog/$SA/products "{\"name\":\"焼きそば\",\"price\":400,\"description\":null,\"saleMode\":\"BOTH\",\"discountable\":true,\"sortOrder\":0,\"tagIds\":[],\"trackStock\":false,\"stockQty\":null,\"imageKey\":\"$K1\"}"; check "画像つきで商品を作る" 201
P1=$(jget "['id']")
req $MGR GET /api/catalog/$SA/products
expect "商品に画像URL" "$URL1" "$(jget "['products'][0]['imageUrl']")"
curl -s -o "$TMP/img" -D "$TMP/hdr" -w '%{http_code}' $BASE$URL1 > $TMP/code; check "画像は未ログインで見られる" 200
expect "画像の中身が同じ" "$(md5sum < $TMP/a.png)" "$(md5sum < $TMP/img)"
grep -qi 'x-content-type-options: nosniff' $TMP/hdr && { pass=$((pass+1)); echo "  ok   nosniff"; } || { fail=$((fail+1)); echo "  FAIL nosniff なし"; }
grep -qi 'content-type: image/png' $TMP/hdr && { pass=$((pass+1)); echo "  ok   content-type"; } || { fail=$((fail+1)); echo "  FAIL content-type"; }
curl -s -o /dev/null -w '%{http_code}' $BASE/api/public/menu-images/00000000000000000000000000.png > $TMP/code; check "存在しないキー" 404
curl -s -o /dev/null -w '%{http_code}' $BASE/api/public/menu-images/../x > $TMP/code; echo "  traversal: $(code)"
req $MGR POST /api/catalog/$SA/products '{"name":"x","price":1,"saleMode":"BOTH","discountable":true,"sortOrder":0,"tagIds":[],"trackStock":false,"stockQty":null,"imageKey":"00000000000000000000000000.png"}'; check "未アップロードのキーは不可" 400
req $MGR POST /api/catalog/$SA/products '{"name":"x","price":1,"saleMode":"BOTH","discountable":true,"sortOrder":0,"tagIds":[],"trackStock":false,"stockQty":null,"imageKey":"../../etc"}'; check "不正なキーは不可" 400

echo "== 画像の変更・削除 =="
upload $MGR image/jpeg $SA $TMP/b.jpg; check "別画像をアップロード" 201; K2=$(jget "['key']"); URL2=$(jget "['url']")
req $MGR PATCH /api/catalog/$SA/products/$P1 "{\"imageKey\":\"$K2\"}"; check "画像を変更" 200
req $MGR GET /api/catalog/$SA/products; expect "新しいURL" "$URL2" "$(jget "['products'][0]['imageUrl']")"
sleep 1
curl -s -o /dev/null -w '%{http_code}' $BASE$URL1 > $TMP/code; check "使われなくなった古い画像は消える" 404
req $MGR PATCH /api/catalog/$SA/products/$P1 '{"name":"焼きそば(大)"}'; check "画像を触らず更新" 200
req $MGR GET /api/catalog/$SA/products; expect "画像はそのまま" "$URL2" "$(jget "['products'][0]['imageUrl']")"
req $MGR PATCH /api/catalog/$SA/products/$P1 '{"imageKey":null}'; check "画像を外す" 200
req $MGR GET /api/catalog/$SA/products; expect "画像なし" "None" "$(jget "['products'][0]['imageUrl']")"
sleep 1
curl -s -o /dev/null -w '%{http_code}' $BASE$URL2 > $TMP/code; check "外した画像も消える" 404

echo "== セットの画像 =="
upload $MGR image/png $SA $TMP/a.png; K3=$(jget "['key']"); URL3=$(jget "['url']")
SET="{\"name\":\"セット\",\"price\":500,\"description\":null,\"imageKey\":\"$K3\",\"discountable\":true,\"sortOrder\":0,\"segments\":[{\"name\":\"主\",\"required\":true,\"pickCount\":1,\"allowDuplicate\":false,\"items\":[{\"productId\":\"$P1\",\"surcharge\":0}]}]}"
req $MGR POST /api/catalog/$SA/sets "$SET"; check "画像つきセット" 201; S1=$(jget "['id']")
req $MGR GET /api/catalog/$SA/sets; expect "セットの画像URL" "$URL3" "$(jget "['sets'][0]['imageUrl']")"
req $MGR PUT /api/catalog/$SA/sets/$S1 "$(echo "$SET" | python3 -I -c "import sys,json;d=json.load(sys.stdin);d.pop('imageKey');print(json.dumps(d))")"; check "imageKey省略で更新" 200
req $MGR GET /api/catalog/$SA/sets; expect "省略したら変えない" "$URL3" "$(jget "['sets'][0]['imageUrl']")"
req $MGR PUT /api/catalog/$SA/sets/$S1 "$(echo "$SET" | sed 's/"imageKey":"[^"]*"/"imageKey":null/')"; check "セット画像を外す" 200
req $MGR GET /api/catalog/$SA/sets; expect "セット画像なし" "None" "$(jget "['sets'][0]['imageUrl']")"

echo "== 公開メニュー・マイページ =="
upload $MGR image/png $SA $TMP/a.png; K4=$(jget "['key']"); URL4=$(jget "['url']")
req $MGR PATCH /api/catalog/$SA/products/$P1 "{\"imageKey\":\"$K4\"}"
curl -s -o $TMP/body -w '%{http_code}' $BASE/api/public/shops/$SA/menu > $TMP/code; check "公開メニュー(未ログイン)" 200
expect "公開メニューに画像" "$URL4" "$(python3 -I -c "import json;d=json.load(open('$TMP/body'));print([i for i in d['items'] if i['kind']=='PRODUCT'][0]['imageUrl'])")"
req $ALICE GET /api/public/shops; check "利用者も店舗一覧を取れる" 200
req $ALICE GET /api/public/shops/$SA/menu; check "利用者もメニューを取れる" 200

echo
echo "pass=$pass fail=$fail"
[ $fail -eq 0 ]
