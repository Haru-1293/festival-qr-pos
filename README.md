# festival-qr-pos

学園祭向けの独自QR決済・POS統合システム。来場者が受付でチャージし、各店舗のPOSでQR決済する。

- 構成:Cloudflare Workers + D1 / Hono / Vite + React + shadcn/ui + Tailwind
- デプロイ:Cloudflare Workers Builds(GitHub 連携)

## ドキュメント

| 文書 | 内容 |
|---|---|
| [docs/spec/v0.2.md](docs/spec/v0.2.md) | 元の機能・運用仕様書 |
| [docs/spec/v0.3-changes.md](docs/spec/v0.3-changes.md) | v0.2 からの変更点・決定事項・仮定(**v0.2 より優先**) |
| [migrations/0001_init.sql](migrations/0001_init.sql) | D1 の初期スキーマ(データモデル) |

## 役割

| 役割 | 値 | ログイン方法 |
|---|---|---|
| 全体管理者 | `ADMIN` | ログインID + パスワード |
| 店舗責任者 | `SHOP_MANAGER` | ログインID + パスワード(全体管理者が登録) |
| 店員 | `CLERK` | ログインID + パスワード(店舗責任者が登録) |
| 受付担当者 | `RECEPTION` | 担当者ごとの恒久ログインQR(同時ログインは1端末のみ) |
| 顧客 | `CUSTOMER` | メールアドレス(=ログインID) + パスワード |

パスワードを忘れた場合は、全体管理者(店員は店舗責任者も可)が再設定する。メールは送信しない。

## 実装状況

| 区分 | 状態 |
|---|---|
| 認証・セッション・権限(サーバー側の役割確認)・監査ログ | 実装済み |
| 初回セットアップ(最初の全体管理者) | 実装済み |
| 店舗・店舗責任者・店員・受付担当者の管理、受付・店員のログインQR(発行/再発行/失効)、店員のID変更 | 実装済み |
| パスワード再設定、利用停止、通貨表示・学園祭名の設定 | 実装済み |
| 顧客の登録・ログイン・残高表示 | 実装済み |
| 顧客の提示用QR(読み取りで消費・有効時間は設定可) | 実装済み |
| 受付(チャージ・払戻し・訂正・途中回収・現金の締め) | 実装済み |
| 物理カード(発行・有効化・PIN・停止・削除・再発行・カード決済) | 実装済み |
| 商品・タグ・在庫、手動売り切れ、定価の一律値下げ(リアルタイム反映)、店員のレジ画面(商品一覧) | 実装済み |
| カート・会計・スマホQR決済(決済セッション・冪等・原子的更新・価格の再計算) | 実装済み |
| セット商品 | 実装済み |
| 返金・利用履歴 | 実装済み(店舗責任者の画面。管理者用タブは未) |
| 割引・クーポン | 未実装 |
| 売上・精算ビュー、監査ログ画面、CSV、緊急停止 | 未実装 |
| PWA(マニフェスト・オフライン時の画面キャッシュ) | 未実装 |

## 開発

```bash
npm install
cp .dev.vars.example .dev.vars   # ローカル用の秘密値(Git には入らない)
npm run db:migrate:local         # ローカル D1 にスキーマを適用
npm run dev                      # 開発サーバー(Vite + workerd)
npm run typecheck
```

初回セットアップは `http://localhost:5173/setup` を開き、`.dev.vars` の `SETUP_TOKEN` を入力して最初の全体管理者を作る。

## 本番へのデプロイ(Workers Builds)

1. D1 を作る:`npx wrangler d1 create festival-qr-pos` を実行し、表示された `database_id` を `wrangler.jsonc` に書く。
2. Cloudflare ダッシュボードの **Workers & Pages → Create → Import a repository** でこのリポジトリを接続する。
   - Build command: `npm run build`
   - Deploy command: `npx wrangler d1 migrations apply DB --remote && npx wrangler deploy`
3. Worker の **Settings → Variables and Secrets** に次を**シークレット**として登録する。

   | 名前 | 内容 |
   |---|---|
   | `SETUP_TOKEN` | 最初の全体管理者を作るときだけ使うトークン。作成後は削除してよい |
   | `PIN_PEPPER` | 物理カードPINのハッシュに混ぜる32文字以上のランダム文字列。**後から変えるとPINが全て無効になる** |
4. デプロイ後に `/setup` を開き、全体管理者を作る。

## セキュリティ上の設計メモ

- パスワードは PBKDF2(SHA-256, 100,000回)。セッションIDと受付ログインQRのトークンは SHA-256 のハッシュだけをDBに保存する。
- 状態を変える API は同一オリジンの `Origin` ヘッダーを検査する(Cookie は `HttpOnly` / `SameSite=Lax`)。
- 受付ログインQRは担当者ごとに1枚。再発行・失効で古いQRは即時に使えなくなり、その担当者のセッションも破棄される。トークンは過去分を含め再利用しない(`token_tombstones`)。
- 監査ログにはパスワード・PIN・生のQRトークンを保存しない。履歴系テーブルは DB のトリガで更新・削除を禁止している。
