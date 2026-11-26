-- ログインQR・カードQRを何度でも表示するための暗号化保存(AES-GCM。鍵はサーバーの秘密値から作る)
ALTER TABLE reception_login_qrs ADD COLUMN token_enc TEXT;
ALTER TABLE cards ADD COLUMN qr_enc TEXT;

-- 印刷デザイン(背景画像+QR・表示名などの位置)。ログインカード用(LOGIN)とQRカード用(CARD)
CREATE TABLE print_templates (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('LOGIN','CARD')),
  name       TEXT NOT NULL,
  layout     TEXT NOT NULL,          -- JSON(カードの大きさ・各要素の位置)
  image      TEXT,                   -- 背景画像(data URL。縮小・圧縮済み)。なしは単色
  created_at INTEGER NOT NULL,
  created_by TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_print_templates_kind ON print_templates(kind, updated_at DESC);
