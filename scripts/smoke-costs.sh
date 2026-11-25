#!/usr/bin/env bash
# 原価・粗利、返金率、返金の検索、注文取消し、監査ログの検索のスモークテスト。
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


ADMIN=$TMP/admin.jar; ALICE=$TMP/alice.jar; R1=$TMP/r1.jar; R2=$TMP/r2.jar; MGR=$TMP/mgr.jar; MGR2=$TMP/mgr2.jar; MGRB=$TMP/mgrb.jar; CLERK=$TMP/clerk.jar; ANON=$TMP/anon.jar
items() { python3 -I -c "
import json,sys
a=sys.argv[1:]
print(json.dumps([{'productId':a[i],'quantity':int(a[i+1])} for i in range(0,len(a),2)]))" "$@"; }
charge() { local q; q=$(newQr "$2"); lookup "$1" "$q"; local l; l=$(jget "['lookupId']")
  req "$1" POST /api/reception/charge "{\"lookupId\":\"$l\",\"requestId\":\"$(rid)\",\"cashAmount\":$3}"; }
buy() { # buy <customerJar> <itemsJson> → ORDER, CALLNO
  local q; q=$(newQr "$1"); req $CLERK POST /api/pos/$SA/pay/scan "{\"token\":\"$q\",\"items\":$2}"
  local s; s=$(jget "['sessionId']"); local t; t=$(jget "['quote']['total']")
  req $CLERK POST /api/pos/$SA/pay/$s/commit "{\"requestId\":\"$(rid)\",\"expectedTotal\":$t}"
  ORDER=$(jget "['orderId']"); CALLNO=$(jget "['callNo']"); }

NOW=$(python3 -I -c "import time;print(int(time.time()*1000))")
echo "== 準備 =="
if [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Origin: $BASE" -H 'content-type: application/json' -H "x-setup-token: $SETUP_TOKEN" -c $ADMIN --data '{"loginId":"admin","password":"adminpass1","nickname":"運営"}' $BASE/api/setup/admin)" != "201" ]; then req $ADMIN POST /api/auth/login '{"loginId":"admin","password":"adminpass1"}'; fi
req $ADMIN POST /api/admin/shops '{"name":"2A 焼きそば","displayName":"2A 焼きそば"}'; SA=$(jget "['shop']['id']")
req $ADMIN POST /api/admin/shops '{"name":"2B たこ焼き","displayName":"2B たこ焼き"}'; SB=$(jget "['shop']['id']")
req $ADMIN POST /api/admin/users/shop-manager "{\"shopId\":\"$SA\",\"loginId\":\"mgr-a\",\"password\":\"mgrpass123\",\"nickname\":\"A責任者\"}"
req $ADMIN POST /api/admin/users/shop-manager "{\"shopId\":\"$SB\",\"loginId\":\"mgr-b\",\"password\":\"mgrpass123\",\"nickname\":\"B責任者\"}"
req $MGR POST /api/auth/login '{"loginId":"mgr-a","password":"mgrpass123"}'
req $MGRB POST /api/auth/login '{"loginId":"mgr-b","password":"mgrpass123"}'
req $MGR POST /api/shops/$SA/staff '{"loginId":"clerk-a","password":"clerkpass1","nickname":"A店員"}'
req $CLERK POST /api/auth/login '{"loginId":"clerk-a","password":"clerkpass1"}'
req $ADMIN POST /api/admin/users/reception '{"nickname":"受付A","loginId":"recep-a","password":"recepass123"}'
req $R1 POST /api/auth/login '{"loginId":"recep-a","password":"recepass123"}'
P='"saleMode":"BOTH","discountable":false,"sortOrder":1,"tagIds":[],"trackStock":false'
req $MGR POST /api/catalog/$SA/products "{\"name\":\"焼きそば\",\"price\":400,\"cost\":150,$P}"; check "原価つき商品" 201; YAKI=$(jget "['id']")
req $MGR POST /api/catalog/$SA/products "{\"name\":\"ラムネ\",\"price\":200,$P}"; check "原価なし商品" 201; RAMUNE=$(jget "['id']")
req $MGR POST /api/catalog/$SA/products "{\"name\":\"在庫あり唐揚げ\",\"price\":300,\"cost\":100,\"saleMode\":\"BOTH\",\"discountable\":false,\"sortOrder\":3,\"tagIds\":[],\"trackStock\":true,\"stockQty\":10}"; KARA=$(jget "['id']")
req $MGRB POST /api/catalog/$SB/products "{\"name\":\"たこ焼き\",\"price\":500,$P}"; TAKO=$(jget "['id']")
req $MGR POST /api/catalog/$SA/products "{\"name\":\"不正\",\"price\":100,\"cost\":-1,$P}"; check "負の原価は400" 400
req $MGR POST /api/catalog/$SA/products "{\"name\":\"不正\",\"price\":100,\"cost\":1.5,$P}"; check "小数の原価は400" 400
req $MGRB POST /api/catalog/$SA/products "{\"name\":\"他店\",\"price\":100,\"cost\":1,$P}"; check "他店の責任者は登録できない" 403

echo "== 原価の見え方 =="
req $MGR GET /api/catalog/$SA/products; check "責任者の商品一覧" 200
expect "原価が見える" 150 "$(python3 -I -c "import json;d=json.load(open('$TMP/body'));print([p['cost'] for p in d['products'] if p['name']=='焼きそば'][0])")"
expect "未入力はnull" None "$(python3 -I -c "import json;d=json.load(open('$TMP/body'));print([p['cost'] for p in d['products'] if p['name']=='ラムネ'][0])")"
req $CLERK GET /api/pos/$SA/catalog; check "店員のレジ一覧" 200
expect "レジの一覧に原価は出ない" 0 "$(grep -c '"cost"' $TMP/body)"
req $CLERK GET /api/catalog/$SA/products; check "店員は原価つき一覧を読めない" 403
req $ADMIN GET /api/public/shops/$SA/menu; expect "お客様向けメニューに原価は出ない" 0 "$(grep -c '"cost"' $TMP/body)"
req $MGR PATCH /api/catalog/$SA/products/$RAMUNE '{"cost":50}'; check "原価をあとから入力" 200
req $MGR PATCH /api/catalog/$SA/products/$RAMUNE '{"cost":null}'; check "原価を消す" 200
expect "監査に原価が残る" 1 "$(sqlv "SELECT COUNT(*) FROM audit_logs WHERE action='product.update' AND after_json LIKE '%\"cost\":null%'")"

echo "== 購入 =="
req $ALICE POST /api/auth/register '{"email":"alice@example.com","password":"alicepass123","nickname":"アリス"}'; check "お客様登録" 201
charge $R1 $ALICE 20000; check "チャージ" 201
buy $ALICE "$(items $YAKI 2 $RAMUNE 1)"; O1=$ORDER      # 800 + 200 = 1000
buy $ALICE "$(items $YAKI 1)"; O2=$ORDER                # 400
buy $ALICE "$(items $KARA 3)"; O3=$ORDER                # 900
expect "行の原価(焼きそば×2)" 300 "$(sqlv "SELECT cost_total FROM order_lines WHERE order_id='$O1' AND name_snapshot='焼きそば'")"
expect "原価なしの行はNULL" None "$(sqlv "SELECT cost_total FROM order_lines WHERE order_id='$O1' AND name_snapshot='ラムネ'")"

echo "== 粗利 =="
req $MGR GET "/api/reports/shops/$SA/summary"; check "責任者のサマリ" 200
expect "原価入力分の売上" 2100 "$(jget "['shop']['gross']['sales']")"   # 800+400+900
expect "原価" 750 "$(jget "['shop']['gross']['cost']")"                  # 300+150+300
expect "粗利" 1350 "$(jget "['shop']['gross']['profit']")"
expect "売上の対象割合(%)" 91.3 "$(jget "['shop']['gross']['coverage']")"   # 2100 / 2300
req $MGRB GET "/api/reports/shops/$SA/summary"; check "他店の責任者は見られない" 403
req $CLERK GET "/api/reports/shops/$SA/summary"; check "店員は見られない" 403
req $ADMIN GET "/api/reports/shops/$SB/summary"; check "原価なしの店" 200
expect "原価の入力がなければ粗利はnull" None "$(jget "['shop']['gross']")"
req $ADMIN GET "/api/reports/sales"; check "管理者の売上" 200
expect "店舗別の粗利(A)" 1350 "$(python3 -I -c "import json;d=json.load(open('$TMP/body'));print([s['gross']['profit'] for s in d['shops'] if s['shopId']=='$SA'][0])")"
expect "合計の粗利" 1350 "$(jget "['totals']['gross']['profit']")"
req $MGR GET "/api/reports/shops/$SA/products"; check "商品別" 200
expect "商品別の原価(焼きそば)" 450 "$(python3 -I -c "import json;d=json.load(open('$TMP/body'));print([p['cost'] for p in d['products'] if p['name']=='焼きそば'][0])")"
expect "原価なしの商品はnull" None "$(python3 -I -c "import json;d=json.load(open('$TMP/body'));print([p['cost'] for p in d['products'] if p['name']=='ラムネ'][0])")"

echo "== 返金: 商品ごとの率 =="
line() { req $MGR GET /api/refunds/orders/$1; jget "['lines'][$2]['id']"; }
L2=$(line $O2 0)
BAL0=$(myBalance $ALICE)
pr() { # pr <orderId> <lineId> <percent> <expected> [qty]
  req $MGR POST /api/refunds/orders/$1/refund "{\"requestId\":\"$(rid)\",\"kind\":\"PARTIAL\",\"reason\":\"値引き対応\",\"expectedAmount\":$4,\"lines\":[{\"orderLineId\":\"$2\",\"quantity\":${5:-1},\"restoreStock\":true,\"percent\":$3}]}"; }
pr $O2 $L2 50 199; check "表示と違う金額は409" 409
pr $O2 $L2 50 200; check "400円の50%を返金" 201
expect "返金額" 200 "$(jget "['amount']")"
expect "残高が増える" $((BAL0+200)) "$(myBalance $ALICE)"
expect "率の返金では数量が動かない" 0 "$(sqlv "SELECT refunded_quantity FROM order_lines WHERE id='$L2'")"
expect "金額は累計される" 200 "$(sqlv "SELECT refunded_amount FROM order_lines WHERE id='$L2'")"
expect "refund_linesに率が残る" 50 "$(sqlv "SELECT percent FROM refund_lines WHERE order_line_id='$L2'")"
expect "率の返金では在庫を戻さない" 0 "$(sqlv "SELECT restore_stock FROM refund_lines WHERE order_line_id='$L2'")"
pr $O2 $L2 50 200; check "残りの50%(残額まで)" 201
expect "全額返したら数量も返金済み" 1 "$(sqlv "SELECT refunded_quantity FROM order_lines WHERE id='$L2'")"
expect "注文は全額返金済み" REFUNDED "$(sqlv "SELECT status FROM orders WHERE id='$O2'")"
pr $O2 $L2 10 40; check "返金し終えた注文は400" 400
L1R=$(line $O1 1)
req $MGR GET /api/refunds/orders/$O1; L1Y=$(jget "['lines'][0]['id']")
pr $O1 $L1R 33 66; check "200円の33%は66円(切り捨て)" 201
pr $O1 $L1R 100 134 1; check "100%は数量での返金として残り全額" 201
expect "数量での返金は残額ぴったり" 134 "$(jget "['amount']")"
req $MGR POST /api/refunds/orders/$O1/refund "{\"requestId\":\"$(rid)\",\"kind\":\"PARTIAL\",\"reason\":\"x\",\"expectedAmount\":1,\"lines\":[{\"orderLineId\":\"$L1Y\",\"quantity\":1,\"restoreStock\":true,\"percent\":0}]}"; check "率0は400" 400
req $MGR POST /api/refunds/orders/$O1/refund "{\"requestId\":\"$(rid)\",\"kind\":\"PARTIAL\",\"reason\":\"x\",\"expectedAmount\":1,\"lines\":[{\"orderLineId\":\"$L1Y\",\"quantity\":1,\"restoreStock\":true,\"percent\":101}]}"; check "率101は400" 400
req $MGRB POST /api/refunds/orders/$O1/refund "{\"requestId\":\"$(rid)\",\"kind\":\"PARTIAL\",\"reason\":\"x\",\"expectedAmount\":1,\"lines\":[{\"orderLineId\":\"$L1Y\",\"quantity\":1,\"restoreStock\":true,\"percent\":10}]}"; check "他店の責任者は返金できない" 403
req $MGR GET /api/refunds/orders/$O2; expect "履歴に率が出る" 50 "$(jget "['refunds'][0]['lines'][0]['percent']")"
req $MGR GET "/api/reports/shops/$SA/summary"
expect "返金後の粗利(返金率は値引き扱いで原価は残る)" 950 "$(jget "['shop']['gross']['profit']")"   # 売上 800+0+900 − 原価 750

echo "== 返金の検索 =="
n() { jget "['orders'].__len__()"; }
req $MGR GET "/api/refunds/shops/$SA/orders"; check "一覧" 200; expect "全件" 3 "$(n)"
req $MGR GET "/api/refunds/shops/$SA/orders?productId=$KARA"; expect "唐揚げを含む注文" 1 "$(n)"
req $MGR GET "/api/refunds/shops/$SA/orders?productId=$YAKI"; expect "焼きそばを含む注文" 2 "$(n)"
req $MGR GET "/api/refunds/shops/$SA/orders?productId=$TAKO"; expect "他店の商品では0件" 0 "$(n)"
req $MGR GET "/api/refunds/shops/$SA/orders?state=refundable"; expect "まだ返金できる注文" 2 "$(n)"
req $MGR GET "/api/refunds/shops/$SA/orders?state=refunded"; expect "返金のある注文" 2 "$(n)"
req $MGR GET "/api/refunds/shops/$SA/orders?from=$((NOW+3600000))"; expect "未来の期間は0件" 0 "$(n)"
req $MGR GET "/api/refunds/shops/$SA/orders?to=$((NOW-3600000))"; expect "過去の期間は0件" 0 "$(n)"
req $MGR GET "/api/refunds/shops/$SA/orders?from=$((NOW-3600000))&to=$((NOW+3600000))"; expect "いまを含む期間" 3 "$(n)"
expect "一覧に商品の要約" 1 "$(grep -c '焼きそば×' $TMP/body | head -1 | python3 -I -c "import sys;print(1 if int(sys.stdin.read())>0 else 0)")"
req $MGR GET "/api/refunds/shops/$SA/orders?productId=abc"; check "商品IDの形式不正は400" 400
req $MGR GET "/api/refunds/shops/$SA/orders?q=%25"; check "ワイルドカードだけの検索" 200; expect "%は文字として除かれる(空の検索は全件)" 3 "$(n)"
req $MGRB GET "/api/refunds/shops/$SA/orders?productId=$KARA"; check "他店の責任者は検索できない" 403

echo "== 注文の取消し =="
buy $ALICE "$(items $YAKI 1)"; O4=$ORDER
STOCK0=$(sqlv "SELECT stock_qty FROM products WHERE id='$KARA'")
req $CLERK GET /api/orders/$SA/recent; check "店員が最近の注文を見る" 200
expect "取消し候補に新しい注文がある" 1 "$(python3 -I -c "import json;d=json.load(open('$TMP/body'));print(1 if '$O4' in [o['orderId'] for o in d['orders']] else 0)")"
req $MGRB GET /api/orders/$SA/recent; check "他店は見られない" 403
req $ALICE GET /api/orders/$SA/recent; check "お客様は見られない" 403
cancel() { req "$1" POST /api/orders/$SA/$2/cancel "{\"requestId\":\"${4:-$(rid)}\",\"reason\":\"$3\",\"restoreStock\":${5:-false}}"; }
cancel $CLERK $O4 ""; check "理由なしは400" 400
cancel $MGRB $O4 "在庫切れ"; check "他店の責任者は取り消せない" 403
cancel $ALICE $O4 "在庫切れ"; check "お客様は取り消せない" 403
BAL1=$(myBalance $ALICE)
RID=$(rid)
cancel $CLERK $O4 "在庫がなくなった" $RID; check "店員が取り消す" 201
expect "全額が戻る" $((BAL1+400)) "$(myBalance $ALICE)"
expect "注文は全額返金済み" REFUNDED "$(sqlv "SELECT status FROM orders WHERE id='$O4'")"
expect "取消しとして記録" 1 "$(sqlv "SELECT cancel FROM refunds WHERE order_id='$O4'")"
expect "監査に取消し" 1 "$(sqlv "SELECT COUNT(*) FROM audit_logs WHERE action='order.cancel' AND target_id='$O4' AND reason='在庫がなくなった'")"
expect "操作者は店員" CLERK "$(sqlv "SELECT actor_role FROM audit_logs WHERE action='order.cancel' AND target_id='$O4'")"
cancel $CLERK $O4 "在庫がなくなった" $RID; check "同じリクエストの再送は元の結果" 200
expect "二重には戻らない" $((BAL1+400)) "$(myBalance $ALICE)"
cancel $CLERK $O4 "もう一度"; check "取消し済みは400" 400
req $MGR GET /api/refunds/orders/$O4; expect "返金の履歴に取消し" True "$(jget "['refunds'][0]['cancel']")"
cancel $CLERK $O1 "x"; check "返金のある注文は取り消せない" 400
buy $ALICE "$(items $KARA 2)"; O5=$ORDER
expect "在庫が減る" $((STOCK0-2)) "$(sqlv "SELECT stock_qty FROM products WHERE id='$KARA'")"
cancel $CLERK $O5 "在庫切れで作れない" "$(rid)" false; check "在庫を戻さず取消し" 201
expect "在庫は戻らない" $((STOCK0-2)) "$(sqlv "SELECT stock_qty FROM products WHERE id='$KARA'")"
buy $ALICE "$(items $KARA 2)"; O6=$ORDER
cancel $CLERK $O6 "注文の間違い" "$(rid)" true; check "在庫を戻して取消し" 201
expect "在庫が戻る" $((STOCK0-4+2)) "$(sqlv "SELECT stock_qty FROM products WHERE id='$KARA'")"
buy $ALICE "$(items $YAKI 1)"; O7=$ORDER
sql "INSERT INTO order_tracking (order_id, shop_id, call_no, status, created_at, updated_at) VALUES ('$O7','$SA',5,'DONE',1,1)" >/dev/null
cancel $CLERK $O7 "遅い"; check "受け渡し済みは取り消せない" 400
req $CLERK GET /api/orders/$SA/recent; expect "受け渡し済みも一覧には出る(取消しはできない)" DONE "$(python3 -I -c "import json;d=json.load(open('$TMP/body'));print([o['status'] for o in d['orders'] if o['orderId']=='$O7'][0])")"
buy $ALICE "$(items $YAKI 1)"; O8=$ORDER
sql "UPDATE orders SET paid_at = paid_at - 10800000 WHERE id='$O8'" >/dev/null
cancel $CLERK $O8 "時間がたった"; check "3時間前の注文は店員は取り消せない" 403
req $CLERK GET /api/orders/$SA/recent; expect "2時間より前は候補に出ない" 0 "$(python3 -I -c "import json;d=json.load(open('$TMP/body'));print(1 if '$O8' in [o['orderId'] for o in d['orders']] else 0)")"
cancel $MGR $O8 "お客様の申し出"; check "店舗責任者は期限なしで取り消せる" 201
buy $ALICE "$(items $YAKI 1)"; O9=$ORDER
cancel $ADMIN $O9 "管理者の取消し"; check "全体管理者も取り消せる" 201
req $MGR GET "/api/reports/shops/$SA/summary"
expect "取消しは粗利から外れる(売上も原価も0)" 3 "$(python3 -I -c "
import json;d=json.load(open('$TMP/body'));g=d['shop']['gross'];print(3 if g['cost']>=0 else 0)")"
expect "取り消した唐揚げの原価は戻る" 0 "$(sqlv "SELECT COUNT(*) FROM order_lines WHERE order_id='$O6' AND cost_total IS NULL")"

echo "== 監査ログの検索 =="
req $MGR GET "/api/reports/audit"; check "責任者は監査ログを読めない" 403
req $ADMIN GET "/api/reports/audit?limit=101"; check "101件は400" 400
req $ADMIN GET "/api/reports/audit?limit=0"; check "0件は400" 400
req $ADMIN GET "/api/reports/audit?cursor=abc"; check "不正なカーソルは400" 400
req $ADMIN GET "/api/reports/audit?role=HACKER"; check "不明な役割は400" 400
req $ADMIN GET "/api/reports/audit?category=nope"; check "不明な種類は400" 400
req $ADMIN GET "/api/reports/audit?limit=100"; check "100件まで読める" 200
req $ADMIN GET "/api/reports/audit"; expect "既定は50件まで" 1 "$(python3 -I -c "import json;print(1 if len(json.load(open('$TMP/body'))['entries'])<=50 else 0)")"
req $ADMIN GET "/api/reports/audit?limit=3"; check "3件" 200
expect "3件だけ返る" 3 "$(jget "['entries'].__len__()")"
C=$(jget "['next']"); FIRST=$(jget "['entries'][0]['id']"); IDS1=$(python3 -I -c "import json;print(' '.join(e['id'] for e in json.load(open('$TMP/body'))['entries']))")
req $ADMIN GET "/api/reports/audit?limit=3&cursor=$C"; check "続き" 200
IDS2=$(python3 -I -c "import json;print(' '.join(e['id'] for e in json.load(open('$TMP/body'))['entries']))")
expect "続きは重ならない" 0 "$(python3 -I -c "print(len(set('$IDS1'.split())&set('$IDS2'.split())))")"
req $ADMIN GET "/api/reports/audit?limit=100&order=asc"; check "古い順" 200
expect "古い順は時刻が昇順" 1 "$(python3 -I -c "
import json;e=json.load(open('$TMP/body'))['entries'];print(1 if all(e[i]['createdAt']<=e[i+1]['createdAt'] for i in range(len(e)-1)) else 0)")"
req $ADMIN GET "/api/reports/audit?limit=100&order=desc"
expect "新しい順は時刻が降順" 1 "$(python3 -I -c "
import json;e=json.load(open('$TMP/body'))['entries'];print(1 if all(e[i]['createdAt']>=e[i+1]['createdAt'] for i in range(len(e)-1)) else 0)")"
req $ADMIN GET "/api/reports/audit?limit=100&category=refund"; check "返金・取消しの種類" 200
expect "返金と取消しだけ" 1 "$(python3 -I -c "
import json;e=json.load(open('$TMP/body'))['entries'];print(1 if e and all(x['action'].startswith(('refund.','order.cancel')) for x in e) else 0)")"
expect "取消しが含まれる" 1 "$(python3 -I -c "
import json;e=json.load(open('$TMP/body'))['entries'];print(1 if any(x['action']=='order.cancel' for x in e) else 0)")"
req $ADMIN GET "/api/reports/audit?limit=100&role=CLERK"; check "店員の操作" 200
expect "店員だけ" 1 "$(python3 -I -c "
import json;e=json.load(open('$TMP/body'))['entries'];print(1 if e and all(x['actorRole']=='CLERK' for x in e) else 0)")"
req $ADMIN GET "/api/reports/audit?limit=100&shopId=$SB"; check "店舗Bの記録" 200
expect "店舗Bの記録は店舗名つき" 1 "$(python3 -I -c "
import json;e=json.load(open('$TMP/body'))['entries'];print(1 if e and all(x['shopName']=='2B たこ焼き' for x in e) else 0)")"
expect "店舗Bに店舗Aの記録は混ざらない" 0 "$(python3 -I -c "
import json;e=json.load(open('$TMP/body'))['entries'];print(sum(1 for x in e if x['action']=='order.cancel'))")"
req $ADMIN GET "/api/reports/audit?limit=100&shopId=$SA&category=refund"; expect "店舗A×返金の組み合わせ" 1 "$(python3 -I -c "
import json;e=json.load(open('$TMP/body'))['entries'];print(1 if len(e)>=5 and all(x['shopName']=='2A 焼きそば' for x in e) else 0)")"
req $ADMIN GET "/api/reports/audit?limit=100&from=$((NOW+3600000))"; expect "未来の期間は0件" 0 "$(jget "['entries'].__len__()")"
req $ADMIN GET "/api/reports/audit?limit=100&from=$((NOW-3600000))&to=$((NOW+7200000))"; expect "いまを含む期間" 1 "$(python3 -I -c "import json;print(1 if json.load(open('$TMP/body'))['entries'] else 0)")"
req $ADMIN GET "/api/reports/audit?limit=100&action=order.cancel"; expect "操作名の先頭一致" 1 "$(python3 -I -c "
import json;e=json.load(open('$TMP/body'))['entries'];print(1 if e and all(x['action']=='order.cancel' for x in e) else 0)")"
req $ADMIN GET "/api/reports/audit?limit=100&action=%25"; check "ワイルドカードは無効化される" 200
req $ADMIN GET "/api/reports/audit?limit=100&q=$O4"; expect "対象IDで検索" 1 "$(python3 -I -c "
import json;e=json.load(open('$TMP/body'))['entries'];print(1 if e and all(x['targetId']=='$O4' for x in e) else 0)")"
req $ADMIN GET "/api/reports/audit?limit=100&q=%27%20OR%201%3D1%20--"; check "SQLを混ぜた検索語でも安全" 200
expect "それで全件は返らない" 0 "$(jget "['entries'].__len__()")"
req $ADMIN GET "/api/reports/audit.csv?category=refund"; check "CSV" 200
expect "CSVの先頭行に店舗の列" 1 "$(head -c 300 $TMP/body | grep -c '店舗')"
req $MGR GET "/api/reports/audit.csv"; check "責任者はCSVも不可" 403
expect "店舗の列が書き込み時に入る" 0 "$(sqlv "SELECT COUNT(*) FROM audit_logs WHERE action IN ('product.create','order.cancel','refund.partial') AND shop_id IS NULL")"

echo
echo "結果: pass=$pass fail=$fail"
[ "$fail" = 0 ]
