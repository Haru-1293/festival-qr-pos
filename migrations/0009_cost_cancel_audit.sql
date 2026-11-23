-- 原価(任意)・注文取消し・監査ログの絞り込み用の索引

-- 原価。店舗責任者が任意で入力する。未入力(NULL)の商品は粗利の集計に含めない
ALTER TABLE products ADD COLUMN cost INTEGER CHECK (cost IS NULL OR cost >= 0);
-- 売れた時点の原価(その行の合計 = 1個の原価 × 数量。セットは内訳商品の原価の合計)。原価が分からない行は NULL
ALTER TABLE order_lines ADD COLUMN cost_total INTEGER CHECK (cost_total IS NULL OR cost_total >= 0);
-- 店員の「注文取消し」で作られた全額返金は 1 にする(通常の返金と区別して集計・表示する)
ALTER TABLE refunds ADD COLUMN cancel INTEGER NOT NULL DEFAULT 0 CHECK (cancel IN (0,1));

-- 商品ごとの返金率(%)で返金したときの率。数量で返金したときは NULL
ALTER TABLE refund_lines ADD COLUMN percent INTEGER CHECK (percent IS NULL OR (percent >= 1 AND percent <= 100));

-- 監査ログを店舗で絞り込むための列(操作者または対象の店舗)。書き込み時に自動で入る
ALTER TABLE audit_logs ADD COLUMN shop_id TEXT;
UPDATE audit_logs SET shop_id = CASE target_type
    WHEN 'shop' THEN target_id
    WHEN 'order' THEN (SELECT shop_id FROM orders WHERE id = audit_logs.target_id)
    WHEN 'product' THEN (SELECT shop_id FROM products WHERE id = audit_logs.target_id)
    WHEN 'payment_session' THEN (SELECT shop_id FROM payment_sessions WHERE id = audit_logs.target_id)
    WHEN 'tag' THEN (SELECT shop_id FROM tags WHERE id = audit_logs.target_id)
    WHEN 'set' THEN (SELECT shop_id FROM sets WHERE id = audit_logs.target_id)
  END;
UPDATE audit_logs SET shop_id = (SELECT shop_id FROM users WHERE id = audit_logs.actor_user_id) WHERE shop_id IS NULL;

CREATE INDEX idx_audit_shop_time ON audit_logs(shop_id, created_at);
CREATE INDEX idx_audit_action_time ON audit_logs(action, created_at);
CREATE INDEX idx_audit_role_time ON audit_logs(actor_role, created_at);
-- 返金の検索(店舗・期間)と商品での絞り込み
CREATE INDEX idx_refunds_order ON refunds(order_id);
CREATE INDEX idx_order_lines_product ON order_lines(product_id);
