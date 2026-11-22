-- 先着N人のクーポン。first_come=1 のとき、total_limit が「先着の人数」、per_wallet_limit は 1(1人1回)になる。
-- 割引の計算・確定の仕組み(利用上限・1人あたりの上限)はそのまま使うので、ここでは表示と作成時の検証のための印だけを持つ。
ALTER TABLE coupons ADD COLUMN first_come INTEGER NOT NULL DEFAULT 0 CHECK (first_come IN (0,1));
