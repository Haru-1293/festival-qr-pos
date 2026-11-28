-- メール送信の設定(メイン・サブの2枠)と、パスワード再設定

-- 送信元アカウント。資格情報(パスワード・クライアントシークレット・リフレッシュトークン)は secret_sealed に暗号化して入れる
CREATE TABLE mail_accounts (
  slot            TEXT PRIMARY KEY CHECK (slot IN ('PRIMARY','SUB')),
  provider        TEXT NOT NULL CHECK (provider IN ('GOOGLE','MICROSOFT','SMTP')),
  auth            TEXT NOT NULL CHECK (auth IN ('OAUTH2','PASSWORD')),
  from_address    TEXT NOT NULL,
  from_name       TEXT,
  username        TEXT,
  host            TEXT,
  port            INTEGER,
  security        TEXT CHECK (security IN ('SSL','STARTTLS','NONE')),
  client_id       TEXT,
  tenant          TEXT,
  auth_url        TEXT,
  token_url       TEXT,
  scope           TEXT,
  secret_sealed   TEXT,
  authorized_at   INTEGER,
  last_status     TEXT CHECK (last_status IN ('OK','ERROR')),
  last_error      TEXT,
  last_used_at    INTEGER,
  updated_at      INTEGER NOT NULL,
  updated_by      TEXT
);

-- OAuth2 の認可フロー中の state(10分で失効・1回だけ使える)
CREATE TABLE mail_oauth_states (
  state_hash TEXT PRIMARY KEY,
  slot       TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- パスワード再設定URLのトークン(ハッシュだけ保存。1時間・1回だけ)
CREATE TABLE password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);
CREATE INDEX idx_password_resets_user ON password_resets(user_id, created_at);

-- 全体管理者のパスワード再設定用メールアドレス
ALTER TABLE users ADD COLUMN recovery_email TEXT;
