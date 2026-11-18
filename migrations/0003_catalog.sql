-- 商品・タグ・在庫の運用と、定価の一律値下げ(仕様 v0.3 §1.12)

-- 店舗ごとのカタログ版番号。商品・価格・売り切れ・値下げが変わるたびに増える。
-- POS 画面はこの番号を数秒おきに確認し、変わっていたら商品一覧を取り直す(リアルタイム反映)
ALTER TABLE shops ADD COLUMN catalog_version INTEGER NOT NULL DEFAULT 0;

-- 定価の一律値下げ(店舗責任者が設定)。1店舗につき同時に有効な設定は1件
-- 期限切れの設定は、次に設定を作るときに ENDED へ整理する
CREATE TABLE shop_price_cuts (
  id         TEXT PRIMARY KEY,
  shop_id    TEXT NOT NULL REFERENCES shops(id),
  name       TEXT NOT NULL,
  method     TEXT NOT NULL CHECK (method IN ('PERCENT','FIXED')),
  value      INTEGER NOT NULL CHECK (value > 0),
  starts_at  INTEGER,                      -- NULL = 作成した瞬間から
  ends_at    INTEGER,                      -- NULL = 手動で止めるまで
  status     TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','STOPPED','ENDED')),
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  stopped_at INTEGER,
  stopped_by TEXT,
  CHECK (method <> 'PERCENT' OR value <= 100),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);
CREATE UNIQUE INDEX uq_price_cut_active ON shop_price_cuts(shop_id) WHERE status = 'ACTIVE';
CREATE INDEX idx_price_cut_shop ON shop_price_cuts(shop_id, created_at);
