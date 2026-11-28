import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { auditStmt } from "../lib/audit";
import { hashPassword, randomToken, sha256Hex } from "../lib/crypto";
import { badRequest } from "../lib/errors";
import { mailConfigured, sendMail } from "../lib/mail";
import { SETTING_KEYS, getFestivalName, getSetting } from "../lib/settings";
import { passwordSchema } from "../lib/validation";
import { zv as zValidator } from "../lib/validate";
import { baseUrl } from "./adminMail";

/** 再設定URLの有効時間(1時間) */
export const RESET_TTL_MS = 60 * 60_000;
/** 同じアカウントへの再送の間隔と、1時間あたりの上限(メール爆撃・不正利用の対策) */
const RESEND_GAP_MS = 60_000;
const HOURLY_MAX = 5;

export async function customerResetEnabled(db: D1Database): Promise<boolean> {
  return getSetting<boolean>(db, SETTING_KEYS.passwordReset, true);
}

/**
 * パスワード再設定(ログイン不要)。お客様は登録メールアドレス宛て、全体管理者は登録した再設定用メールアドレス宛て。
 * 店員・店舗責任者・受付は対象外(全体管理者・店舗責任者が再設定する)。
 * アカウントの有無が分からないよう、依頼には常に同じ応答を返す。
 */
export const passwordResetRoutes = new Hono<AppEnv>()
  .post("/request", zValidator("json", z.object({ loginId: z.string().trim().min(1).max(200) })), async (c) => {
    const { loginId } = c.req.valid("json");
    const db = c.env.DB;
    const reply = () => c.json({ ok: true });
    const user = await db
      .prepare("SELECT id, role, login_id, recovery_email FROM users WHERE login_id = ? AND status = 'ACTIVE' AND role IN ('CUSTOMER','ADMIN')")
      .bind(loginId)
      .first<{ id: string; role: "CUSTOMER" | "ADMIN"; login_id: string; recovery_email: string | null }>();
    if (!user) return reply();
    if (user.role === "CUSTOMER" && !(await customerResetEnabled(db))) return reply();
    const to = user.role === "CUSTOMER" ? user.login_id : user.recovery_email;
    if (!to || !to.includes("@") || !(await mailConfigured(db))) return reply();

    const now = Date.now();
    const recent = await db
      .prepare("SELECT COUNT(*) AS n, MAX(created_at) AS last FROM password_resets WHERE user_id = ? AND created_at > ?")
      .bind(user.id, now - 60 * 60_000)
      .first<{ n: number; last: number | null }>();
    if ((recent?.n ?? 0) >= HOURLY_MAX || (recent?.last ?? 0) > now - RESEND_GAP_MS) return reply();

    const token = randomToken(32);
    await db.batch([
      // 前に出した未使用のURLは、新しいものを出した時点で使えなくする
      db.prepare("UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL").bind(now, user.id),
      db.prepare("INSERT INTO password_resets (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").bind(await sha256Hex(token), user.id, now, now + RESET_TTL_MS),
      auditStmt(db, { actor: null, action: "auth.password_reset_request", targetType: "user", targetId: user.id }),
    ]);
    const url = `${await baseUrl(db, c.req.url)}/reset-password?token=${token}`;
    const festival = await getFestivalName(db);
    // 送信の完了を待たせない(待つとアカウントの有無が応答時間で分かってしまう)
    c.executionCtx.waitUntil(
      (async () => {
        const r = await sendMail(c.env, user.role === "ADMIN" ? "ADMIN" : "CUSTOMER", {
          to,
          subject: `【${festival}】パスワード再設定のご案内`,
          text: [
            `${festival} のパスワード再設定のご依頼を受け付けました。`,
            "",
            "下のURLから、新しいパスワードを設定してください。",
            url,
            "",
            "このURLは発行から1時間だけ有効で、1回しか使えません。",
            "心当たりがない場合は、このメールを破棄してください(パスワードは変わりません)。",
          ].join("\n"),
        });
        await db
          .batch([auditStmt(db, { actor: null, action: r.ok ? "auth.password_reset_mail_sent" : "auth.password_reset_mail_failed", targetType: "user", targetId: user.id, after: { via: r.via, error: r.error } })])
          .catch(() => undefined);
      })(),
    );
    return reply();
  })

  .post("/confirm", zValidator("json", z.object({ token: z.string().min(20).max(200), newPassword: passwordSchema })), async (c) => {
    const { token, newPassword } = c.req.valid("json");
    const db = c.env.DB;
    const hash = await sha256Hex(token);
    const now = Date.now();
    const row = await db
      .prepare(
        `SELECT r.user_id FROM password_resets r JOIN users u ON u.id = r.user_id
          WHERE r.token_hash = ? AND r.used_at IS NULL AND r.expires_at > ? AND u.status = 'ACTIVE' AND u.role IN ('CUSTOMER','ADMIN')`,
      )
      .bind(hash, now)
      .first<{ user_id: string }>();
    const bad = () => badRequest("このURLは無効か、有効期限(1時間)が切れています。もう一度、再設定をご依頼ください", "RESET_TOKEN_INVALID");
    if (!row) throw bad();
    const pw = await hashPassword(newPassword);
    const valid = "SELECT 1 FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?";
    // 「まだ使われていない」確認とパスワードの更新を同じ batch で行い、同時に2回使われても1回しか通らないようにする
    const [upd] = await db.batch([
      db.prepare(`UPDATE users SET password_hash = ? WHERE id = ? AND EXISTS (${valid})`).bind(pw, row.user_id, hash, now),
      db.prepare("UPDATE password_resets SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?").bind(now, hash, now),
    ]);
    if ((upd!.meta.changes ?? 0) !== 1) throw bad();
    await db.batch([
      // すべての端末のログインを終わらせる
      db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(row.user_id),
      db.prepare("UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL").bind(now, row.user_id),
      auditStmt(db, { actor: null, action: "auth.password_reset_done", targetType: "user", targetId: row.user_id }),
    ]);
    return c.json({ ok: true });
  });

