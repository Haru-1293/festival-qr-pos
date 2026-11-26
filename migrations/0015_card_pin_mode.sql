-- カードのPINの決め方: USER=有効化のときにお客様が決める / ISSUE=発行時にランダムな4桁を設定してカードに印字する
ALTER TABLE cards ADD COLUMN pin_mode TEXT NOT NULL DEFAULT 'USER' CHECK (pin_mode IN ('USER','ISSUE'));
-- 発行時PINの暗号化保存(有効化までの印刷のやり直し用。有効化すると消す)
ALTER TABLE cards ADD COLUMN pin_enc TEXT;
