-- 受付(チャージ・払戻し・現金台帳)のための追加スキーマ
--
-- * wallet_lookups: 受付担当者が顧客のQRを読み取った結果。チャージ・払戻しはこの読み取りIDに対して行う。
--   読み取った担当者本人だけが、有効時間内(既定5分)に使える。QR自体は読み取り時点で消費済み。
-- * cash_events.request_id: 現金イベントの二重登録防止(同じリクエストの再送は新しい記録を作らない)

CREATE TABLE wallet_lookups (
  id                TEXT PRIMARY KEY,
  wallet_id         TEXT NOT NULL REFERENCES wallets(id),
  reception_user_id TEXT NOT NULL REFERENCES users(id),
  created_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL
);
CREATE INDEX idx_wallet_lookups_user ON wallet_lookups(reception_user_id, created_at);

ALTER TABLE cash_events ADD COLUMN request_id TEXT;
CREATE UNIQUE INDEX uq_cash_events_request ON cash_events(request_id) WHERE request_id IS NOT NULL;

-- 金額の単位(重要):
--   wallet_ledger.amount / balance_after ... ポイント(通貨単位)
--   cash_events.amount                   ... 円(受け取った/渡した現金)
