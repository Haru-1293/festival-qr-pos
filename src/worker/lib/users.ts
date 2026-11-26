import { openText, sealText } from "./vault";
import type { UserDto } from "@shared/api";
import type { Role } from "@shared/roles";
import type { AuthContext } from "../env";
import { auditStmt } from "./audit";
import { randomToken, sha256Hex } from "./crypto";
import { conflict } from "./errors";
import { newId } from "./ids";

export function isUniqueViolation(e: unknown, column: string): boolean {
  return e instanceof Error && e.message.includes("UNIQUE constraint failed") && e.message.includes(column);
}

interface NewStaff {
  role: "CLERK" | "SHOP_MANAGER" | "ADMIN";
  shopId: string | null;
  loginId: string;
  passwordHash: string;
  nickname: string;
}

/** 店員・店舗責任者・全体管理者を作成する(ログインID重複は 409) */
export async function createStaffUser(db: D1Database, actor: AuthContext, s: NewStaff): Promise<string> {
  const id = newId();
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO users (id, role, login_id, password_hash, nickname, shop_id, status, created_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
        )
        .bind(id, s.role, s.loginId, s.passwordHash, s.nickname, s.shopId, Date.now(), actor.userId),
      auditStmt(db, {
        actor,
        action: "user.create",
        targetType: "user",
        targetId: id,
        after: { role: s.role, loginId: s.loginId, nickname: s.nickname, shopId: s.shopId },
      }),
    ]);
  } catch (e) {
    if (isUniqueViolation(e, "users.login_id")) throw conflict("このログインIDはすでに使われています", "LOGIN_ID_TAKEN");
    throw e;
  }
  return id;
}

export const RECEPTION_QR_PREFIX = "FES1:R:";
export const CLERK_QR_PREFIX = "FES1:C:";

/** ログインQRを使える役割(受付担当者・店員)。トークンの先頭で役割を区別する */
export const LOGIN_QR_PREFIX = { RECEPTION: RECEPTION_QR_PREFIX, CLERK: CLERK_QR_PREFIX } as const;

/**
 * 受付担当者・店員のログインQRを(再)発行する SQL 文と生トークン。
 * テーブル名・墓標の種別は受付用の名前のままだが、店員のQRも同じ仕組みで扱う。
 * 既存の有効QRは失効し、そのユーザーの全セッションを破棄する。
 * 生トークンは呼び出し元がレスポンスで1回だけ返し、DB・ログには残さない。
 */
export async function buildLoginQrIssue(
  db: D1Database,
  actor: AuthContext,
  userId: string,
  role: keyof typeof LOGIN_QR_PREFIX,
  reason: string | null,
  secret: string | null = null,
): Promise<{ token: string; stmts: D1PreparedStatement[] }> {
  const token = `${LOGIN_QR_PREFIX[role]}${randomToken(24)}`;
  const hash = await sha256Hex(token);
  const sealed = await sealText(secret, token); // 何度でも表示できるよう、暗号化して保存する
  const now = Date.now();
  return {
    token,
    stmts: [
      db
        .prepare(
          `UPDATE reception_login_qrs SET revoked_at = ?, revoked_by = ?, revoke_reason = ?
            WHERE user_id = ? AND revoked_at IS NULL`,
        )
        .bind(now, actor.userId, reason ?? "再発行", userId),
      db
        .prepare("INSERT INTO token_tombstones (token_hash, kind, created_at) VALUES (?, 'RECEPTION_LOGIN_QR', ?)")
        .bind(hash, now),
      db
        .prepare("INSERT INTO reception_login_qrs (token_hash, user_id, issued_at, issued_by, token_enc) VALUES (?, ?, ?, ?, ?)")
        .bind(hash, userId, now, actor.userId, sealed),
      db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
      auditStmt(db, {
        actor,
        action: role === "CLERK" ? "clerk_qr.issue" : "reception_qr.issue",
        targetType: "user",
        targetId: userId,
        reason: reason ?? undefined,
      }),
    ],
  };
}

export function buildReceptionQrIssue(db: D1Database, actor: AuthContext, userId: string, reason: string | null, secret: string | null = null) {
  return buildLoginQrIssue(db, actor, userId, "RECEPTION", reason, secret);
}

interface UserRow {
  id: string;
  role: Role;
  login_id: string | null;
  nickname: string;
  shop_id: string | null;
  shop_name: string | null;
  status: UserDto["status"];
  created_at: number;
  qr_issued_at: number | null;
}

export async function listUsers(
  db: D1Database,
  filter: { role?: Role; shopId?: string; roles?: Role[]; q?: string; cursor?: string; limit?: number },
): Promise<UserDto[]> {
  const where: string[] = ["u.status <> 'DELETED'"];
  const args: unknown[] = [];
  if (filter.role) {
    where.push("u.role = ?");
    args.push(filter.role);
  }
  if (filter.roles?.length) {
    where.push(`u.role IN (${filter.roles.map(() => "?").join(",")})`);
    args.push(...filter.roles);
  }
  if (filter.shopId) {
    where.push("u.shop_id = ?");
    args.push(filter.shopId);
  }
  if (filter.q) {
    // 表示名・ログインID・店舗名の部分一致(%と_は文字として扱う)
    const like = `%${filter.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    where.push("(u.nickname LIKE ? ESCAPE '\\' OR u.login_id LIKE ? ESCAPE '\\' OR s.display_name LIKE ? ESCAPE '\\')");
    args.push(like, like, like);
  }
  if (filter.cursor) {
    const [t, id] = filter.cursor.split(":");
    where.push("(u.created_at < ? OR (u.created_at = ? AND u.id < ?))");
    args.push(Number(t), Number(t), id);
  }
  const { results } = await db
    .prepare(
      `SELECT u.id, u.role, u.login_id, u.nickname, u.shop_id, s.display_name AS shop_name, u.status, u.created_at,
              (SELECT q.issued_at FROM reception_login_qrs q WHERE q.user_id = u.id AND q.revoked_at IS NULL) AS qr_issued_at
         FROM users u LEFT JOIN shops s ON s.id = u.shop_id
        WHERE ${where.join(" AND ")}
        ORDER BY u.created_at DESC, u.id DESC LIMIT ?`,
    )
    .bind(...args, filter.limit ?? 500)
    .all<UserRow>();
  return results.map((r) => ({
    id: r.id,
    role: r.role,
    loginId: r.login_id,
    nickname: r.nickname,
    shopId: r.shop_id,
    shopName: r.shop_name,
    status: r.status,
    createdAt: r.created_at,
    loginQrIssuedAt: r.qr_issued_at,
  }));
}

export async function getUserBasic(
  db: D1Database,
  id: string,
): Promise<{ id: string; role: Role; shop_id: string | null; status: string; nickname: string; login_id: string | null } | null> {
  return db
    .prepare("SELECT id, role, shop_id, status, nickname, login_id FROM users WHERE id = ? AND status <> 'DELETED'")
    .bind(id)
    .first();
}

/** 有効なログインQRの文字列を復号して返す(何度でも表示するため)。発行時に保存できていない古いQRは null */
export async function readLoginQr(db: D1Database, secret: string | null, userId: string): Promise<{ token: string; issuedAt: number } | null> {
  const r = await db
    .prepare("SELECT token_enc, issued_at FROM reception_login_qrs WHERE user_id = ? AND revoked_at IS NULL")
    .bind(userId)
    .first<{ token_enc: string | null; issued_at: number }>();
  const token = await openText(secret, r?.token_enc ?? null);
  return r && token ? { token, issuedAt: r.issued_at } : null;
}
