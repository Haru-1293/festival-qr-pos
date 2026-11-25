-- 割引の発動条件(商品の個数・会計金額)と、割引をかける範囲。
-- discount_conditions: 「この商品(タグ・セット)をN個以上買ったとき」。複数あるときは condition_mode で「すべて満たす(ALL)/どれか(ANY)」。
--   会計金額の条件は従来どおり discounts.min_order_amount(条件に1つ加わる)。
-- apply_scope: DEFAULT=従来どおり(対象を指定していればその商品、なければ全体) / ORDER=会計全体 / CONDITION=条件にあたった商品だけ
ALTER TABLE discounts ADD COLUMN apply_scope TEXT NOT NULL DEFAULT 'DEFAULT' CHECK (apply_scope IN ('DEFAULT','ORDER','CONDITION'));
ALTER TABLE discounts ADD COLUMN condition_mode TEXT NOT NULL DEFAULT 'ALL' CHECK (condition_mode IN ('ALL','ANY'));
CREATE TABLE discount_conditions (
  discount_id TEXT NOT NULL REFERENCES discounts(id),
  target_type TEXT NOT NULL CHECK (target_type IN ('PRODUCT','TAG','SET')),
  target_id   TEXT NOT NULL,
  min_qty     INTEGER NOT NULL CHECK (min_qty >= 1 AND min_qty <= 1000),
  PRIMARY KEY (discount_id, target_type, target_id)
);
