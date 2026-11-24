#!/usr/bin/env bash
# 店舗名の変更(店舗責任者・全体管理者)と、過去のログとの一貫性のスモークテスト。
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
req $ADMIN POST /api/auth/login '{"loginId":"admin","password":"adminpass1"}'
req $ADMIN POST /api/admin/shops '{"name":"3A 焼きそば","displayName":"3A 焼きそば"}'; SA=$(jget "['shop']['id']")
req $ADMIN POST /api/admin/shops '{"name":"3B たこ焼き","displayName":"3B たこ焼き"}'; SB=$(jget "['shop']['id']")
req $ADMIN POST /api/admin/users/shop-manager "{\"shopId\":\"$SA\",\"loginId\":\"mgr-a\",\"password\":\"mgrpass123\",\"nickname\":\"A責任者\"}"
req $ADMIN POST /api/admin/users/shop-manager "{\"shopId\":\"$SB\",\"loginId\":\"mgr-b\",\"password\":\"mgrpass123\",\"nickname\":\"B責任者\"}"
req $MGR POST /api/auth/login '{"loginId":"mgr-a","password":"mgrpass123"}'
req $MGRB POST /api/auth/login '{"loginId":"mgr-b","password":"mgrpass123"}'
req $MGR POST /api/shops/$SA/staff '{"loginId":"clerk-a","password":"clerkpass1","nickname":"A店員"}'
req $CLERK POST /api/auth/login '{"loginId":"clerk-a","password":"clerkpass1"}'
req $ADMIN POST /api/admin/users/reception '{"nickname":"受付A","loginId":"recep-a","password":"recepass123"}'
req $R1 POST /api/auth/login '{"loginId":"recep-a","password":"recepass123"}'
P='"saleMode":"BOTH","discountable":false,"sortOrder":1,"tagIds":[],"trackStock":false'
req $MGR POST /api/catalog/$SA/products "{\"name\":\"焼きそば\",\"price\":400,$P}"; YAKI=$(jget "['id']")
req $ALICE POST /api/auth/register '{"email":"alice@example.com","password":"alicepass123","nickname":"アリス"}'; check "お客様登録(アリス)" 201
req $BOB POST /api/auth/register '{"email":"bob@example.com","password":"bobpass12345","nickname":"ボブ"}'; check "お客様登録(ボブ)" 201
charge $R1 $ALICE 20000; check "チャージ(アリス)" 201
charge $R1 $BOB 20000; check "チャージ(ボブ)" 201
scanTag() { # scanTag <customerJar> <tagNo or ""> [qr]
  QR=${3:-$(newQr "$1")}
  local tg=""; [ -n "$2" ] && tg=",\"tag\":\"$2\""
  req $CLERK POST /api/pos/$SA/pay/scan "{\"token\":\"$QR\",\"items\":$(items $YAKI 1)$tg}"; }
commit() { local s; s=$(jget "['sessionId']"); local t; t=$(jget "['quote']['total']")
  req $CLERK POST /api/pos/$SA/pay/$s/commit "{\"requestId\":\"$(rid)\",\"expectedTotal\":$t}"; ORDER=$(jget "['orderId']"); CALLNO=$(jget "['callNo']"); }
status() { req $CLERK POST /api/orders/$SA/$1/status "{\"status\":\"$2\"}"; }


echo "== 変更前の記録 =="
req $MGR PUT /api/shops/$SA/options '{"orderTracking":false,"callBoard":false}'; check "設定変更(監査に残る)" 200
scanTag $ALICE ""; check "決済" 200; commit; check "確定" 200; O1=$ORDER
T1=$(sqlv "SELECT paid_at FROM orders WHERE id='$O1'")
req $ALICE GET /api/wallet/history; expect "履歴の店名(変更前)" "3A 焼きそば" "$(jget "['items'][0]['shopName']")"
expect "履歴(初期)の件数" 1 "$(sqlv "SELECT COUNT(*) FROM shop_name_history WHERE shop_id='$SA'")"
sleep 1

echo "== 権限 =="
rn() { req "$1" POST /api/shops/$2/rename "{\"displayName\":\"$3\"}"; }
rn $CLERK $SA "店員が変更"; check "店員は不可" 403
rn $ALICE $SA "客が変更"; check "お客様は不可" 403
rn $ANON $SA "匿名"; check "未ログインは401" 401
rn $MGRB $SA "他店の責任者"; check "他店の責任者は不可" 403
req $MGR GET /api/shops/$SB/name; check "他店の名前の履歴は見られない" 403
rn $MGR $SA ""; check "空は400" 400
rn $MGR $SA "   "; check "空白だけは400" 400
rn $MGR $SA "$(python3 -I -c "print('あ'*51)")"; check "51文字は400" 400
rn $MGR $SA "3B たこ焼き"; check "ほかの店と同じ名前は409" 409
expect "理由" SHOP_NAME_TAKEN "$(jget "['error']['code']")"
rn $MGR $SA "3A 焼きそば"; check "同じ名前なら何もしない" 200
expect "変更なし" False "$(jget "['changed']")"
expect "履歴は増えない" 1 "$(sqlv "SELECT COUNT(*) FROM shop_name_history WHERE shop_id='$SA'")"

echo "== 店舗責任者が変更 =="
rn $MGR $SA "3A やきそば屋"; check "自店舗を変更" 200
expect "変更あり" True "$(jget "['changed']")"
req $MGR GET /api/auth/me; expect "自分の所属店舗名が新しくなる" "3A やきそば屋" "$(jget "['user']['shopName']")"
req $ANON GET /api/public/shops; expect "お客様向けの店舗一覧も新しい名前" 1 "$(python3 -I -c "import json;d=json.load(open('$TMP/body'));print(sum(1 for s in d['shops'] if s['name']=='3A やきそば屋'))")"
req $CLERK GET /api/pos/$SA/catalog; expect "レジの店名" "3A やきそば屋" "$(jget "['shopName']")"
expect "name と displayName が同期" "3A やきそば屋" "$(sqlv "SELECT name FROM shops WHERE id='$SA'")"
req $MGR GET /api/shops/$SA/name; expect "現在の名前" "3A やきそば屋" "$(jget "['displayName']")"
expect "履歴は2件" 2 "$(jget "['history'].__len__()")"
expect "新しい順(先頭が今の名前)" "3A やきそば屋" "$(jget "['history'][0]['displayName']")"
expect "最初の名前" "3A 焼きそば" "$(jget "['history'][1]['displayName']")"
expect "変更した人" "A責任者" "$(jget "['history'][0]['changedBy']")"
expect "監査ログ" 1 "$(sqlv "SELECT COUNT(*) FROM audit_logs WHERE action='shop.rename' AND target_id='$SA'")"
expect "監査のbefore" '{"displayName":"3A 焼きそば"}' "$(sqlv "SELECT before_json FROM audit_logs WHERE action='shop.rename' AND target_id='$SA'")"
expect "監査の店舗は対象店舗" "$SA" "$(sqlv "SELECT shop_id FROM audit_logs WHERE action='shop.rename' AND target_id='$SA'")"
sleep 1
scanTag $BOB ""; check "変更後の決済" 200; commit; O2=$ORDER

echo "== 過去のログとの一貫性 =="
req $ALICE GET /api/wallet/history; expect "変更前の支払いは、当時の店名" "3A 焼きそば" "$(jget "['items'][0]['shopName']")"
req $BOB GET /api/wallet/history; expect "変更後の支払いは、新しい店名" "3A やきそば屋" "$(jget "['items'][0]['shopName']")"
req $ADMIN GET "/api/reports/audit?limit=100"
expect "変更前の監査: 当時の名前" "3A 焼きそば" "$(python3 -I -c "
import json;d=json.load(open('$TMP/body'))
e=[x for x in d['entries'] if x['action']=='shop.options'][0]
print(e['shopName'])")"
expect "変更前の監査: 現在の名前も付く" "3A やきそば屋" "$(python3 -I -c "
import json;d=json.load(open('$TMP/body'))
e=[x for x in d['entries'] if x['action']=='shop.options'][0]
print(e.get('currentShopName'))")"
expect "変更後の監査(支払い)は新しい名前" "3A やきそば屋" "$(python3 -I -c "
import json;d=json.load(open('$TMP/body'))
e=[x for x in d['entries'] if x['action'].startswith('payment.')][0]
print(e['shopName'])")"
expect "変更後の監査は現在の名前を重ねて出さない" None "$(python3 -I -c "
import json;d=json.load(open('$TMP/body'))
e=[x for x in d['entries'] if x['action'].startswith('payment.')][0]
print(e.get('currentShopName'))")"
req $ADMIN GET "/api/reports/audit?shopId=$SA&limit=100"; expect "店舗IDでの絞り込みは名前が変わっても同じ店舗" True "$(python3 -I -c "
import json;d=json.load(open('$TMP/body'))
print(len(d['entries'])>=4)")"
req $ADMIN GET "/api/reports/audit.csv?shopId=$SA"; expect "CSVにも当時の名前と現在の名前" 1 "$(python3 -I -c "
t=open('$TMP/body',encoding='utf-8').read()
print(1 if '3A 焼きそば(現在の店舗名: 3A やきそば屋)' in t else 0)")"
expect "注文は店舗IDで結びついたまま" "$SA" "$(sqlv "SELECT shop_id FROM orders WHERE id='$O1'")"
req $ADMIN GET "/api/reports/sales"; check "全体の売上は現在の名前で集計" 200
expect "売上の店名" 1 "$(python3 -I -c "
import json;d=json.load(open('$TMP/body'))
print(sum(1 for s in d['shops'] if s['name']=='3A やきそば屋'))")"

echo "== 全体管理者が変更 =="
rn $ADMIN $SA "3A 焼きそば本店"; check "全体管理者は任意の店舗を変更できる" 200
rn $ADMIN $SB "3B たこ焼き本店"; check "他店も変更できる" 200
rn $ADMIN $SB "3A 焼きそば本店"; check "全体管理者でも重複は409" 409
req $ADMIN PATCH /api/admin/shops/$SB '{"displayName":"3B たこ焼き専門"}'; check "既存の管理者用の変更でも" 200
req $ADMIN GET /api/shops/$SB/name; expect "履歴に載る(最初+2回)" 3 "$(jget "['history'].__len__()")"
expect "管理者の変更は管理者名" "運営" "$(jget "['history'][0]['changedBy']")"
req $ADMIN PATCH /api/admin/shops/$SB '{"sortOrder":5}'; check "名前を変えない更新" 200
req $ADMIN GET /api/shops/$SB/name; expect "履歴は増えない" 3 "$(jget "['history'].__len__()")"
req $ADMIN POST /api/admin/shops '{"name":"3C 新店","displayName":"3C 新店"}'; SC=$(jget "['shop']['id']")
expect "新しい店舗も履歴の起点がある" 1 "$(sqlv "SELECT COUNT(*) FROM shop_name_history WHERE shop_id='$SC'")"
expect "履歴は追記専用(更新できない)" 1 "$(sql "UPDATE shop_name_history SET display_name='x' WHERE shop_id='$SC'" >/dev/null 2>&1; sqlv "SELECT COUNT(*) FROM shop_name_history WHERE shop_id='$SC' AND display_name='3C 新店'")"
expect "履歴は追記専用(削除できない)" 1 "$(sql "DELETE FROM shop_name_history WHERE shop_id='$SC'" >/dev/null 2>&1; sqlv "SELECT COUNT(*) FROM shop_name_history WHERE shop_id='$SC'")"
# 古い名前を新しい店舗が使っても、IDが違うので履歴・ログは混ざらない
rn $ADMIN $SC "3A 焼きそば"; check "元の名前(今は誰も使っていない)を別の店舗が使える" 200
req $ADMIN GET "/api/reports/audit?shopId=$SA&limit=100"; expect "元の名前を別店舗が使っても、SAのログはSAのまま" 0 "$(python3 -I -c "
import json;d=json.load(open('$TMP/body'))
print(sum(1 for x in d['entries'] if x['targetId']=='$SC'))")"

echo
echo "結果: pass=$pass fail=$fail"
[ "$fail" = 0 ]
