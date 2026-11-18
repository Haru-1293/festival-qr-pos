#!/usr/bin/env bash
# festival-qr-pos 商品・タグ・在庫・一律値下げ・POS一覧のスモークテスト。
#
# 前提: ローカルで `vite preview --port 4173` が動いていて、DBが空(migration 適用直後)であること。
# 使い方: bash scripts/smoke-catalog.sh
#
# 確認すること: 商品/タグ/在庫の登録と権限(他店舗は不可)、在庫の古い残数は409、手動売り切れ(店員も可)、
#   一律値下げ(定率/定額/端数/割引対象外/期限/停止)、カタログ版番号による変更検知。
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
expect() { if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "  ok   $1 ($3)"; else fail=$((fail+1)); echo "  FAIL $1: expected '$2' got '$3'"; fi; }
sql() { npx wrangler d1 execute DB --local --json --command "$1" 2>/dev/null | python3 -I -c "import json,sys;r=json.load(sys.stdin)[0]['results'];print(json.dumps(r))"; }
sqlv() { sql "$1" | python3 -I -c "import json,sys;r=json.load(sys.stdin);print(list(r[0].values())[0] if r else '')"; }
now_ms() { python3 -I -c "import time;print(int(time.time()*1000))"; }
# 商品一覧(POS)から指定商品の項目を取り出す: pget <商品名> <キー>
pget() { python3 -I -c "
import json,sys
d=json.load(open('$TMP/body'))
p=[x for x in d['products'] if x['name']==sys.argv[1]]
print(p[0][sys.argv[2]] if p else 'NONE')" "$1" "$2"; }

ADMIN=$TMP/admin.jar; MGR=$TMP/mgr.jar; MGRB=$TMP/mgrb.jar; CLERK=$TMP/clerk.jar; ANON=$TMP/anon.jar

echo "== 準備 =="
curl -s -o "$TMP/body" -w '%{http_code}' -X POST -H "Origin: $BASE" -H 'content-type: application/json' -H "x-setup-token: $SETUP_TOKEN" -c $ADMIN \
  --data '{"loginId":"admin","password":"adminpass1","nickname":"運営"}' $BASE/api/setup/admin > "$TMP/code"
if [ "$(code)" != "201" ]; then req $ADMIN POST /api/auth/login '{"loginId":"admin","password":"adminpass1"}'; fi
req $ADMIN POST /api/admin/shops '{"name":"2A 焼きそば","displayName":"2A 焼きそば"}'; check "店舗A作成" 201; SA=$(jget "['shop']['id']")
req $ADMIN POST /api/admin/shops '{"name":"3B たこ焼き","displayName":"3B たこ焼き"}'; check "店舗B作成" 201; SB=$(jget "['shop']['id']")
req $ADMIN POST /api/admin/users/shop-manager "{\"shopId\":\"$SA\",\"loginId\":\"mgr-a\",\"password\":\"mgrpass123\",\"nickname\":\"A責任者\"}"; check "A責任者" 201
req $ADMIN POST /api/admin/users/shop-manager "{\"shopId\":\"$SB\",\"loginId\":\"mgr-b\",\"password\":\"mgrpass123\",\"nickname\":\"B責任者\"}"; check "B責任者" 201
req $MGR POST /api/auth/login '{"loginId":"mgr-a","password":"mgrpass123"}'; check "A責任者ログイン" 200
req $MGRB POST /api/auth/login '{"loginId":"mgr-b","password":"mgrpass123"}'; check "B責任者ログイン" 200
req $MGR POST /api/shops/$SA/staff '{"loginId":"clerk-a","password":"clerkpass1","nickname":"A店員"}'; check "A店員登録" 201
req $CLERK POST /api/auth/login '{"loginId":"clerk-a","password":"clerkpass1"}'; check "A店員ログイン" 200

echo "== タグ・商品の登録 =="
req $MGR POST /api/catalog/$SA/tags '{"name":"主食","color":"#ff8800"}'; check "タグ作成" 201; TAG1=$(jget "['id']")
req $MGR POST /api/catalog/$SA/tags '{"name":"主食"}'; check "同名タグは409" 409
req $CLERK POST /api/catalog/$SA/tags '{"name":"店員が作る"}'; check "店員はタグを作れない" 403
req $MGRB POST /api/catalog/$SA/tags '{"name":"他店"}'; check "他店舗の責任者はタグを作れない" 403
req $ANON GET /api/catalog/$SA/products; check "未ログインは401" 401
req $MGR POST /api/catalog/$SA/products "{\"name\":\"焼きそば\",\"price\":300,\"saleMode\":\"BOTH\",\"discountable\":true,\"sortOrder\":1,\"tagIds\":[\"$TAG1\"],\"trackStock\":true,\"stockQty\":10}"; check "商品(数量管理)" 201; P1=$(jget "['id']")
req $MGR POST /api/catalog/$SA/products '{"name":"ドリンク","price":150,"saleMode":"SINGLE_ONLY","discountable":true,"sortOrder":2,"tagIds":[],"trackStock":false}'; check "商品(数量管理なし)" 201; P2=$(jget "['id']")
req $MGR POST /api/catalog/$SA/products '{"name":"限定おまけ","price":100,"saleMode":"BOTH","discountable":false,"sortOrder":3,"tagIds":[],"trackStock":false}'; check "割引対象外の商品" 201; P3=$(jget "['id']")
req $MGR POST /api/catalog/$SA/products '{"name":"セット限定トッピング","price":null,"saleMode":"SET_ONLY","discountable":true,"sortOrder":4,"tagIds":[],"trackStock":false}'; check "セット限定は価格なしで可" 201
req $MGR POST /api/catalog/$SA/products '{"name":"価格なし","price":null,"saleMode":"BOTH","discountable":true,"sortOrder":5,"tagIds":[],"trackStock":false}'; check "単品販売は価格必須" 400
req $MGR POST /api/catalog/$SA/products '{"name":"数量なし","price":100,"saleMode":"BOTH","discountable":true,"sortOrder":6,"tagIds":[],"trackStock":true}'; check "数量管理は準備数量が必要" 400
req $MGR POST /api/catalog/$SA/products "{\"name\":\"他店タグ\",\"price\":100,\"saleMode\":\"BOTH\",\"discountable\":true,\"sortOrder\":7,\"tagIds\":[\"01ARZ3NDEKTSV4RRFFQ69G5FAV\"],\"trackStock\":false}"; check "存在しないタグは400" 400
req $MGR POST /api/catalog/$SA/products '{"name":"マイナス","price":-1,"saleMode":"BOTH","discountable":true,"sortOrder":8,"tagIds":[],"trackStock":false}'; check "負の価格は400" 400
req $MGRB POST /api/catalog/$SA/products '{"name":"他店","price":100,"saleMode":"BOTH","discountable":true,"sortOrder":9,"tagIds":[],"trackStock":false}'; check "他店舗の責任者は商品を作れない" 403
expect "初期在庫の移動記録" 1 "$(sqlv "SELECT count(*) FROM stock_movements WHERE product_id='$P1' AND reason='INITIAL' AND qty_after=10")"

echo "== POS一覧 =="
req $CLERK GET /api/pos/$SA/catalog; check "店員がPOS一覧を取得" 200; SIG0=$(jget "['signature']")
expect "セット限定の非売品は一覧に出ない" NONE "$(pget セット限定トッピング name)"
expect "焼きそばの価格" 300 "$(pget 焼きそば salePrice)"
expect "タグが付く" 主食 "$(python3 -I -c "import json;d=json.load(open('$TMP/body'));print([p for p in d['products'] if p['name']=='焼きそば'][0]['tags'][0]['name'])")"
req $CLERK GET "/api/pos/$SA/catalog?sig=$SIG0"; check "署名が同じなら変更なし" 200; expect "changed=false" False "$(jget "['changed']")"
req $MGRB GET /api/pos/$SA/catalog; check "他店舗の責任者はPOS一覧を見られない" 403
req $ANON GET /api/pos/$SA/catalog; check "未ログインは401" 401

echo "== 手動売り切れ(店員も可) =="
req $CLERK POST /api/pos/$SA/products/$P2/sold-out '{"soldOut":true}'; check "店員が売り切れにする" 200
req $CLERK GET "/api/pos/$SA/catalog?sig=$SIG0"; expect "変更が検知される" True "$(jget "['changed']")"; SIG1=$(jget "['signature']")
expect "売り切れ表示" True "$(pget ドリンク soldOut)"; expect "理由は手動" MANUAL "$(pget ドリンク soldOutReason)"
req $MGRB POST /api/pos/$SA/products/$P2/sold-out '{"soldOut":false}'; check "他店舗は売り切れを変えられない" 403
req $CLERK POST /api/pos/$SA/products/$P2/sold-out '{"soldOut":false}'; check "店員が販売再開" 200
expect "売り切れ操作の監査ログ" 2 "$(sqlv "SELECT count(*) FROM audit_logs WHERE target_id='$P2' AND action IN ('product.sold_out','product.resume_sale')")"

echo "== 在庫 =="
req $MGR POST /api/catalog/$SA/products/$P1/stock '{"delta":5,"reason":"RESTOCK","expectedQty":10}'; check "追加準備+5" 200; expect "残数15" 15 "$(jget "['stockQty']")"
req $MGR POST /api/catalog/$SA/products/$P1/stock '{"delta":3,"reason":"RESTOCK","expectedQty":10}'; check "古い残数での更新は409" 409
req $MGR POST /api/catalog/$SA/products/$P1/stock '{"delta":-20,"reason":"DISCARD","expectedQty":15}'; check "残数がマイナスになる廃棄は400" 400
req $MGR POST /api/catalog/$SA/products/$P1/stock '{"delta":-2,"reason":"RESTOCK","expectedQty":15}'; check "追加準備に負数は400" 400
req $MGR POST /api/catalog/$SA/products/$P1/stock '{"delta":-5,"reason":"DISCARD","expectedQty":15,"note":"落とした"}'; check "廃棄-5" 200; expect "残数10" 10 "$(jget "['stockQty']")"
req $MGR POST /api/catalog/$SA/products/$P2/stock '{"delta":1,"reason":"RESTOCK","expectedQty":0}'; check "数量管理なしの商品は不可" 400
req $CLERK POST /api/catalog/$SA/products/$P1/stock '{"delta":1,"reason":"RESTOCK","expectedQty":10}'; check "店員は在庫を調整できない" 403
req $MGRB POST /api/catalog/$SA/products/$P1/stock '{"delta":1,"reason":"RESTOCK","expectedQty":10}'; check "他店舗は不可" 403
# 同時に同じ残数で更新: 片方だけ成功
for i in 1 2 3 4; do (curl -s -o "$TMP/race$i" -w '%{http_code}\n' -X POST -b $MGR -H "Origin: $BASE" -H 'content-type: application/json' --data '{"delta":1,"reason":"RESTOCK","expectedQty":10}' $BASE/api/catalog/$SA/products/$P1/stock > "$TMP/racecode$i" &) ; done; sleep 3
expect "同時更新は1件だけ成功" 1 "$(cat $TMP/racecode* | grep -c '^200$')"
expect "残数は11" 11 "$(sqlv "SELECT stock_qty FROM products WHERE id='$P1'")"
expect "在庫移動の合計=残数" "$(sqlv "SELECT stock_qty FROM products WHERE id='$P1'")" "$(sqlv "SELECT SUM(delta) FROM stock_movements WHERE product_id='$P1'")"
expect "失敗した更新の監査ログは残らない" 1 "$(sqlv "SELECT count(*) FROM audit_logs WHERE target_id='$P1' AND action='stock.restock' AND after_json LIKE '%\"qty\":11%'")"
req $MGR POST /api/catalog/$SA/products/$P1/stock-mode '{"trackStock":false}'; check "数量管理をやめる" 200
expect "残数が消える" None "$(sqlv "SELECT stock_qty FROM products WHERE id='$P1'")"
req $MGR POST /api/catalog/$SA/products/$P1/stock-mode '{"trackStock":true}'; check "再開は準備数量が必要" 400
req $MGR POST /api/catalog/$SA/products/$P1/stock-mode '{"trackStock":true,"stockQty":1}'; check "数量管理を再開" 200
req $CLERK GET /api/pos/$SA/catalog
req $MGR POST /api/catalog/$SA/products/$P1/stock '{"delta":-1,"reason":"DISCARD","expectedQty":1}'; check "残数0にする" 200
req $CLERK GET /api/pos/$SA/catalog; expect "残数0は自動売り切れ" STOCK "$(pget 焼きそば soldOutReason)"
req $MGR POST /api/catalog/$SA/products/$P1/stock '{"delta":10,"reason":"RESTOCK","expectedQty":0}'; check "追加準備" 200
req $CLERK GET /api/pos/$SA/catalog; expect "追加で自動的に販売再開" False "$(pget 焼きそば soldOut)"

echo "== 一律値下げ =="
req $CLERK POST /api/catalog/$SA/price-cuts '{"name":"x","method":"PERCENT","value":10}'; check "店員は値下げを設定できない" 403
req $MGRB POST /api/catalog/$SA/price-cuts '{"name":"x","method":"PERCENT","value":10}'; check "他店舗は設定できない" 403
req $MGR POST /api/catalog/$SA/price-cuts '{"name":"x","method":"PERCENT","value":101}'; check "101%は400" 400
req $MGR POST /api/catalog/$SA/price-cuts '{"name":"x","method":"FIXED","value":0}'; check "0円引きは400" 400
req $MGR POST /api/catalog/$SA/price-cuts "{\"name\":\"x\",\"method\":\"PERCENT\",\"value\":10,\"endsAt\":$(( $(now_ms) - 1000 ))}"; check "過去の終了時刻は400" 400
req $CLERK GET /api/pos/$SA/catalog; SIGB=$(jget "['signature']")
req $MGR POST /api/catalog/$SA/price-cuts '{"name":"タイムセール","method":"PERCENT","value":15}'; check "15%引きを設定" 201; CUT1=$(jget "['id']")
req $CLERK GET "/api/pos/$SA/catalog?sig=$SIGB"; expect "POSが値下げを検知" True "$(jget "['changed']")"
expect "150円の15%引き=値下げ22円(切り捨て)→128円" 128 "$(pget ドリンク salePrice)"
expect "300円→255円" 255 "$(pget 焼きそば salePrice)"
expect "定価は変わらない" 300 "$(pget 焼きそば price)"
expect "割引対象外の商品は値下げしない" 100 "$(pget 限定おまけ salePrice)"
expect "値下げ名" タイムセール "$(jget "['cut']['name']")"
req $MGR POST /api/catalog/$SA/price-cuts '{"name":"二重","method":"FIXED","value":50}'; check "同時に2つは設定できない" 409
req $MGRB GET /api/pos/$SB/catalog; expect "他店舗には影響しない" None "$(jget "['cut']")"
req $MGR POST /api/catalog/$SA/price-cuts/$CUT1/stop '{}'; check "値下げを停止" 200
req $CLERK GET /api/pos/$SA/catalog; expect "停止で元の価格へ" 300 "$(pget 焼きそば salePrice)"; expect "cutなし" None "$(jget "['cut']")"
req $MGR POST /api/catalog/$SA/price-cuts/$CUT1/stop '{}'; check "停止済みは400" 400
req $MGR POST /api/catalog/$SA/price-cuts '{"name":"50円引き","method":"FIXED","value":200}'; check "定額200円引きを設定" 201; CUT2=$(jget "['id']")
req $CLERK GET /api/pos/$SA/catalog; expect "150円-200円は0円(マイナスにならない)" 0 "$(pget ドリンク salePrice)"; expect "300円-200円=100円" 100 "$(pget 焼きそば salePrice)"
req $MGR POST /api/catalog/$SA/price-cuts/$CUT2/stop '{}'; check "停止" 200
FUT=$(( $(now_ms) + 3600000 ))
req $MGR POST /api/catalog/$SA/price-cuts "{\"name\":\"予約\",\"method\":\"PERCENT\",\"value\":50,\"startsAt\":$FUT}"; check "開始前の値下げ(予約)を設定" 201; CUT3=$(jget "['id']")
req $CLERK GET /api/pos/$SA/catalog; expect "予約中はまだ効かない" 300 "$(pget 焼きそば salePrice)"
req $MGR POST /api/catalog/$SA/price-cuts/$CUT3/stop '{}'; check "予約を停止" 200
END=$(( $(now_ms) + 2500 ))
req $MGR POST /api/catalog/$SA/price-cuts "{\"name\":\"短時間\",\"method\":\"PERCENT\",\"value\":10,\"endsAt\":$END}"; check "終了時刻つき" 201
req $CLERK GET /api/pos/$SA/catalog; expect "期間中は効く" 270 "$(pget 焼きそば salePrice)"; SIGC=$(jget "['signature']")
sleep 3
req $CLERK GET "/api/pos/$SA/catalog?sig=$SIGC"; expect "期限が過ぎると署名が変わる" True "$(jget "['changed']")"
expect "期限後は元の価格" 300 "$(pget 焼きそば salePrice)"
req $MGR POST /api/catalog/$SA/price-cuts '{"name":"期限切れの後でも作れる","method":"FIXED","value":10}'; check "期限切れを整理して新規設定" 201
req $MGR GET /api/catalog/$SA/price-cuts; check "履歴一覧" 200
expect "値下げの監査ログ" 1 "$(sqlv "SELECT count(*) FROM audit_logs WHERE action='price_cut.create' AND after_json LIKE '%タイムセール%'")"

echo "== 商品の変更・アーカイブ =="
req $MGR PATCH /api/catalog/$SA/products/$P2 '{"price":200}'; check "定価の変更" 200
req $CLERK PATCH /api/catalog/$SA/products/$P2 '{"price":1}'; check "店員は定価を変えられない" 403
req $MGRB PATCH /api/catalog/$SA/products/$P2 '{"price":1}'; check "他店舗は変えられない" 403
req $MGR PATCH /api/catalog/$SA/products/$P2 '{"saleMode":"BOTH","price":null}'; check "価格を消して単品販売は400" 400
req $MGR PATCH /api/catalog/$SA/products/$P2 '{"status":"ARCHIVED"}'; check "アーカイブ" 200
req $CLERK GET /api/pos/$SA/catalog; expect "アーカイブはPOSに出ない" NONE "$(pget ドリンク name)"
expect "行は削除されず残る" 1 "$(sqlv "SELECT count(*) FROM products WHERE id='$P2' AND status='ARCHIVED'")"
req $MGR PATCH /api/catalog/$SA/products/$P2 '{"name":"改名"}'; check "アーカイブ済みは変更できない" 400
req $MGR GET /api/catalog/$SA/products; check "管理一覧" 200
req $MGR PATCH /api/catalog/$SA/tags/$TAG1 '{"active":false}'; check "タグを無効化" 200
req $CLERK GET /api/pos/$SA/catalog; expect "無効タグは一覧に出ない" 0 "$(python3 -I -c "import json;d=json.load(open('$TMP/body'));print(len([p for p in d['products'] if p['name']=='焼きそば'][0]['tags']))")"

echo
echo "結果: pass=$pass fail=$fail"
[ $fail -eq 0 ]
