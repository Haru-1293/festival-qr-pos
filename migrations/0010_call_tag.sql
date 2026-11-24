-- 呼び出しの方式。AUTO = 支払いごとに自動で番号を振る(従来) / TAG = レジで店員が番号札の番号を入力する
ALTER TABLE shops ADD COLUMN call_mode TEXT NOT NULL DEFAULT 'AUTO' CHECK (call_mode IN ('AUTO','TAG'));
-- レジで入力された番号札の番号(支払い確定のときに注文の呼び出し番号になる)
ALTER TABLE payment_sessions ADD COLUMN tag_no INTEGER CHECK (tag_no IS NULL OR (tag_no >= 1 AND tag_no <= 999));
-- お客様が自分の「受け取り待ち」の注文を探す(ウォレット → 注文)
CREATE INDEX idx_orders_wallet_paid ON orders(wallet_id, paid_at);
