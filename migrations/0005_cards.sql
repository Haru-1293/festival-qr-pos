-- 物理QRカード(v0.2 §6)
--
-- * wallet_lookups.card_id: 受付がカードのQRを読み取った場合の、カードへの参照。
--   カードのQRは固定(スマホQRと違い読み取りで消費しない)ので、払戻しのPIN確認とカード状態の再確認に使う。
-- * cards.suspend_reason: 一時停止の理由(操作の履歴は監査ログにも残る)。
-- * cards.reissued_from_card_id: 再発行(旧カードの残高を新カードへ引き継ぎ)のとき、旧カード。
ALTER TABLE wallet_lookups ADD COLUMN card_id TEXT REFERENCES cards(id);
ALTER TABLE cards ADD COLUMN suspend_reason TEXT;
ALTER TABLE cards ADD COLUMN reissued_from_card_id TEXT REFERENCES cards(id);
CREATE INDEX idx_cards_batch ON cards(issue_batch);
CREATE INDEX idx_orders_card ON orders(card_id);
