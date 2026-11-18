-- 決済(店舗のレジでの QR 支払い)。注文明細に、値下げ前の定価と適用した値下げを履歴として残す(仕様 v0.3 §1.12)
ALTER TABLE order_lines ADD COLUMN list_unit_price INTEGER;   -- 値下げ前の定価(1点あたり)
ALTER TABLE order_lines ADD COLUMN price_cut_id TEXT;         -- 適用した値下げ(なければ NULL)
ALTER TABLE order_lines ADD COLUMN price_cut_name TEXT;

CREATE INDEX idx_payment_sessions_shop ON payment_sessions(shop_id, created_at);
