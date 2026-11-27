#!/usr/bin/env node
// Workers Builds 用のデプロイスクリプト。ダッシュボードの「Variables and secrets(ビルド変数)」に入れた値から、
// D1 の database_id とシークレットを自動で設定してデプロイする。
//
//   D1_DATABASE_ID  任意  D1 の database_id。未設定なら wrangler.jsonc の値をそのまま使う
//   SETUP_TOKEN     任意  設定されていれば Worker のシークレットとして登録する(未設定なら今の値を変えない)
//   PIN_PEPPER      任意  同上。32文字以上。後から変えると全カードPINが無効になる
//   R2_BUCKET_NAME  任意  設定すると、カードデザインの背景画像をR2に保存する(画像は10MBまで)。
//                       そのバケットが無ければ作成し、Worker に IMAGES として結びつける。未設定ならD1に縮小して保存(約0.9MBまで)
//   PBKDF2_ITERATIONS 任意  パスワード・PINのハッシュの反復回数(1000〜100000)。未設定なら 10000(無料プラン向け)
//
// 使い方(Workers Builds の Deploy command): npm run deploy:builds
// 確認だけ(何も変更しない): DRY_RUN=1 node scripts/deploy.mjs
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const DRY = process.env.DRY_RUN === "1";
const CONFIG = "wrangler.jsonc";
const env = (k) => (process.env[k] ?? "").trim();

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}
function run(args, input) {
  console.log(`$ npx wrangler ${args.join(" ")}`);
  if (DRY) return;
  const r = spawnSync("npx", ["wrangler", ...args], { stdio: [input === undefined ? "inherit" : "pipe", "inherit", "inherit"], input, env: process.env });
  if (r.status !== 0) fail(`wrangler ${args[0]} が失敗しました`);
}

// 1) database_id を、ビルド変数の値で差し替える(ビルド用の作業コピーだけが変わる)
const dbId = env("D1_DATABASE_ID");
let config = readFileSync(CONFIG, "utf8");
if (dbId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(dbId)) fail("D1_DATABASE_ID の形式が正しくありません(UUID)");
  const next = config.replace(/("database_id"\s*:\s*")[^"]*(")/, `$1${dbId}$2`);
  if (next === config && !config.includes(dbId)) fail(`${CONFIG} に database_id が見つかりません`);
  config = next;
  if (!DRY) writeFileSync(CONFIG, config);
  console.log("✓ database_id をビルド変数 D1_DATABASE_ID から設定しました");
} else {
  const cur = /"database_id"\s*:\s*"([^"]*)"/.exec(config)?.[1] ?? "";
  if (!cur || /^0+(-0+)*$/.test(cur)) fail("database_id が未設定です。ビルド変数 D1_DATABASE_ID を設定してください");
  console.log(`✓ database_id は ${CONFIG} の値を使います`);
}

// 1b) R2(任意): ビルド変数 R2_BUCKET_NAME があるときだけ、背景画像の保存先として結びつける
const bucket = env("R2_BUCKET_NAME");
if (bucket) {
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) fail("R2_BUCKET_NAME は、小文字・数字・ハイフンの3〜63文字にしてください");
  if (!config.includes('"r2_buckets"')) {
    config = config.replace(/(\n\s*)"d1_databases"/, `$1"r2_buckets": [{ "binding": "IMAGES", "bucket_name": "${bucket}" }],$1"d1_databases"`);
    if (!config.includes('"r2_buckets"')) fail(`${CONFIG} に r2_buckets を追加できませんでした`);
    if (!DRY) writeFileSync(CONFIG, config);
  }
  // バケットが無ければ作る(すでにあるときの失敗は無視する)
  console.log(`$ npx wrangler r2 bucket create ${bucket}`);
  if (!DRY) {
    const r = spawnSync("npx", ["wrangler", "r2", "bucket", "create", bucket], { encoding: "utf8", env: process.env });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    if (r.status !== 0 && !/already exists|10004/i.test(out)) {
      console.error(out);
      fail("R2バケットを作れませんでした(R2が有効か、APIトークンの権限を確認してください)");
    }
  }
  console.log(`✓ 背景画像の保存先: R2 バケット ${bucket}`);
} else {
  console.log("✓ 背景画像の保存先: D1(R2を使うにはビルド変数 R2_BUCKET_NAME を設定)");
}

// 2) シークレットの検証(デプロイ前に、足りない・短い値を止める)
const secrets = {};
if (env("SETUP_TOKEN")) secrets.SETUP_TOKEN = env("SETUP_TOKEN");
if (env("PIN_PEPPER")) {
  if (env("PIN_PEPPER").length < 32) fail("PIN_PEPPER は32文字以上にしてください");
  secrets.PIN_PEPPER = env("PIN_PEPPER");
}
console.log(`✓ シークレット: ${Object.keys(secrets).join("、") || "(ビルド変数なし。Worker の既存の値をそのまま使います)"}`);

// 3) マイグレーション → デプロイ → シークレット登録
run(["d1", "migrations", "apply", "DB", "--remote"]);
const iter = env("PBKDF2_ITERATIONS");
if (iter && !(Number.isInteger(Number(iter)) && Number(iter) >= 1000 && Number(iter) <= 100000)) fail("PBKDF2_ITERATIONS は 1000〜100000 の整数にしてください");
run(iter ? ["deploy", "--var", `PBKDF2_ITERATIONS:${iter}`] : ["deploy"]);
if (Object.keys(secrets).length > 0) {
  // 値は標準入力で渡す(コマンドラインやログに出さない)。Worker が作られた後に登録する
  run(["secret", "bulk"], JSON.stringify(secrets));
}
console.log(DRY ? "(DRY_RUN: 何も実行していません)" : "✓ 完了");
