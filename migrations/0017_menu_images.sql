-- メニュー画像。R2を使わない環境では、画像をこのテーブル(D1)に保存する(R2があればR2へ)
CREATE TABLE menu_images (
  key          TEXT PRIMARY KEY,
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg','image/png','image/webp')),
  data         BLOB NOT NULL,
  created_at   INTEGER NOT NULL
);
-- products.image_key は初期スキーマにある。セットにも画像を付けられるようにする
ALTER TABLE sets ADD COLUMN image_key TEXT;
