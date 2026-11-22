import { zv as zValidator } from "../lib/validate";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { MeResponse, WalletSummary } from "@shared/api";
import type { Role } from "@shared/roles";
import type { AppEnv, AuthContext } from "../env";
import { auditStmt } from "../lib/audit";
import { hashPassword, sha256Hex, verifyPassword } from "../lib/crypto";
import { badRequest, conflict, unauthorized } from "../lib/errors";
import { newId } from "../lib/ids";
import { DEFAULT_EXPIRY_POLICY, getExpiryPolicy, resolveExpiry } from "../lib/expiry";
import { buildSessionStmts, clearSessionCookie, deviceLabelFrom, writeSessionCookie } from "../lib/session";
import { isUniqueViolation } from "../lib/users";
import { requireAuth } from "../middleware/auth";
import { emailSchema, nicknameSchema, passwordSchema } from "../lib/validation";

export const RECEPTION_QR_PATTERN = /^FES1:R:[A-Za-z0-9_-]{32}$/;
export const CLERK_QR_PATTERN = /^FES1:C:[A-Za-z0-9_-]{32}$/;

interface MeRow {
  id: string;
  role: Role;
  nickname: string;
  login_id: string | null;
  shop_id: string | null;
  shop_name: string | null;
}

/** ログイン中ユーザーの表示用情報(顧客はウォレットも返す) */
export async function loadMe(db: D1Database, auth: Pick<AuthContext, "userId">): Promise<MeResponse> {
  const row = await db
    .prepare(
      `SELECT u.id, u.role, u.nickname, u.login_id, u.shop_id, s.display_name AS shop_name
         FROM users u LEFT JOIN shops s ON s.id = u.shop_id WHERE u.id = ?`,
    )
    .bind(auth.userId)
    .first<MeRow>();
  if (!row) throw unauthorized();
  let wallet: WalletSummary | null = null;
  if (row.role === "CUSTOMER") {
    const w = await db
      .prepare("SELECT id, balance, status, expires_at FROM wallets WHERE owner_user_id = ?")
      .bind(row.id)
      .first<{ id: string; balance: number; status: WalletSummary["status"]; expires_at: number | null }>();
    if (w) wallet = { id: w.id, balance: w.balance, status: w.status, expiresAt: w.expires_at };
  }
  return {
    user: {
      id: row.id,
      role: row.role,
      nickname: row.nickname,
      loginId: row.login_id,
      shopId: row.shop_id,
      shopName: row.shop_name,
    },
    wallet,
  };
}

/** トークンの先頭(R/C)と、QRを持つユーザーの役割が一致したときだけログインさせる */
async function loginWithQr(c: Context<AppEnv>, token: string) {
  const role: Role | null = RECEPTION_QR_PATTERN.test(token) ? "RECEPTION" : CLERK_QR_PATTERN.test(token) ? "CLERK" : null;
  if (!role) throw unauthorized("ログインQRが無効です", "INVALID_QR");
  const db = c.env.DB;
  const user = await db
    .prepare(
      `SELECT u.id, u.role FROM reception_login_qrs q JOIN users u ON u.id = q.user_id
        WHERE q.token_hash = ? AND q.revoked_at IS NULL AND u.status = 'ACTIVE' AND u.role = ?`,
    )
    .bind(await sha256Hex(token), role)
    .first<{ id: string; role: Role }>();
  if (!user) throw unauthorized("ログインQRが無効、または失効しています", "INVALID_QR");
  const session = await buildSessionStmts(db, user, deviceLabelFrom(c));
  await db.batch([
    ...session.stmts,
    auditStmt(db, {
      actor: { userId: user.id, role: user.role },
      action: role === "CLERK" ? "auth.clerk_qr_login" : "auth.reception_login",
      targetType: "user",
      targetId: user.id,
    }),
  ]);
  writeSessionCookie(c, session.token, user.role);
  return c.json(await loadMe(db, { userId: user.id }));
}

export const authRoutes = new Hono<AppEnv>()
  // 顧客の新規登録(メールアドレスはログインIDとして使うだけ。メール送信・認証はしない)
  .post(
    "/register",
    zValidator("json", z.object({ email: emailSchema, password: passwordSchema, nickname: nicknameSchema })),
    async (c) => {
      const { email, password, nickname } = c.req.valid("json");
      const db = c.env.DB;
      const userId = newId();
      const now = Date.now();
      const passwordHash = await hashPassword(password);
      // 管理者が設定した有効期限(固定日が過ぎている等で決まらないときは、期限なしにせず既定の180日)
      const walletExpiresAt = resolveExpiry(await getExpiryPolicy(db), now) ?? resolveExpiry(DEFAULT_EXPIRY_POLICY, now);
      const session = await buildSessionStmts(db, { id: userId, role: "CUSTOMER" }, deviceLabelFrom(c));
      try {
        await db.batch([
          db
            .prepare(
              `INSERT INTO users (id, role, login_id, password_hash, nickname, status, created_at, created_by)
               VALUES (?, 'CUSTOMER', ?, ?, ?, 'ACTIVE', ?, ?)`,
            )
            .bind(userId, email, passwordHash, nickname, now, userId),
          db
            .prepare("INSERT INTO wallets (id, owner_user_id, balance, status, expires_at, created_at) VALUES (?, ?, 0, 'ACTIVE', ?, ?)")
            .bind(newId(), userId, walletExpiresAt, now),
          auditStmt(db, {
            actor: { userId, role: "CUSTOMER" },
            action: "account.register",
            targetType: "user",
            targetId: userId,
          }),
          ...session.stmts,
        ]);
      } catch (e) {
        if (isUniqueViolation(e, "users.login_id")) throw conflict("このメールアドレスはすでに登録されています", "LOGIN_ID_TAKEN");
        throw e;
      }
      writeSessionCookie(c, session.token, "CUSTOMER");
      return c.json(await loadMe(db, { userId }), 201);
    },
  )
  // ログインID(顧客はメールアドレス)とパスワードでのログイン。全役割が使える。受付担当者は同時1端末のまま
  .post(
    "/login",
    zValidator("json", z.object({ loginId: z.string().trim().min(1).max(200), password: z.string().min(1).max(200) })),
    async (c) => {
      const { loginId, password } = c.req.valid("json");
      const db = c.env.DB;
      const user = await db
        .prepare("SELECT id, role, password_hash, status FROM users WHERE login_id = ?")
        .bind(loginId)
        .first<{ id: string; role: Role; password_hash: string | null; status: string }>();
      const ok = await verifyPassword(password, user?.password_hash ?? null);
      if (!user || !ok || user.status !== "ACTIVE") {
        throw unauthorized("IDまたはパスワードが違います", "INVALID_CREDENTIALS");
      }
      const session = await buildSessionStmts(db, user, deviceLabelFrom(c));
      await db.batch([
        ...session.stmts,
        auditStmt(db, { actor: { userId: user.id, role: user.role }, action: "auth.login", targetType: "user", targetId: user.id }),
      ]);
      writeSessionCookie(c, session.token, user.role);
      return c.json(await loadMe(db, { userId: user.id }));
    },
  )
  // 受付担当者・店員のログインQRでのログイン(`/reception-login` は旧名の別名)。
  // 受付担当者は同じ担当者の古い端末がログアウトされる。店員は複数端末で使える
  .post("/qr-login", zValidator("json", z.object({ token: z.string().trim().max(100) })), (c) =>
    loginWithQr(c, c.req.valid("json").token),
  )
  .post("/reception-login", zValidator("json", z.object({ token: z.string().trim().max(100) })), (c) =>
    loginWithQr(c, c.req.valid("json").token),
  )
  .post("/logout", async (c) => {
    const auth = c.get("auth");
    if (auth) {
      await c.env.DB.batch([
        c.env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(auth.sessionHash),
        auditStmt(c.env.DB, { actor: auth, action: "auth.logout", targetType: "user", targetId: auth.userId }),
      ]);
    }
    clearSessionCookie(c);
    return c.json({ ok: true });
  })
  .get("/me", async (c) => {
    const auth = requireAuth(c);
    return c.json(await loadMe(c.env.DB, auth));
  })
  // 自分のパスワード変更(店員・店舗責任者・全体管理者・顧客)。現在のパスワードが必要
  .post(
    "/change-password",
    zValidator("json", z.object({ currentPassword: z.string().min(1).max(200), newPassword: passwordSchema })),
    async (c) => {
      const auth = requireAuth(c);
      const { currentPassword, newPassword } = c.req.valid("json");
      const row = await c.env.DB.prepare("SELECT password_hash FROM users WHERE id = ?")
        .bind(auth.userId)
        .first<{ password_hash: string | null }>();
      if (!row?.password_hash) throw badRequest("このアカウントはパスワードを使いません");
      if (!(await verifyPassword(currentPassword, row.password_hash))) {
        throw unauthorized("現在のパスワードが違います", "INVALID_CREDENTIALS");
      }
      const hash = await hashPassword(newPassword);
      await c.env.DB.batch([
        c.env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(hash, auth.userId),
        // 他の端末のセッションは破棄し、いまの端末だけ残す
        c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND id_hash <> ?").bind(auth.userId, auth.sessionHash),
        auditStmt(c.env.DB, { actor: auth, action: "account.change_password", targetType: "user", targetId: auth.userId }),
      ]);
      return c.json({ ok: true });
    },
  );
