-- 全体の有効期限(設定は settings.expiry.global)・利用規約/プライバシーポリシー・利用者の自己退会

-- 利用規約・プライバシーポリシー。版ごとに残す(古い版は消さない)。現行版 = kind ごとの最大 version
CREATE TABLE legal_documents (
  kind       TEXT NOT NULL CHECK (kind IN ('TERMS','PRIVACY')),
  version    INTEGER NOT NULL CHECK (version >= 1),
  body_md    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  PRIMARY KEY (kind, version)
);

-- 登録時に同意した版(同意した時点の記録)と、自己退会の日時
ALTER TABLE users ADD COLUMN terms_version INTEGER;
ALTER TABLE users ADD COLUMN privacy_version INTEGER;
ALTER TABLE users ADD COLUMN legal_accepted_at INTEGER;
ALTER TABLE users ADD COLUMN deleted_at INTEGER;
