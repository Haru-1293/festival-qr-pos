-- 注文ステータス(調理中/提供可能)と呼び出しボード。店舗ごとのオプション(既定はオフ)
ALTER TABLE shops ADD COLUMN use_order_tracking INTEGER NOT NULL DEFAULT 0;
ALTER TABLE shops ADD COLUMN use_call_board INTEGER NOT NULL DEFAULT 0;

CREATE TABLE order_tracking (
  order_id   TEXT PRIMARY KEY REFERENCES orders(id),
  shop_id    TEXT NOT NULL REFERENCES shops(id),
  call_no    INTEGER NOT NULL,                 -- お客様を呼ぶ番号(店舗ごとに 1〜99 を繰り返す)
  status     TEXT NOT NULL DEFAULT 'PREPARING' CHECK (status IN ('PREPARING','READY','DONE')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_order_tracking_shop ON order_tracking(shop_id, status, created_at);

-- 支払いが確定した注文は、店舗がオプションをオンにしていれば自動で「調理中」から始まる
CREATE TRIGGER orders_start_tracking AFTER INSERT ON orders
WHEN EXISTS (SELECT 1 FROM shops WHERE id = NEW.shop_id AND use_order_tracking = 1)
BEGIN
  INSERT INTO order_tracking (order_id, shop_id, call_no, status, created_at, updated_at)
  VALUES (
    NEW.id, NEW.shop_id,
    (COALESCE((SELECT t.call_no FROM order_tracking t WHERE t.shop_id = NEW.shop_id ORDER BY t.created_at DESC, t.rowid DESC LIMIT 1), 0) % 99) + 1,
    'PREPARING', NEW.paid_at, NEW.paid_at
  );
END;
