import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { auditStmt } from "../lib/audit";
import { randomToken, sha256Hex, verifyPassword } from "../lib/crypto";
import { badRequest, notFound, unauthorized } from "../lib/errors";
import { loadAccounts, openSecret, sealSecret, sendViaAccount, type MailAccountRow, type MailSecret, type MailSlot } from "../lib/mail";
import { buildAuthUrl, exchangeCode } from "../lib/oauth";
import { SETTING_KEYS, getSetting, setSettingStmt } from "../lib/settings";
import { vaultSecret } from "../lib/vault";
import { emailSchema } from "../lib/validation";
import { zv as zValidator } from "../lib/validate";
import { requireAuth, requireRole } from "../middleware/auth";

const slotParam = zValidator("param", z.object({ slot: z.enum(["PRIMARY", "SUB"]) }));

/** https、または手元の検証用の http://localhost / 127.0.0.1 だけ許す */
const urlSchema = z
  .string()
  .trim()
  .max(500)
  .url()
  .refine((u) => /^https:\/\//i.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(u), "https のURLを入力してください");
const hostSchema = z.string().trim().min(1).max(255).regex(/^[A-Za-z0-9.-]+$/, "ホスト名の形式が正しくありません");
const opt = <T extends z.ZodTypeAny>(s: T) => s.nullable().optional();

const accountSchema = z.object({
  provider: z.enum(["GOOGLE", "MICROSOFT", "SMTP"]),
  auth: z.enum(["OAUTH2", "PASSWORD"]),
  fromAddress: emailSchema,
  fromName: opt(z.string().trim().max(60)),
  username: opt(z.string().trim().max(200)),
  host: opt(hostSchema),
  port: opt(z.number().int().min(1).max(65535)),
  security: opt(z.enum(["SSL", "STARTTLS", "NONE"])),
  clientId: opt(z.string().trim().max(300)),
  tenant: opt(z.string().trim().max(100).regex(/^[A-Za-z0-9._-]*$/, "テナントの形式が正しくありません")),
  authUrl: opt(urlSchema),
  tokenUrl: opt(urlSchema),
  scope: opt(z.string().trim().max(500)),
  /** 空・省略なら、保存済みの値を使い続ける */
  password: opt(z.string().max(500)),
  clientSecret: opt(z.string().max(500)),
});

const blank = (v: string | null | undefined) => (v ? v : null);

export function publicView(a: MailAccountRow, secret: MailSecret) {
  return {
    slot: a.slot,
    provider: a.provider,
    auth: a.auth,
    fromAddress: a.from_address,
    fromName: a.from_name,
    username: a.username,
    host: a.host,
    port: a.port,
    security: a.security,
    clientId: a.client_id,
    tenant: a.tenant,
    authUrl: a.auth_url,
    tokenUrl: a.token_url,
    scope: a.scope,
    hasPassword: !!secret.password,
    hasClientSecret: !!secret.clientSecret,
    authorizedAt: a.authorized_at,
    lastStatus: a.last_status,
    lastError: a.last_error,
    lastUsedAt: a.last_used_at,
    updatedAt: a.updated_at,
  };
}

/** メールの基準URL(再設定リンクとOAuth2の戻り先)。設定があればそれ、なければ今のアクセス先 */
export async function baseUrl(db: D1Database, requestUrl: string): Promise<string> {
  const saved = await getSetting<string>(db, SETTING_KEYS.publicBaseUrl, "");
  return (saved || new URL(requestUrl).origin).replace(/\/+$/, "");
}

/** 全体管理者だけ: メール送信の設定(メイン・サブ)、パスワード再設定のオンオフ、再設定用メールアドレス */
export const adminMailRoutes = new Hono<AppEnv>()
  // OAuth2の戻り先(ブラウザが移動してくる。管理者のログインが必要)
  .get("/oauth/callback", requireRole("ADMIN"), async (c) => {
    const auth = requireAuth(c);
    const db = c.env.DB;
    const q = c.req.query();
    const done = (r: string) => c.redirect(`/admin/mail?oauth=${encodeURIComponent(r)}`);
    if (!q.state) return done("error");
    const hash = await sha256Hex(q.state);
    const st = await db.prepare("DELETE FROM mail_oauth_states WHERE state_hash = ? RETURNING slot, user_id, expires_at").bind(hash).first<{ slot: MailSlot; user_id: string; expires_at: number }>();
    if (!st || st.user_id !== auth.userId || st.expires_at < Date.now()) return done("expired");
    if (q.error || !q.code) return done("denied");
    const a = (await loadAccounts(db)).find((r) => r.slot === st.slot);
    if (!a || a.auth !== "OAUTH2") return done("error");
    const secret = await openSecret(c.env, a);
    if (!secret.clientSecret) return done("error");
    try {
      const refresh = await exchangeCode(a, secret.clientSecret, q.code, `${await baseUrl(db, c.req.url)}/api/admin/mail/oauth/callback`);
      const sealed = await sealSecret(c.env, { ...secret, refreshToken: refresh });
      await db.batch([
        db.prepare("UPDATE mail_accounts SET secret_sealed = ?, authorized_at = ?, last_status = NULL, last_error = NULL WHERE slot = ?").bind(sealed, Date.now(), st.slot),
        auditStmt(db, { actor: auth, action: "mail.oauth_authorized", targetType: "mail_account", targetId: st.slot }),
      ]);
    } catch (e) {
      await db.prepare("UPDATE mail_accounts SET last_status = 'ERROR', last_error = ? WHERE slot = ?").bind(e instanceof Error ? e.message : "認可に失敗しました", st.slot).run();
      return done("error");
    }
    return done("ok");
  })
  .use("*", requireRole("ADMIN"))

  .get("/", async (c) => {
    const auth = requireAuth(c);
    const db = c.env.DB;
    const rows = await loadAccounts(db);
    const accounts = await Promise.all(rows.map(async (a) => publicView(a, await openSecret(c.env, a))));
    const me = await db.prepare("SELECT recovery_email FROM users WHERE id = ?").bind(auth.userId).first<{ recovery_email: string | null }>();
    const base = await baseUrl(db, c.req.url);
    return c.json({
      accounts,
      vaultReady: vaultSecret(c.env) !== null,
      passwordResetEnabled: await getSetting<boolean>(db, SETTING_KEYS.passwordReset, true),
      publicBaseUrl: await getSetting<string>(db, SETTING_KEYS.publicBaseUrl, ""),
      redirectUri: `${base}/api/admin/mail/oauth/callback`,
      recoveryEmail: me?.recovery_email ?? null,
    });
  })

  .put("/settings", zValidator("json", z.object({ passwordResetEnabled: z.boolean(), publicBaseUrl: z.string().trim().max(200).refine((u) => u === "" || /^https?:\/\/[^\s/]+$/i.test(u), "https://example.com の形式で入力してください(末尾に / は付けません)") })), async (c) => {
    const auth = requireAuth(c);
    const b = c.req.valid("json");
    const db = c.env.DB;
    await db.batch([
      setSettingStmt(db, SETTING_KEYS.passwordReset, b.passwordResetEnabled, auth.userId),
      setSettingStmt(db, SETTING_KEYS.publicBaseUrl, b.publicBaseUrl.replace(/\/+$/, ""), auth.userId),
      auditStmt(db, { actor: auth, action: "settings.password_reset", targetType: "settings", targetId: SETTING_KEYS.passwordReset, after: { enabled: b.passwordResetEnabled, publicBaseUrl: b.publicBaseUrl } }),
    ]);
    return c.json({ ok: true });
  })

  // 全体管理者自身の、パスワード再設定用メールアドレス(変更・解除は現在のパスワードが必要)
  .put("/recovery-email", zValidator("json", z.object({ email: emailSchema.nullable(), currentPassword: z.string().min(1).max(200) })), async (c) => {
    const auth = requireAuth(c);
    const db = c.env.DB;
    const { email, currentPassword } = c.req.valid("json");
    const row = await db.prepare("SELECT password_hash, recovery_email FROM users WHERE id = ?").bind(auth.userId).first<{ password_hash: string | null; recovery_email: string | null }>();
    if (!row || !(await verifyPassword(currentPassword, row.password_hash))) throw unauthorized("現在のパスワードが違います", "INVALID_CREDENTIALS");
    await db.batch([
      db.prepare("UPDATE users SET recovery_email = ? WHERE id = ?").bind(email, auth.userId),
      auditStmt(db, { actor: auth, action: "admin.recovery_email", targetType: "user", targetId: auth.userId, before: { set: row.recovery_email !== null }, after: { set: email !== null } }),
    ]);
    return c.json({ ok: true });
  })

  .put("/accounts/:slot", slotParam, zValidator("json", accountSchema), async (c) => {
    const auth = requireAuth(c);
    const { slot } = c.req.valid("param");
    const b = c.req.valid("json");
    const db = c.env.DB;
    if (!vaultSecret(c.env)) throw badRequest("資格情報を暗号化して保存するため、シークレット PIN_PEPPER(16文字以上)の設定が必要です", "VAULT_NOT_READY");
    const cur = (await loadAccounts(db)).find((r) => r.slot === slot);
    const curSecret = cur ? await openSecret(c.env, cur) : {};

    const next = {
      provider: b.provider,
      auth: b.auth,
      from_address: b.fromAddress,
      from_name: blank(b.fromName),
      username: blank(b.username),
      host: b.provider === "SMTP" ? blank(b.host) : null,
      port: b.provider === "SMTP" ? (b.port ?? null) : null,
      security: b.provider === "SMTP" ? (b.security ?? null) : null,
      client_id: b.auth === "OAUTH2" ? blank(b.clientId) : null,
      tenant: b.auth === "OAUTH2" && b.provider === "MICROSOFT" ? blank(b.tenant) : null,
      auth_url: b.auth === "OAUTH2" && b.provider === "SMTP" ? blank(b.authUrl) : null,
      token_url: b.auth === "OAUTH2" && b.provider === "SMTP" ? blank(b.tokenUrl) : null,
      scope: b.auth === "OAUTH2" && b.provider === "SMTP" ? blank(b.scope) : null,
    };
    if (b.provider === "SMTP" && (!next.host || !next.port || !next.security)) throw badRequest("SMTPのホスト・ポート・暗号化方式を入力してください");
    if (b.provider === "SMTP" && b.auth === "OAUTH2" && (!next.auth_url || !next.token_url)) throw badRequest("認可URLとトークンURLを入力してください");

    const secret: MailSecret = {};
    let reauthorize = false;
    if (b.auth === "PASSWORD") {
      secret.password = b.password || curSecret.password;
      if (!secret.password) throw badRequest(b.provider === "GOOGLE" ? "アプリパスワードを入力してください" : "パスワードを入力してください");
      if (!(next.username ?? b.fromAddress)) throw badRequest("ユーザー名を入力してください");
    } else {
      if (!next.client_id) throw badRequest("クライアントIDを入力してください");
      secret.clientSecret = b.clientSecret || curSecret.clientSecret;
      if (!secret.clientSecret) throw badRequest("クライアントシークレットを入力してください");
      // 接続先・クライアントが変わったら、これまでの認可は使えないのでやり直し
      const same =
        cur && cur.auth === "OAUTH2" && cur.provider === b.provider && cur.client_id === next.client_id && cur.tenant === next.tenant && cur.auth_url === next.auth_url && cur.token_url === next.token_url && cur.scope === next.scope && !b.clientSecret;
      if (same && curSecret.refreshToken) secret.refreshToken = curSecret.refreshToken;
      else reauthorize = true;
    }
    const sealed = await sealSecret(c.env, secret);
    const now = Date.now();
    const authorizedAt = b.auth === "OAUTH2" && !reauthorize ? (cur?.authorized_at ?? null) : null;
    await db.batch([
      db
        .prepare(
          `INSERT INTO mail_accounts (slot, provider, auth, from_address, from_name, username, host, port, security, client_id, tenant, auth_url, token_url, scope, secret_sealed, authorized_at, last_status, last_error, updated_at, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
           ON CONFLICT(slot) DO UPDATE SET provider=excluded.provider, auth=excluded.auth, from_address=excluded.from_address, from_name=excluded.from_name, username=excluded.username,
             host=excluded.host, port=excluded.port, security=excluded.security, client_id=excluded.client_id, tenant=excluded.tenant, auth_url=excluded.auth_url, token_url=excluded.token_url,
             scope=excluded.scope, secret_sealed=excluded.secret_sealed, authorized_at=excluded.authorized_at, last_status=NULL, last_error=NULL, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
        )
        .bind(slot, next.provider, next.auth, next.from_address, next.from_name, next.username, next.host, next.port, next.security, next.client_id, next.tenant, next.auth_url, next.token_url, next.scope, sealed, authorizedAt, now, auth.userId),
      auditStmt(db, {
        actor: auth,
        action: "mail.account_save",
        targetType: "mail_account",
        targetId: slot,
        before: cur ? { provider: cur.provider, auth: cur.auth, from: cur.from_address } : null,
        after: { provider: next.provider, auth: next.auth, from: next.from_address },
      }),
    ]);
    return c.json({ ok: true, needsAuthorization: b.auth === "OAUTH2" && reauthorize });
  })

  .delete("/accounts/:slot", slotParam, async (c) => {
    const auth = requireAuth(c);
    const { slot } = c.req.valid("param");
    const db = c.env.DB;
    const cur = await db.prepare("SELECT from_address FROM mail_accounts WHERE slot = ?").bind(slot).first<{ from_address: string }>();
    if (!cur) throw notFound("登録されていません");
    await db.batch([
      db.prepare("DELETE FROM mail_accounts WHERE slot = ?").bind(slot),
      auditStmt(db, { actor: auth, action: "mail.account_delete", targetType: "mail_account", targetId: slot, before: { from: cur.from_address } }),
    ]);
    return c.json({ ok: true });
  })

  // この枠だけで試し送りする(フォールバックはしない)
  .post("/accounts/:slot/test", slotParam, zValidator("json", z.object({ to: emailSchema })), async (c) => {
    const auth = requireAuth(c);
    const { slot } = c.req.valid("param");
    const { to } = c.req.valid("json");
    const db = c.env.DB;
    const a = (await loadAccounts(db)).find((r) => r.slot === slot);
    if (!a) throw notFound("登録されていません");
    let error: string | null = null;
    try {
      await sendViaAccount(c.env, a, { to, subject: "【テスト】メール送信の確認", text: "このメールは、メール送信の設定の確認のために送りました。届いていれば設定は正しく動いています。" });
    } catch (e) {
      error = e instanceof Error ? e.message : "送信に失敗しました";
    }
    await db.batch([
      db.prepare("UPDATE mail_accounts SET last_status = ?, last_error = ?, last_used_at = ? WHERE slot = ?").bind(error === null ? "OK" : "ERROR", error, Date.now(), slot),
      auditStmt(db, { actor: auth, action: "mail.test_send", targetType: "mail_account", targetId: slot, after: { ok: error === null } }),
    ]);
    return c.json({ ok: error === null, error });
  })

  // OAuth2の認可を始める(返ったURLへブラウザを移動させる)
  .post("/accounts/:slot/oauth/start", slotParam, async (c) => {
    const auth = requireAuth(c);
    const { slot } = c.req.valid("param");
    const db = c.env.DB;
    const a = (await loadAccounts(db)).find((r) => r.slot === slot);
    if (!a || a.auth !== "OAUTH2") throw badRequest("OAuth2のアカウントを先に保存してください");
    const state = randomToken(24);
    await db.batch([
      db.prepare("DELETE FROM mail_oauth_states WHERE expires_at < ?").bind(Date.now()),
      db.prepare("INSERT INTO mail_oauth_states (state_hash, slot, user_id, expires_at) VALUES (?, ?, ?, ?)").bind(await sha256Hex(state), slot, auth.userId, Date.now() + 10 * 60_000),
    ]);
    return c.json({ url: buildAuthUrl(a, `${await baseUrl(db, c.req.url)}/api/admin/mail/oauth/callback`, state) });
  });
