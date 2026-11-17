# festival-qr-pos

学園祭向けの独自QR決済・POS統合システム。来場者が受付でチャージし、各店舗のPOSでQR決済する。

- 構成:Cloudflare Workers + D1 / Hono / Vite + React + shadcn/ui + Tailwind / PWA
- デプロイ:Cloudflare Workers Builds(GitHub 連携)

## ドキュメント

| 文書 | 内容 |
|---|---|
| [docs/spec/v0.2.md](docs/spec/v0.2.md) | 元の機能・運用仕様書 |
| [docs/spec/v0.3-changes.md](docs/spec/v0.3-changes.md) | v0.2 からの変更点・決定事項・仮定(**v0.2 より優先**) |
| [migrations/0001_init.sql](migrations/0001_init.sql) | D1 の初期スキーマ(データモデル) |

## 状態

仕様確定とデータモデルの段階。アプリ本体は未実装(次の作業は `docs/spec/v0.3-changes.md` §4)。
