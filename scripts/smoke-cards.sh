#!/usr/bin/env bash
# festival-qr-pos セット商品(登録・内訳の選択・追加料金・在庫連動・値下げ・返金)のスモークテスト。
#
# 前提: ローカルで `vite preview --port 4173` が動いていて、DBが空(migration 適用直後)であること。
# 使い方: bash scripts/smoke-cards.sh
#
# 確認すること: 発行(一括・QRはハッシュだけ保存)と権限、有効化(PIN・ウォレット)、カード決済のPIN確認(違えば確定しない・
#   QRは消費しない)、受付のチャージ・PIN必須の払戻し、一時停止・期限切れ・削除での拒否(読み取り後の停止も確定時に拒否)、
#   QR再生成(旧QRの永久失効)、削除と再発行(残高の引き継ぎ)、残高と台帳の整合、監査ログ。
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

ptotal() { jget "['quote']['total']"; }
scan() { # scan <clerkJar> <token> <itemsJson>
  req "$1" POST /api/pos/$SA/pay/scan "{\"token\":\"$2\",\"items\":$3}"
}
commit() { # commit <jar> <session> <requestId> <expectedTotal>
  req "$1" POST /api/pos/$SA/pay/$2/commit "{\"requestId\":\"$3\",\"expectedTotal\":$4}"
}
items() { python3 -I -c "
import json,sys
a=sys.argv[1:]
print(json.dumps([{'productId':a[i],'quantity':int(a[i+1])} for i in range(0,len(a),2)]))" "$@"; }
dbq() { sqlv "$1"; }

ADMIN=$TMP/admin.jar; MGR=$TMP/mgr.jar; CLERK=$TMP/clerk.jar; R1=$TMP/r1.jar; ANON=$TMP/anon.jar

echo "== 準備 =="
curl -s -o "$TMP/body" -w '%{http_code}' -X POST -H "Origin: $BASE" -H 'content-type: application/json' -H "x-setup-token: $SETUP_TOKEN" -c $ADMIN \
  --data '{"loginId":"admin","password":"adminpass1","nickname":"運営"}' $BASE/api/setup/admin > "$TMP/code"
if [ "$(code)" != "201" ]; then req $ADMIN POST /api/auth/login '{"loginId":"admin","password":"adminpass1"}'; fi
req $ADMIN POST /api/admin/shops '{"name":"2A 焼きそば","displayName":"2A 焼きそば"}'; check "店舗" 201; SA=$(jget "['shop']['id']")
req $ADMIN POST /api/admin/users/shop-manager "{\"shopId\":\"$SA\",\"loginId\":\"mgr-a\",\"password\":\"mgrpass123\",\"nickname\":\"責任者\"}"; check "責任者" 201
req $MGR POST /api/auth/login '{"loginId":"mgr-a","password":"mgrpass123"}'; check "責任者ログイン" 200
req $MGR POST /api/shops/$SA/staff '{"loginId":"clerk-a","password":"clerkpass1","nickname":"店員"}'; check "店員登録" 201
req $CLERK POST /api/auth/login '{"loginId":"clerk-a","password":"clerkpass1"}'; check "店員ログイン" 200
req $MGR POST /api/catalog/$SA/products '{"name":"焼きそば","price":300,"saleMode":"BOTH","discountable":true,"sortOrder":1,"tagIds":[],"trackStock":true,"stockQty":20}'; YAKI=$(jget "['id']")
req $ADMIN POST /api/admin/users/reception '{"nickname":"受付A"}'; check "受付A" 201; RA_TOK=$(jget "['token']")
req $R1 POST /api/auth/qr-login "{\"token\":\"$RA_TOK\"}"; check "受付ログイン" 200
PAST=$(( $(date +%s) * 1000 - 1000 ))
FAR=$(( $(date +%s) * 1000 + 200 * 86400000 ))

echo "== 発行 =="
req $ADMIN POST /api/cards/issue '{"count":0}'; check "0枚は400" 400
req $ADMIN POST /api/cards/issue '{"count":101}'; check "101枚は400" 400
req $ADMIN POST /api/cards/issue "{\"count\":1,\"expiresAt\":$PAST}"; check "過去の期限は400" 400
req $ADMIN POST /api/cards/issue "{\"count\":1,\"expiresAt\":$FAR}"; check "6か月を超える期限は400" 400
req $MGR POST /api/cards/issue '{"count":1}'; check "店舗責任者は発行できない" 403
req $CLERK POST /api/cards/issue '{"count":1}'; check "店員は発行できない" 403
req $R1 POST /api/cards/issue '{"count":1}'; check "受付は発行できない" 403
req $ANON POST /api/cards/issue '{"count":1}'; check "未ログインは401" 401
req $ADMIN POST /api/cards/issue '{"count":6,"batch":"A組","memo":"テスト"}'; check "6枚を一括発行" 201
expect "枚数" 6 "$(jget "['cards'].__len__()")"
C1=$(jget "['cards'][0]['id']"); T1=$(jget "['cards'][0]['token']"); N1=$(jget "['cards'][0]['displayNo']")
C2=$(jget "['cards'][1]['id']"); T2=$(jget "['cards'][1]['token']")
C3=$(jget "['cards'][2]['id']"); T3=$(jget "['cards'][2]['token']")
C4=$(jget "['cards'][3]['id']"); T4=$(jget "['cards'][3]['token']")
C5=$(jget "['cards'][4]['id']"); T5=$(jget "['cards'][4]['token']")
C6=$(jget "['cards'][5]['id']")
expect "カード番号は連番" "C000001/C000006" "$N1/$(jget "['cards'][5]['displayNo']")"
expect "QRの形式" 1 "$(python3 -I -c "import re,sys;print(1 if re.fullmatch(r'FES1:C:[A-Za-z0-9_-]{32}',sys.argv[1]) else 0)" "$T1")"
expect "QRトークンは平文で保存されない" 0 "$(dbq "SELECT count(*) FROM cards WHERE qr_token_hash='$T1'")"
expect "トークンの墓標" 6 "$(dbq "SELECT count(*) FROM token_tombstones WHERE kind='CARD_QR'")"
expect "発行直後はニックネーム・PIN・ウォレットなし" "ISSUED/None/None/None" "$(dbq "SELECT status||'/'||COALESCE(nickname,'None')||'/'||COALESCE(pin_hash,'None')||'/'||COALESCE(wallet_id,'None') FROM cards WHERE id='$C1'")"
expect "発行バッチ" "A組" "$(dbq "SELECT issue_batch FROM cards WHERE id='$C1'")"
req $ADMIN POST /api/cards/issue '{"count":1}'; check "続けて発行" 201; expect "番号は続く" C000007 "$(jget "['cards'][0]['displayNo']")"

echo "== 一覧・読み取り =="
req $ADMIN GET "/api/cards?status=ISSUED"; check "未有効化の一覧" 200; expect "件数" 7 "$(jget "['cards'].__len__()")"
req $ADMIN GET "/api/cards?q=A%E7%B5%84"; expect "発行バッチで検索" 6 "$(jget "['cards'].__len__()")"
req $ADMIN GET "/api/cards?q=C000003"; expect "カード番号で検索" 1 "$(jget "['cards'].__len__()")"
req $MGR GET /api/cards; check "責任者は一覧を見られない" 403
req $ADMIN POST /api/cards/scan "{\"token\":\"$T1\"}"; check "カードを読み取る" 200; expect "未有効化" ISSUED "$(jget "['card']['status']")"
req $ADMIN POST /api/cards/scan '{"token":"FES1:C:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'; check "未登録のQRは404" 404
req $ADMIN POST /api/cards/scan '{"token":"FES1:U:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'; check "カード以外のQRは400" 400

echo "== 有効化前は使えない =="
scan $CLERK "$T1" "$(items $YAKI 1)"; check "レジ: 未有効化カードは決済できない" 403; expect "コード" CARD_INACTIVE "$(jget "['error']['code']")"
lookup $R1 "$T1"; check "受付: 未有効化カードはチャージできない" 403

echo "== 有効化 =="
req $ADMIN POST /api/cards/$C1/activate '{"nickname":"","pin":"1234"}'; check "ニックネームなしは400" 400
req $ADMIN POST /api/cards/$C1/activate '{"nickname":"たろう","pin":"12a4"}'; check "PINが数字4桁でないと400" 400
req $ADMIN POST /api/cards/$C1/activate '{"nickname":"たろう","pin":"123"}'; check "PINが3桁は400" 400
req $MGR POST /api/cards/$C1/activate '{"nickname":"たろう","pin":"1234"}'; check "責任者は有効化できない" 403
req $ADMIN POST /api/cards/$C1/activate '{"nickname":"たろう","pin":"1234"}'; check "有効化" 201
expect "状態" ACTIVE "$(jget "['card']['status']")"; expect "残高0" 0 "$(jget "['card']['balance']")"
expect "ウォレットは持ち主なし" "NULL" "$(dbq "SELECT COALESCE(owner_user_id,'NULL') FROM wallets WHERE id=(SELECT wallet_id FROM cards WHERE id='$C1')")"
expect "PINは平文で保存されない" 0 "$(dbq "SELECT count(*) FROM cards WHERE id='$C1' AND pin_hash LIKE '%1234%'")"
expect "PINはハッシュ形式" 1 "$(dbq "SELECT count(*) FROM cards WHERE id='$C1' AND pin_hash LIKE 'pin1\$%'")"
expect "ウォレットの期限はカードと同じ" "$(dbq "SELECT expires_at FROM cards WHERE id='$C1'")" "$(dbq "SELECT expires_at FROM wallets WHERE id=(SELECT wallet_id FROM cards WHERE id='$C1')")"
req $ADMIN POST /api/cards/$C1/activate '{"nickname":"じろう","pin":"1111"}'; check "有効化済みは再度有効化できない" 409
req $ADMIN POST /api/cards/$C2/activate '{"nickname":"たろう","pin":"2222"}'; check "同名の利用者(2枚目)も有効化できる" 201
req $ADMIN GET "/api/cards?q=%E3%81%9F%E3%82%8D%E3%81%86"; expect "同名は番号で見分ける" "C000001,C000002" "$(python3 -I -c "import json;d=json.load(open('$TMP/body'));print(','.join(sorted(c['displayNo'] for c in d['cards'])))")"
req $ADMIN POST /api/cards/scan "{\"token\":\"$T1\"}"; expect "読み取りで有効と分かる" ACTIVE "$(jget "['card']['status']")"
req $ADMIN POST /api/cards/$C1/regenerate '{}'; check "有効化済みはQRを作り直せない" 409

echo "== 受付: チャージ・払戻し(PIN) =="
lookup $R1 "$T1"; check "カードを読み取る" 200; L=$(jget "['lookupId']")
expect "カード番号が返る" "$N1" "$(jget "['card']['displayNo']")"; expect "ニックネーム" たろう "$(jget "['wallet']['nickname']")"
req $R1 POST /api/reception/charge "{\"lookupId\":\"$L\",\"requestId\":\"$(rid)\",\"cashAmount\":2000}"; check "カードへチャージ" 201; expect "残高" 2000 "$(jget "['balanceAfter']")"
lookup $R1 "$T1"; check "カードQRは何度でも読み取れる(消費しない)" 200; L2=$(jget "['lookupId']")
RQ=$(rid)
req $R1 POST /api/reception/payout "{\"lookupId\":\"$L2\",\"requestId\":\"$RQ\",\"expectedBalance\":2000}"; check "PINなしの払戻しは400" 400; expect "コード" PIN_REQUIRED "$(jget "['error']['code']")"
req $R1 POST /api/reception/payout "{\"lookupId\":\"$L2\",\"requestId\":\"$RQ\",\"expectedBalance\":2000,\"pin\":\"9999\"}"; check "PINが違う払戻しは403" 403; expect "コード" PIN_INVALID "$(jget "['error']['code']")"
expect "残高は変わらない" 2000 "$(dbq "SELECT balance FROM wallets WHERE id=(SELECT wallet_id FROM cards WHERE id='$C1')")"
expect "PIN失敗の監査ログ" 1 "$(dbq "SELECT count(*) FROM audit_logs WHERE action='cash.payout_pin_failed'")"

echo "== レジ: カード決済(PIN) =="
scan $CLERK "$T1" "$(items $YAKI 2)"; check "カードを読み取る" 200; S1=$(jget "['sessionId']")
expect "合計" 600 "$(ptotal)"; expect "お客様名" たろう "$(jget "['customer']['nickname']")"; expect "カード番号" "$N1" "$(jget "['card']['displayNo']")"
RQ1=$(rid)
commit $CLERK $S1 $RQ1 600; check "PINなしでは確定できない" 400; expect "コード" PIN_REQUIRED "$(jget "['error']['code']")"
req $CLERK POST /api/pos/$SA/pay/$S1/commit "{\"requestId\":\"$RQ1\",\"expectedTotal\":600,\"pin\":\"0000\"}"; check "PINが違うと確定できない" 403; expect "コード" PIN_INVALID "$(jget "['error']['code']")"
expect "残高・在庫は変わらない" "2000/20" "$(dbq "SELECT balance FROM wallets WHERE id=(SELECT wallet_id FROM cards WHERE id='$C1')")/$(dbq "SELECT stock_qty FROM products WHERE id='$YAKI'")"
req $CLERK POST /api/pos/$SA/pay/$S1/commit "{\"requestId\":\"$RQ1\",\"expectedTotal\":600,\"pin\":\"12345\"}"; check "5桁のPINは400" 400
req $CLERK GET /api/pos/$SA/pay/$S1; expect "PINを間違えてもセッションは続く" COMMITTED_NOT "$([ "$(jget "['status']")" = "COMMITTED" ] && echo COMMITTED || echo COMMITTED_NOT)"
req $CLERK POST /api/pos/$SA/pay/$S1/commit "{\"requestId\":\"$RQ1\",\"expectedTotal\":600,\"pin\":\"1234\"}"; check "正しいPINで確定" 200; O1=$(jget "['orderId']")
expect "残高" 1400 "$(dbq "SELECT balance FROM wallets WHERE id=(SELECT wallet_id FROM cards WHERE id='$C1')")"
expect "注文は CARD・カードID付き" "CARD/$C1" "$(dbq "SELECT pay_source||'/'||card_id FROM orders WHERE id='$O1'")"
expect "在庫" 18 "$(dbq "SELECT stock_qty FROM products WHERE id='$YAKI'")"
req $CLERK POST /api/pos/$SA/pay/$S1/commit "{\"requestId\":\"$RQ1\",\"expectedTotal\":600}"; check "同じリクエストの再送は元の結果" 200; expect "再送" True "$(jget "['replayed']")"
expect "二重に引かれない" 1400 "$(dbq "SELECT balance FROM wallets WHERE id=(SELECT wallet_id FROM cards WHERE id='$C1')")"
scan $CLERK "$T1" "$(items $YAKI 1)"; check "カードQRは決済後も使える(消費しない)" 200; S2=$(jget "['sessionId']")
req $CLERK POST /api/pos/$SA/pay/$S2/cancel '{}'; check "取消" 200
req $CLERK POST /api/pos/$SA/pay/$S1/commit "{\"requestId\":\"$(rid)\",\"expectedTotal\":600,\"pin\":\"1234\"}"; check "確定済みのセッションで別IDは409" 409
# 残高不足
scan $CLERK "$T1" "$(items $YAKI 6)"; S3=$(jget "['sessionId']")
req $CLERK POST /api/pos/$SA/pay/$S3/commit "{\"requestId\":\"$(rid)\",\"expectedTotal\":1800,\"pin\":\"1234\"}"; check "残高不足(1400 < 1800)" 409; expect "コード" INSUFFICIENT_BALANCE "$(jget "['error']['code']")"
req $CLERK POST /api/pos/$SA/pay/$S3/cancel '{}'

echo "== 一時停止 =="
scan $CLERK "$T1" "$(items $YAKI 1)"; S4=$(jget "['sessionId']")
req $MGR POST /api/cards/$C1/suspend '{"reason":"紛失"}'; check "責任者は停止できない" 403
req $ADMIN POST /api/cards/$C1/suspend '{"reason":""}'; check "理由は必須" 400
req $ADMIN POST /api/cards/$C1/suspend '{"reason":"紛失の報告"}'; check "一時停止" 200
req $CLERK POST /api/pos/$SA/pay/$S4/commit "{\"requestId\":\"$(rid)\",\"expectedTotal\":300,\"pin\":\"1234\"}"; check "読み取り後に停止されたカードは確定できない" 403; expect "コード" CARD_INACTIVE "$(jget "['error']['code']")"
expect "残高は変わらない" 1400 "$(dbq "SELECT balance FROM wallets WHERE id=(SELECT wallet_id FROM cards WHERE id='$C1')")"
scan $CLERK "$T1" "$(items $YAKI 1)"; check "停止中はレジで読み取れない" 403
lookup $R1 "$T1"; check "停止中は受付で読み取れない" 403
req $R1 POST /api/reception/charge "{\"lookupId\":\"$L2\",\"requestId\":\"$(rid)\",\"cashAmount\":500}"; check "読み取り後に停止されたカードへチャージできない" 409; expect "コード" WALLET_INACTIVE "$(jget "['error']['code']")"
req $ADMIN POST /api/cards/$C1/suspend '{"reason":"二重"}'; check "停止中は再停止できない" 409
req $ADMIN GET "/api/cards?status=SUSPENDED"; expect "停止中の一覧" 1 "$(jget "['cards'].__len__()")"; expect "停止の理由" 紛失の報告 "$(jget "['cards'][0]['suspendReason']")"
req $ADMIN POST /api/cards/$C1/resume '{"reason":"見つかった"}'; check "再開" 200
scan $CLERK "$T1" "$(items $YAKI 1)"; check "再開後は使える" 200; req $CLERK POST /api/pos/$SA/pay/$(jget "['sessionId']")/cancel '{}'

echo "== PINの再設定 =="
req $ADMIN POST /api/cards/$C1/reset-pin '{"pin":"abcd"}'; check "数字以外は400" 400
req $ADMIN POST /api/cards/$C1/reset-pin '{"pin":"4321"}'; check "PIN再設定" 200
scan $CLERK "$T1" "$(items $YAKI 1)"; S5=$(jget "['sessionId']")
req $CLERK POST /api/pos/$SA/pay/$S5/commit "{\"requestId\":\"$(rid)\",\"expectedTotal\":300,\"pin\":\"1234\"}"; check "旧PINは使えない" 403
req $CLERK POST /api/pos/$SA/pay/$S5/commit "{\"requestId\":\"$(rid)\",\"expectedTotal\":300,\"pin\":\"4321\"}"; check "新PINで決済" 200; O2=$(jget "['orderId']")
expect "残高" 1100 "$(dbq "SELECT balance FROM wallets WHERE id=(SELECT wallet_id FROM cards WHERE id='$C1')")"

echo "== 払戻し(PIN) =="
lookup $R1 "$T1"; L3=$(jget "['lookupId']")
req $R1 POST /api/reception/payout "{\"lookupId\":\"$L3\",\"requestId\":\"$(rid)\",\"expectedBalance\":1100,\"pin\":\"4321\"}"; check "正しいPINで払戻し" 201; expect "払戻し後の残高" 0 "$(jget "['balanceAfter']")"
expect "現金台帳の払戻し" 1 "$(dbq "SELECT count(*) FROM cash_events WHERE kind='PAYOUT'")"

echo "== 返金(カード決済の注文) =="
req $MGR POST /api/refunds/orders/$O2/refund "{\"requestId\":\"$(rid)\",\"kind\":\"FULL\",\"reason\":\"返品\",\"restoreStock\":true,\"expectedAmount\":300}"; check "カード決済の注文を返金" 201
expect "返金は残高へ" 300 "$(dbq "SELECT balance FROM wallets WHERE id=(SELECT wallet_id FROM cards WHERE id='$C1')")"

echo "== 期限切れ =="
dbq "UPDATE cards SET expires_at = $PAST WHERE id='$C2'" >/dev/null
scan $CLERK "$T2" "$(items $YAKI 1)"; check "期限切れはレジで使えない" 403; expect "コード" CARD_EXPIRED "$(jget "['error']['code']")"
# 期限切れの前に700をチャージしておく(あとで払い戻す)
dbq "UPDATE cards SET expires_at = $(( $(date +%s) * 1000 + 86400000 )) WHERE id='$C2'" >/dev/null
lookup $R1 "$T2"; LX=$(jget "['lookupId']")
req $R1 POST /api/reception/charge "{\"lookupId\":\"$LX\",\"requestId\":\"$(rid)\",\"cashAmount\":700}"; check "期限前に700チャージ" 201
dbq "UPDATE cards SET expires_at = $PAST WHERE id='$C2'" >/dev/null
dbq "UPDATE wallets SET expires_at = $PAST WHERE id=(SELECT wallet_id FROM cards WHERE id='$C2')" >/dev/null
lookup $R1 "$T2"; check "期限切れのカードも受付で読み取れる(払戻しのため)" 200; LE=$(jget "['lookupId']")
expect "期限切れの印" True "$(jget "['wallet']['expired']")"
req $R1 POST /api/reception/charge "{\"lookupId\":\"$LE\",\"requestId\":\"$(rid)\",\"cashAmount\":500}"; check "期限切れにはチャージできない" 409
req $R1 POST /api/reception/payout "{\"lookupId\":\"$LE\",\"requestId\":\"$(rid)\",\"expectedBalance\":700}"; check "期限切れでもPINなしは払い戻せない" 400
req $R1 POST /api/reception/payout "{\"lookupId\":\"$LE\",\"requestId\":\"$(rid)\",\"expectedBalance\":700,\"pin\":\"2222\"}"; check "期限切れでもPINがあれば残高を払い戻せる" 201
expect "払戻し後の残高は0" 0 "$(dbq "SELECT balance FROM wallets WHERE id=(SELECT wallet_id FROM cards WHERE id='$C2')")"
req $ADMIN GET "/api/cards?status=EXPIRED"; expect "期限切れの一覧" "C000002" "$(jget "['cards'][0]['displayNo']")"; expect "表示の状態" EXPIRED "$(jget "['cards'][0]['status']")"
dbq "UPDATE cards SET expires_at = $(( $(date +%s) * 1000 + 3*86400000 )) WHERE id='$C2'" >/dev/null
req $ADMIN GET "/api/cards?expiring=7"; check "期限が近いカードの一覧" 200; expect "3日後に切れるカードが出る" "C000002" "$(jget "['cards'][0]['displayNo']")"
req $ADMIN GET "/api/cards?expiring=2"; expect "2日以内には出ない" 0 "$(jget "['cards'].__len__()")"
req $ADMIN GET "/api/cards?expiring=0"; check "範囲外は400" 400
dbq "UPDATE cards SET expires_at = $(( $(date +%s) * 1000 + 86400000 )) WHERE id='$C2'" >/dev/null
dbq "UPDATE wallets SET expires_at = $(( $(date +%s) * 1000 + 86400000 )) WHERE id=(SELECT wallet_id FROM cards WHERE id='$C2')" >/dev/null

echo "== QRの再生成(未有効化) =="
req $ADMIN POST /api/cards/$C3/regenerate '{}'; check "QRを作り直す" 200; T3N=$(jget "['card']['token']")
req $ADMIN POST /api/cards/scan "{\"token\":\"$T3\"}"; check "古いQRは使えない" 404
req $ADMIN POST /api/cards/scan "{\"token\":\"$T3N\"}"; check "新しいQRは使える" 200
expect "古いトークンの墓標は残り失効済み" 1 "$(dbq "SELECT count(*) FROM token_tombstones WHERE token_hash=(SELECT '$T3' ) OR retired_at IS NOT NULL")"
expect "墓標は増える(再利用防止)" 8 "$(dbq "SELECT count(*) FROM token_tombstones WHERE kind='CARD_QR'")"

echo "== 削除 =="
req $ADMIN POST /api/cards/$C2/activate '{"nickname":"x","pin":"1111"}'; check "有効化済み(C2)は不可" 409
req $ADMIN POST /api/cards/$C4/delete '{"reason":"","walletAction":"KEEP"}'; check "理由は必須" 400
req $MGR POST /api/cards/$C4/delete '{"reason":"x","walletAction":"KEEP"}'; check "責任者は削除できない" 403
req $ADMIN POST /api/cards/$C4/delete '{"reason":"印刷ミス","walletAction":"KEEP"}'; check "未有効化カードを削除" 200
req $ADMIN POST /api/cards/scan "{\"token\":\"$T4\"}"; check "削除したカードのQRは使えない" 404
req $ADMIN POST /api/cards/$C4/delete '{"reason":"もう一度","walletAction":"KEEP"}'; check "二重の削除は409" 409
expect "削除後もレコードは残る(ソフト削除)" "DELETED/None" "$(dbq "SELECT status||'/'||COALESCE(qr_token_hash,'None') FROM cards WHERE id='$C4'")"
expect "物理削除はできない" "0" "$(npx wrangler d1 execute DB --local --command "DELETE FROM cards WHERE id='$C4'" 2>&1 | grep -c 'soft-deleted' | python3 -I -c "import sys;print(0 if int(sys.stdin.read())>0 else 1)")"
# 有効化済みカードの削除(ウォレット停止)
req $ADMIN POST /api/cards/$C2/activate '{"nickname":"y","pin":"1111"}'; check "(再)有効化できない" 409
lookup $R1 "$T2"; L4=$(jget "['lookupId']")
req $R1 POST /api/reception/charge "{\"lookupId\":\"$L4\",\"requestId\":\"$(rid)\",\"cashAmount\":1500}"; check "C2へチャージ" 201
req $ADMIN POST /api/cards/$C2/delete '{"reason":"紛失","walletAction":"SUSPEND"}'; check "有効なカードを削除(ウォレット停止)" 200
expect "ウォレットは停止・残高は残る" "SUSPENDED/1500" "$(dbq "SELECT status||'/'||balance FROM wallets WHERE id=(SELECT wallet_id FROM cards WHERE id='$C2')")"
req $ADMIN GET "/api/cards?status=DELETED"; expect "削除済みの一覧に残高が見える" 1500 "$(python3 -I -c "import json;d=json.load(open('$TMP/body'));print([c for c in d['cards'] if c['displayNo']=='C000002'][0]['balance'])")"
scan $CLERK "$T2" "$(items $YAKI 1)"; check "削除したカードは決済できない" 400

echo "== 再発行(残高の引き継ぎ) =="
req $ADMIN POST /api/cards/$C5/activate '{"nickname":"さぶろう","pin":"5555"}'; check "C5を有効化" 201
lookup $R1 "$T5"; L5=$(jget "['lookupId']")
req $R1 POST /api/reception/charge "{\"lookupId\":\"$L5\",\"requestId\":\"$(rid)\",\"cashAmount\":3000}"; check "C5へチャージ" 201
W5=$(dbq "SELECT wallet_id FROM cards WHERE id='$C5'")
req $ADMIN POST /api/cards/$C5/delete "{\"reason\":\"破損\",\"walletAction\":\"TRANSFER\"}"; check "引き継ぎ先なしは400" 400
req $ADMIN POST /api/cards/$C5/delete "{\"reason\":\"破損\",\"walletAction\":\"TRANSFER\",\"newCardId\":\"$C5\",\"newPin\":\"7777\"}"; check "自分自身へは引き継げない" 400
req $ADMIN POST /api/cards/$C5/delete "{\"reason\":\"破損\",\"walletAction\":\"TRANSFER\",\"newCardId\":\"$C1\",\"newPin\":\"7777\"}"; check "有効化済みのカードへは引き継げない" 409
expect "失敗時は旧カードがそのまま" ACTIVE "$(dbq "SELECT status FROM cards WHERE id='$C5'")"
req $ADMIN POST /api/cards/$C5/delete "{\"reason\":\"破損\",\"walletAction\":\"TRANSFER\",\"newCardId\":\"$C6\",\"newPin\":\"7777\"}"; check "再発行" 200
expect "旧カードは削除" DELETED "$(dbq "SELECT status FROM cards WHERE id='$C5'")"
expect "新カードは有効・同じウォレット・同じニックネーム" "ACTIVE/$W5/さぶろう" "$(dbq "SELECT status||'/'||wallet_id||'/'||nickname FROM cards WHERE id='$C6'")"
expect "旧カードへの参照" "$C5" "$(dbq "SELECT reissued_from_card_id FROM cards WHERE id='$C6'")"
expect "残高は引き継がれる" 3000 "$(dbq "SELECT balance FROM wallets WHERE id='$W5'")"
scan $CLERK "$T5" "$(items $YAKI 1)"; check "旧カードのQRは使えない" 400
req $ADMIN POST /api/cards/scan "{\"token\":\"$T5\"}"; check "旧QRは墓標のため再利用されない(登録なし)" 404
expect "新旧が同時に有効にならない" 1 "$(dbq "SELECT count(*) FROM cards WHERE wallet_id='$W5' AND status='ACTIVE'")"

echo "== 整合 =="
expect "残高と台帳の合計が一致(全カードのウォレット)" 0 "$(dbq "SELECT count(*) FROM wallets w WHERE w.owner_user_id IS NULL AND w.balance <> COALESCE((SELECT SUM(amount) FROM wallet_ledger l WHERE l.wallet_id = w.id),0)")"
expect "監査ログ(発行)" 1 "$(dbq "SELECT count(*) FROM audit_logs WHERE action='card.issue' AND after_json LIKE '%A組%'")"
expect "監査ログ(有効化)" 3 "$(dbq "SELECT count(*) FROM audit_logs WHERE action='card.activate'")"
expect "監査ログ(停止・再開)" "1/1" "$(dbq "SELECT (SELECT count(*) FROM audit_logs WHERE action='card.suspend')||'/'||(SELECT count(*) FROM audit_logs WHERE action='card.resume')")"
expect "監査ログ(再発行・削除)" "1/2" "$(dbq "SELECT (SELECT count(*) FROM audit_logs WHERE action='card.reissue')||'/'||(SELECT count(*) FROM audit_logs WHERE action='card.delete')")"
expect "PINが監査ログに出ていない" 0 "$(dbq "SELECT count(*) FROM audit_logs WHERE after_json LIKE '%1234%' OR after_json LIKE '%4321%' OR after_json LIKE '%7777%' OR after_json LIKE '%token%'")"

echo
echo "結果: pass=$pass fail=$fail"
[ $fail -eq 0 ]
