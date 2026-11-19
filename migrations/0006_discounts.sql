-- 割引・クーポン(v0.2 §14, v0.3 §1.5, 仮定 A24)
--
-- * payment_sessions.coupon_code: 店員が入力したクーポンコード。確定時にサーバーが検証・再計算する。
-- * discounts / coupons / order_discounts / coupon_redemptions は 0001 で作成済み。
ALTER TABLE payment_sessions ADD COLUMN coupon_code TEXT;
CREATE INDEX idx_order_discounts_order ON order_discounts(order_id);
CREATE INDEX idx_redemptions_order ON coupon_redemptions(order_id);
