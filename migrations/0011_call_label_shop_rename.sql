-- 呼び出し札を英字・記号(半角)でも使えるようにする。
-- call_no(整数)は自動採番のまま残し、札の文字列は call_label に持つ。画面に出す呼び出し名は COALESCE(call_label, CAST(call_no AS TEXT))。
ALTER TABLE order_tracking ADD COLUMN call_label TEXT;
ALTER TABLE payment_sessions ADD COLUMN tag_label TEXT;
CREATE INDEX idx_tracking_shop_label ON order_tracking(shop_id, call_label);

-- 店舗名の変更履歴。店舗は不変のIDで参照されるので、過去の注文・ログは名前を変えても同じ店舗につながる。
-- valid_from 以降(次の履歴まで)の表示名を持ち、過去ログには「その時点の店舗名」を表示できる。追記専用。
CREATE TABLE shop_name_history (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  display_name TEXT NOT NULL,
  valid_from INTEGER NOT NULL,
  changed_by TEXT REFERENCES users(id)
);
CREATE INDEX idx_shop_name_history ON shop_name_history(shop_id, valid_from);
CREATE TRIGGER shop_name_history_no_update BEFORE UPDATE ON shop_name_history BEGIN SELECT RAISE(ABORT, 'shop_name_history is append-only'); END;
CREATE TRIGGER shop_name_history_no_delete BEFORE DELETE ON shop_name_history BEGIN SELECT RAISE(ABORT, 'shop_name_history is append-only'); END;

-- 既存店舗の現在の名前を、作成時点からの名前として登録(0 始まりにして、どの過去ログにも当たるようにする)
INSERT INTO shop_name_history (id, shop_id, display_name, valid_from, changed_by)
SELECT lower(hex(randomblob(13))), id, display_name, 0, NULL FROM shops;
