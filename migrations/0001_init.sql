-- festival-qr-pos / Cloudflare D1 (SQLite) 初期スキーマ
-- 仕様: docs/spec/v0.2.md + docs/spec/v0.3-changes.md
--
-- 規約
--  * 金額はすべて INTEGER(通貨の最小単位。既定は小数なし=1pt)。通貨名称は settings で持ち、数値は変えない
--  * 時刻は INTEGER(UNIX epoch ミリ秒, UTC)。表示時に日本時間へ変換する
--  * 主キーは TEXT(アプリ側で生成する ULID/UUID)
--  * 残高・在庫・返金上限・クーポン上限は CHECK 制約で「負/超過」を DB に拒否させる。
--    決済・返金などは db.batch() で1トランザクションにまとめ、条件を破る更新が
--    1つでもあればバッチ全体がロールバックされる(最後の1個・残高二重利用の防止)
--  * 成立した取引・台帳・監査ログは UPDATE/DELETE をトリガで禁止する(履歴削除禁止)

-- ============================================================
-- 共通設定
-- ============================================================
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,            -- JSON
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

-- ============================================================
-- 店舗・端末
-- ============================================================
CREATE TABLE shops (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','CLOSED')),
  opens_at     INTEGER,
  closes_at    INTEGER,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);

CREATE TABLE pos_devices (
  id         TEXT PRIMARY KEY,
  shop_id    TEXT NOT NULL REFERENCES shops(id),
  label      TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED')),
  created_at INTEGER NOT NULL
);

-- ============================================================
-- ユーザー・認証
-- ============================================================
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  role          TEXT NOT NULL CHECK (role IN ('CUSTOMER','CLERK','SHOP_MANAGER','RECEPTION','ADMIN')),
  -- 一般利用者: メールアドレス(=ログインID。メール送信なし)。店員/店舗責任者/管理者: ログインID。
  -- 受付担当者はQRログインのため NULL 可
  login_id      TEXT COLLATE NOCASE UNIQUE,
  password_hash TEXT,                  -- PBKDF2(WebCrypto)。受付担当者は NULL 可
  nickname      TEXT NOT NULL,
  shop_id       TEXT REFERENCES shops(id),
  status        TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','DELETED')),
  created_at    INTEGER NOT NULL,
  created_by    TEXT,
  -- 店員・店舗責任者は必ず所属店舗を持ち、それ以外は持たない
  CHECK ((role IN ('CLERK','SHOP_MANAGER')) = (shop_id IS NOT NULL)),
  CHECK (role = 'RECEPTION' OR login_id IS NOT NULL)
);
CREATE INDEX idx_users_shop ON users(shop_id);

-- 受付担当者の恒久ログインQR(担当生徒ごとに1枚)。失効・再発行は履歴を残す
CREATE TABLE reception_login_qrs (
  token_hash TEXT PRIMARY KEY,         -- SHA-256(生トークン)。生トークンは保存しない
  user_id    TEXT NOT NULL REFERENCES users(id),
  issued_at  INTEGER NOT NULL,
  issued_by  TEXT NOT NULL,
  revoked_at INTEGER,
  revoked_by TEXT,
  revoke_reason TEXT
);
-- 1人につき有効なQRは1枚
CREATE UNIQUE INDEX uq_reception_qr_active ON reception_login_qrs(user_id) WHERE revoked_at IS NULL;

CREATE TABLE sessions (
  id_hash        TEXT PRIMARY KEY,     -- セッションIDのSHA-256
  user_id        TEXT NOT NULL REFERENCES users(id),
  device_label   TEXT,
  -- 1=同時ログイン1端末のみ(受付担当者)。新しいログインで古い端末はサーバー側で破棄する
  single_session INTEGER NOT NULL DEFAULT 0 CHECK (single_session IN (0,1)),
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX uq_sessions_single ON sessions(user_id) WHERE single_session = 1;

-- QR認証トークンの永久再利用防止(物理カードQR・受付ログインQR)。削除・失効後も残す
CREATE TABLE token_tombstones (
  token_hash TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('CARD_QR','RECEPTION_LOGIN_QR')),
  created_at INTEGER NOT NULL,
  retired_at INTEGER
);

-- ============================================================
-- ウォレット・台帳
-- ============================================================
CREATE TABLE wallets (
  id            TEXT PRIMARY KEY,
  owner_user_id TEXT UNIQUE REFERENCES users(id),   -- 物理カードのウォレットは NULL
  balance       INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  status        TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','CLOSED')),
  expires_at    INTEGER,                            -- 前払式支払手段(6か月特例)の有効期限
  created_at    INTEGER NOT NULL
);

-- 残高変動の唯一の記録。amount は符号付き(チャージ+、決済-、返金+、払戻し-)
CREATE TABLE wallet_ledger (
  id               TEXT PRIMARY KEY,
  wallet_id        TEXT NOT NULL REFERENCES wallets(id),
  kind             TEXT NOT NULL CHECK (kind IN ('CHARGE','CHARGE_CORRECTION','PAYMENT','REFUND','PAYOUT','ADJUSTMENT')),
  amount           INTEGER NOT NULL CHECK (amount <> 0),
  balance_after    INTEGER NOT NULL CHECK (balance_after >= 0),
  ref_type         TEXT,                            -- 'ORDER' | 'REFUND' | 'CASH_EVENT' など
  ref_id           TEXT,
  corrects_ledger_id TEXT REFERENCES wallet_ledger(id),
  operator_user_id TEXT,
  device_id        TEXT,
  reason           TEXT,
  idempotency_key  TEXT UNIQUE,
  created_at       INTEGER NOT NULL
);
CREATE INDEX idx_ledger_wallet ON wallet_ledger(wallet_id, created_at);

-- スマホ支払QR / 識別QR(チャージ・払戻し用)。「読み取ってDB確認/APIを使った時点」で消費する
CREATE TABLE pay_qr_tokens (
  token_hash  TEXT PRIMARY KEY,
  wallet_id   TEXT NOT NULL REFERENCES wallets(id),
  purpose     TEXT NOT NULL DEFAULT 'PAY' CHECK (purpose IN ('PAY','IDENTIFY')),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,                     -- 既定: 生成から5分
  invalidated_at INTEGER,                           -- 新規生成で旧QRを無効化した時刻
  consumed_at INTEGER,                              -- 読み取り(API使用)時刻
  consumed_by_user_id TEXT
);
CREATE INDEX idx_payqr_wallet ON pay_qr_tokens(wallet_id);

-- ============================================================
-- 物理QRカード
-- ============================================================
CREATE TABLE cards (
  id            TEXT PRIMARY KEY,                   -- 内部ID(QRに載せない)
  display_no    TEXT NOT NULL UNIQUE,               -- 表示用カード番号(認証に使わない・再利用しない)
  qr_token_hash TEXT UNIQUE,                        -- 削除後は NULL(墓標は token_tombstones に残る)
  status        TEXT NOT NULL DEFAULT 'ISSUED' CHECK (status IN ('ISSUED','ACTIVE','SUSPENDED','EXPIRED','DELETED')),
  wallet_id     TEXT REFERENCES wallets(id),
  nickname      TEXT,
  pin_hash      TEXT,                               -- 4桁PIN。PBKDF2。ログ・フロントに出さない
  expires_at    INTEGER,
  issue_batch   TEXT,
  memo          TEXT,
  issued_at     INTEGER NOT NULL,
  issued_by     TEXT NOT NULL,
  activated_at  INTEGER,
  activated_by  TEXT,
  suspended_at  INTEGER,
  deleted_at    INTEGER,
  deleted_by    TEXT,
  delete_reason TEXT,
  -- 発行直後はニックネーム・PIN・ウォレット未設定(発行と有効化は別処理)
  CHECK (status <> 'ISSUED' OR (nickname IS NULL AND pin_hash IS NULL AND wallet_id IS NULL AND activated_at IS NULL)),
  CHECK (status NOT IN ('ACTIVE','SUSPENDED') OR (nickname IS NOT NULL AND pin_hash IS NOT NULL AND wallet_id IS NOT NULL))
);
CREATE INDEX idx_cards_nickname ON cards(nickname);
CREATE INDEX idx_cards_status ON cards(status);
CREATE INDEX idx_cards_wallet ON cards(wallet_id);

-- ============================================================
-- 商品・タグ・セット(店舗単位)
-- ============================================================
CREATE TABLE products (
  id               TEXT PRIMARY KEY,
  shop_id          TEXT NOT NULL REFERENCES shops(id),
  name             TEXT NOT NULL,
  price            INTEGER CHECK (price IS NULL OR price >= 0),  -- セット限定非売品は NULL 可
  description      TEXT,
  image_key        TEXT,                                          -- R2 のキー(拡張)
  sale_mode        TEXT NOT NULL DEFAULT 'BOTH' CHECK (sale_mode IN ('BOTH','SINGLE_ONLY','SET_ONLY')),
  status           TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','STOPPED','ARCHIVED')),
  manual_sold_out  INTEGER NOT NULL DEFAULT 0 CHECK (manual_sold_out IN (0,1)),  -- 数量管理の有無に関係なく可
  track_stock      INTEGER NOT NULL DEFAULT 0 CHECK (track_stock IN (0,1)),
  stock_qty        INTEGER CHECK (stock_qty IS NULL OR stock_qty >= 0),         -- 数量管理時のみ
  discountable     INTEGER NOT NULL DEFAULT 1 CHECK (discountable IN (0,1)),
  sort_order       INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  CHECK (sale_mode = 'SET_ONLY' OR price IS NOT NULL),
  CHECK (track_stock = 0 OR stock_qty IS NOT NULL)
  -- 売り切れ判定: manual_sold_out = 1 OR (track_stock = 1 AND stock_qty = 0)
);
CREATE INDEX idx_products_shop ON products(shop_id, status);

CREATE TABLE tags (
  id         TEXT PRIMARY KEY,
  shop_id    TEXT NOT NULL REFERENCES shops(id),
  name       TEXT NOT NULL,
  color      TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  UNIQUE (shop_id, name)
);

CREATE TABLE product_tags (
  product_id TEXT NOT NULL REFERENCES products(id),
  tag_id     TEXT NOT NULL REFERENCES tags(id),
  PRIMARY KEY (product_id, tag_id)
);

CREATE TABLE sets (
  id              TEXT PRIMARY KEY,
  shop_id         TEXT NOT NULL REFERENCES shops(id),
  name            TEXT NOT NULL,
  price           INTEGER NOT NULL CHECK (price >= 0),
  description     TEXT,
  status          TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','STOPPED','ARCHIVED')),
  manual_sold_out INTEGER NOT NULL DEFAULT 0 CHECK (manual_sold_out IN (0,1)),
  discountable    INTEGER NOT NULL DEFAULT 1 CHECK (discountable IN (0,1)),
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- セット内訳セグメント(商品タグとは別概念)
CREATE TABLE set_segments (
  id              TEXT PRIMARY KEY,
  set_id          TEXT NOT NULL REFERENCES sets(id),
  name            TEXT NOT NULL,
  required        INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0,1)),
  pick_count      INTEGER NOT NULL DEFAULT 1 CHECK (pick_count >= 1),
  allow_duplicate INTEGER NOT NULL DEFAULT 0 CHECK (allow_duplicate IN (0,1)),
  sort_order      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE set_segment_items (
  segment_id TEXT NOT NULL REFERENCES set_segments(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  surcharge  INTEGER NOT NULL DEFAULT 0 CHECK (surcharge >= 0),
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (segment_id, product_id)
);

CREATE TABLE stock_movements (
  id               TEXT PRIMARY KEY,
  product_id       TEXT NOT NULL REFERENCES products(id),
  delta            INTEGER NOT NULL CHECK (delta <> 0),
  qty_after        INTEGER,                         -- 数量未管理は NULL
  reason           TEXT NOT NULL CHECK (reason IN ('INITIAL','RESTOCK','SALE','SET_SALE','REFUND_RESTORE','ADJUST','DISCARD')),
  ref_type         TEXT,
  ref_id           TEXT,
  operator_user_id TEXT,
  note             TEXT,
  created_at       INTEGER NOT NULL
);
CREATE INDEX idx_stockmv_product ON stock_movements(product_id, created_at);

-- ============================================================
-- 割引・クーポン
-- ============================================================
CREATE TABLE discounts (
  id                   TEXT PRIMARY KEY,
  kind                 TEXT NOT NULL CHECK (kind IN ('AUTO','COUPON')),  -- AUTO=全ユーザー対象割引
  name                 TEXT NOT NULL,
  method               TEXT NOT NULL CHECK (method IN ('PERCENT','FIXED')),
  value                INTEGER NOT NULL CHECK (value > 0),
  min_order_amount     INTEGER,
  max_discount_amount  INTEGER,
  starts_at            INTEGER,
  ends_at              INTEGER,
  combinable_with_coupon INTEGER NOT NULL DEFAULT 1 CHECK (combinable_with_coupon IN (0,1)), -- AUTO側の併用フラグ
  status               TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','STOPPED','ENDED')),
  created_at           INTEGER NOT NULL,
  created_by           TEXT NOT NULL,
  CHECK (method <> 'PERCENT' OR value <= 100)
);

-- 対象指定(行が無ければ全体対象)
CREATE TABLE discount_targets (
  discount_id TEXT NOT NULL REFERENCES discounts(id),
  target_type TEXT NOT NULL CHECK (target_type IN ('SHOP','PRODUCT','TAG','SET')),
  target_id   TEXT NOT NULL,
  PRIMARY KEY (discount_id, target_type, target_id)
);

-- クーポンコード。COMMON=複数利用者が使える共通コード / ONE_TIME=店頭入力する使い捨てコード
CREATE TABLE coupons (
  id             TEXT PRIMARY KEY,
  code           TEXT NOT NULL COLLATE NOCASE UNIQUE,
  kind           TEXT NOT NULL CHECK (kind IN ('COMMON','ONE_TIME')),
  discount_id    TEXT NOT NULL REFERENCES discounts(id),
  total_limit    INTEGER,                          -- ONE_TIME は 1
  per_wallet_limit INTEGER,
  per_order_limit  INTEGER NOT NULL DEFAULT 1,
  used_count     INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  status         TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','STOPPED','ENDED')),
  note           TEXT,
  created_at     INTEGER NOT NULL,
  created_by     TEXT NOT NULL,
  CHECK (total_limit IS NULL OR used_count <= total_limit),   -- 同時実行でも上限超過を DB が拒否
  CHECK (kind <> 'ONE_TIME' OR total_limit = 1)
);

-- ============================================================
-- 注文・売上
-- ============================================================
CREATE TABLE orders (
  id                TEXT PRIMARY KEY,
  order_no          TEXT NOT NULL UNIQUE,           -- 取引番号(表示用)
  shop_id           TEXT NOT NULL REFERENCES shops(id),
  clerk_user_id     TEXT NOT NULL REFERENCES users(id),
  device_id         TEXT REFERENCES pos_devices(id),
  wallet_id         TEXT NOT NULL REFERENCES wallets(id),
  pay_source        TEXT NOT NULL CHECK (pay_source IN ('PHONE_QR','CARD')),
  card_id           TEXT REFERENCES cards(id),
  subtotal          INTEGER NOT NULL CHECK (subtotal >= 0),      -- 割引前小計
  discount_total    INTEGER NOT NULL DEFAULT 0 CHECK (discount_total >= 0),
  total_paid        INTEGER NOT NULL CHECK (total_paid >= 0),    -- 実支払額
  refunded_total    INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'PAID' CHECK (status IN ('PAID','PARTIALLY_REFUNDED','REFUNDED')),
  rounding_rule     TEXT NOT NULL DEFAULT 'FLOOR_REMAINDER_TO_LAST', -- 按分の端数規則を取引に記録
  idempotency_key   TEXT NOT NULL UNIQUE,           -- 二重決済防止
  ledger_id         TEXT REFERENCES wallet_ledger(id),
  paid_at           INTEGER NOT NULL,
  CHECK (subtotal - discount_total = total_paid),
  CHECK (refunded_total >= 0 AND refunded_total <= total_paid)   -- 累計返金額は実支払額を超えない
);
CREATE INDEX idx_orders_shop ON orders(shop_id, paid_at);
CREATE INDEX idx_orders_wallet ON orders(wallet_id, paid_at);

CREATE TABLE order_lines (
  id                 TEXT PRIMARY KEY,
  order_id           TEXT NOT NULL REFERENCES orders(id),
  line_no            INTEGER NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('PRODUCT','SET')),
  product_id         TEXT REFERENCES products(id),
  set_id             TEXT REFERENCES sets(id),
  name_snapshot      TEXT NOT NULL,
  unit_price         INTEGER NOT NULL CHECK (unit_price >= 0),   -- 単品価格 or セット価格(追加料金を含まない)
  quantity           INTEGER NOT NULL CHECK (quantity >= 1),
  surcharge_total    INTEGER NOT NULL DEFAULT 0 CHECK (surcharge_total >= 0),
  line_subtotal      INTEGER NOT NULL CHECK (line_subtotal >= 0), -- 割引前(unit_price*quantity + surcharge_total)
  discount_allocated INTEGER NOT NULL DEFAULT 0 CHECK (discount_allocated >= 0),
  line_paid          INTEGER NOT NULL CHECK (line_paid >= 0),     -- 割引後の実支払相当額
  refunded_amount    INTEGER NOT NULL DEFAULT 0,
  refunded_quantity  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (order_id, line_no),
  CHECK ((kind = 'PRODUCT' AND product_id IS NOT NULL AND set_id IS NULL)
      OR (kind = 'SET' AND set_id IS NOT NULL AND product_id IS NULL)),
  CHECK (line_subtotal - discount_allocated = line_paid),
  CHECK (refunded_amount >= 0 AND refunded_amount <= line_paid),
  CHECK (refunded_quantity >= 0 AND refunded_quantity <= quantity)
);

-- セット内訳(実際に選ばれた商品)。売上は計上せず、提供数・在庫消費の記録に使う
CREATE TABLE order_line_components (
  id                    TEXT PRIMARY KEY,
  order_line_id         TEXT NOT NULL REFERENCES order_lines(id),
  segment_name_snapshot TEXT NOT NULL,
  product_id            TEXT NOT NULL REFERENCES products(id),
  name_snapshot         TEXT NOT NULL,
  quantity              INTEGER NOT NULL CHECK (quantity >= 1),
  surcharge             INTEGER NOT NULL DEFAULT 0 CHECK (surcharge >= 0)
);

CREATE TABLE order_discounts (
  id            TEXT PRIMARY KEY,
  order_id      TEXT NOT NULL REFERENCES orders(id),
  apply_seq     INTEGER NOT NULL,                   -- 計算順序(全ユーザー割引→クーポン)
  kind          TEXT NOT NULL CHECK (kind IN ('AUTO','COMMON_COUPON','ONE_TIME_COUPON')),
  discount_id   TEXT REFERENCES discounts(id),
  coupon_id     TEXT REFERENCES coupons(id),
  name_snapshot TEXT NOT NULL,
  amount        INTEGER NOT NULL CHECK (amount > 0),
  UNIQUE (order_id, apply_seq)
);

CREATE TABLE coupon_redemptions (
  id          TEXT PRIMARY KEY,
  coupon_id   TEXT NOT NULL REFERENCES coupons(id),
  order_id    TEXT NOT NULL REFERENCES orders(id),
  wallet_id   TEXT NOT NULL REFERENCES wallets(id),
  amount      INTEGER NOT NULL CHECK (amount > 0),
  status      TEXT NOT NULL DEFAULT 'USED' CHECK (status IN ('USED','RESTORED')),
  created_at  INTEGER NOT NULL,
  restored_at INTEGER
);
CREATE INDEX idx_redemptions_coupon ON coupon_redemptions(coupon_id, wallet_id);

-- ============================================================
-- 決済セッション(QR読み取り時に作成。確定はこのセッションに対して行う)
-- ============================================================
CREATE TABLE payment_sessions (
  id            TEXT PRIMARY KEY,
  shop_id       TEXT NOT NULL REFERENCES shops(id),
  clerk_user_id TEXT NOT NULL REFERENCES users(id),
  device_id     TEXT REFERENCES pos_devices(id),
  wallet_id     TEXT NOT NULL REFERENCES wallets(id),
  pay_source    TEXT NOT NULL CHECK (pay_source IN ('PHONE_QR','CARD')),
  card_id       TEXT REFERENCES cards(id),
  cart_json     TEXT NOT NULL,                      -- 注文確認時点のカート(確定時にサーバーで再計算する)
  status        TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','COMMITTED','CANCELLED','EXPIRED')),
  order_id      TEXT REFERENCES orders(id),
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);

-- 汎用の冪等性レコード(結果不明時の再照会用)
CREATE TABLE idempotency_records (
  key           TEXT PRIMARY KEY,
  scope         TEXT NOT NULL,
  request_hash  TEXT NOT NULL,
  response_json TEXT,
  created_at    INTEGER NOT NULL
);

-- ============================================================
-- 返金
-- ============================================================
CREATE TABLE refunds (
  id               TEXT PRIMARY KEY,
  order_id         TEXT NOT NULL REFERENCES orders(id),
  kind             TEXT NOT NULL CHECK (kind IN ('FULL','PARTIAL','ARBITRARY')),
  amount           INTEGER NOT NULL CHECK (amount > 0),
  reason           TEXT NOT NULL,
  operator_user_id TEXT NOT NULL REFERENCES users(id),
  coupon_restored  INTEGER NOT NULL DEFAULT 0 CHECK (coupon_restored IN (0,1)),
  ledger_id        TEXT REFERENCES wallet_ledger(id),
  idempotency_key  TEXT NOT NULL UNIQUE,
  created_at       INTEGER NOT NULL
);

CREATE TABLE refund_lines (
  id            TEXT PRIMARY KEY,
  refund_id     TEXT NOT NULL REFERENCES refunds(id),
  order_line_id TEXT NOT NULL REFERENCES order_lines(id),
  quantity      INTEGER NOT NULL CHECK (quantity >= 0),
  amount        INTEGER NOT NULL CHECK (amount >= 0),   -- 割引後の実支払相当額ベース
  restore_stock INTEGER NOT NULL DEFAULT 0 CHECK (restore_stock IN (0,1))
);

-- ============================================================
-- 受付の現金台帳・締め
--  * 釣銭準備金は持たない。受領額(CHARGE)・渡した額(PAYOUT)・途中回収(DROP)・訂正を記録する
--  * 期待現金額 = CHARGE - PAYOUT - DROP ± CORRECTION
-- ============================================================
CREATE TABLE cash_closings (
  id               TEXT PRIMARY KEY,
  scope_kind       TEXT NOT NULL CHECK (scope_kind IN ('DAY','SHIFT','MANUAL')),  -- 締め単位は全体管理者が設定
  scope_user_id    TEXT REFERENCES users(id),        -- SHIFT のとき担当者
  period_start     INTEGER NOT NULL,
  period_end       INTEGER NOT NULL,
  expected_amount  INTEGER NOT NULL,
  counted_amount   INTEGER,                          -- 実数入力は任意
  difference       INTEGER,                          -- counted - expected(入力があるとき)
  note             TEXT,
  closed_by        TEXT NOT NULL REFERENCES users(id),
  closed_at        INTEGER NOT NULL
);

CREATE TABLE cash_events (
  id               TEXT PRIMARY KEY,
  reception_user_id TEXT NOT NULL REFERENCES users(id),
  device_label     TEXT,
  kind             TEXT NOT NULL CHECK (kind IN ('CHARGE','PAYOUT','DROP','CORRECTION')),
  amount           INTEGER NOT NULL,                 -- 常に正。符号は kind で決まる(CORRECTION のみ符号付き)
  ledger_id        TEXT REFERENCES wallet_ledger(id),
  reason           TEXT,
  closing_id       TEXT REFERENCES cash_closings(id),
  created_at       INTEGER NOT NULL,
  CHECK (kind = 'CORRECTION' OR amount > 0),
  CHECK (kind = 'CORRECTION' OR kind NOT IN ('CHARGE','PAYOUT') OR ledger_id IS NOT NULL)
);
CREATE INDEX idx_cash_user ON cash_events(reception_user_id, created_at);
CREATE INDEX idx_cash_open ON cash_events(closing_id);

-- ============================================================
-- 監査ログ(パスワード・PIN・生QRトークンは保存しない)
-- ============================================================
CREATE TABLE audit_logs (
  id            TEXT PRIMARY KEY,
  actor_user_id TEXT,
  actor_role    TEXT,
  action        TEXT NOT NULL,
  target_type   TEXT,
  target_id     TEXT,
  before_json   TEXT,
  after_json    TEXT,
  reason        TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_audit_target ON audit_logs(target_type, target_id);
CREATE INDEX idx_audit_time ON audit_logs(created_at);

-- ============================================================
-- 履歴削除禁止トリガ
-- ============================================================
CREATE TRIGGER wallet_ledger_no_update BEFORE UPDATE ON wallet_ledger
BEGIN SELECT RAISE(ABORT, 'wallet_ledger is append-only'); END;
CREATE TRIGGER wallet_ledger_no_delete BEFORE DELETE ON wallet_ledger
BEGIN SELECT RAISE(ABORT, 'wallet_ledger is append-only'); END;

CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;
CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;

CREATE TRIGGER stock_movements_no_update BEFORE UPDATE ON stock_movements
BEGIN SELECT RAISE(ABORT, 'stock_movements is append-only'); END;
CREATE TRIGGER stock_movements_no_delete BEFORE DELETE ON stock_movements
BEGIN SELECT RAISE(ABORT, 'stock_movements is append-only'); END;

CREATE TRIGGER orders_no_delete BEFORE DELETE ON orders
BEGIN SELECT RAISE(ABORT, 'orders cannot be deleted'); END;
CREATE TRIGGER refunds_no_update BEFORE UPDATE ON refunds
BEGIN SELECT RAISE(ABORT, 'refunds is append-only'); END;
CREATE TRIGGER refunds_no_delete BEFORE DELETE ON refunds
BEGIN SELECT RAISE(ABORT, 'refunds is append-only'); END;

CREATE TRIGGER cash_events_no_delete BEFORE DELETE ON cash_events
BEGIN SELECT RAISE(ABORT, 'cash_events cannot be deleted'); END;
-- 締め済みの現金イベントは変更不可。未締めのイベントに closing_id を付ける更新だけ許可する
CREATE TRIGGER cash_events_limited_update BEFORE UPDATE ON cash_events
WHEN OLD.closing_id IS NOT NULL
   OR NEW.reception_user_id <> OLD.reception_user_id
   OR NEW.kind <> OLD.kind
   OR NEW.amount <> OLD.amount
BEGIN SELECT RAISE(ABORT, 'cash_events is immutable except attaching a closing'); END;
CREATE TRIGGER cash_closings_no_update BEFORE UPDATE ON cash_closings
BEGIN SELECT RAISE(ABORT, 'cash_closings is immutable'); END;
CREATE TRIGGER cash_closings_no_delete BEFORE DELETE ON cash_closings
BEGIN SELECT RAISE(ABORT, 'cash_closings is immutable'); END;

-- カードは物理削除しない(論理削除のみ)。QRトークン墓標も消さない
CREATE TRIGGER cards_no_delete BEFORE DELETE ON cards
BEGIN SELECT RAISE(ABORT, 'cards are soft-deleted only'); END;
CREATE TRIGGER token_tombstones_no_delete BEFORE DELETE ON token_tombstones
BEGIN SELECT RAISE(ABORT, 'token_tombstones are permanent'); END;

-- 販売実績のある商品は物理削除しない(アーカイブで除外)
CREATE TRIGGER products_no_delete BEFORE DELETE ON products
BEGIN SELECT RAISE(ABORT, 'products are archived, not deleted'); END;

-- ============================================================
-- 全体管理者向け: 店舗(クラス)別 精算対象額ビュー
-- ============================================================
CREATE VIEW v_shop_settlement AS
SELECT
  s.id                                      AS shop_id,
  s.display_name                            AS shop_name,
  COALESCE(SUM(o.subtotal), 0)              AS gross_before_discount,
  COALESCE(SUM(o.discount_total), 0)        AS discount_total,
  COALESCE(SUM(o.total_paid), 0)            AS paid_total,
  COALESCE(SUM(o.refunded_total), 0)        AS refunded_total,
  COALESCE(SUM(o.total_paid - o.refunded_total), 0) AS net_sales   -- 精算対象額(純売上)
FROM shops s
LEFT JOIN orders o ON o.shop_id = s.id
GROUP BY s.id, s.display_name;
