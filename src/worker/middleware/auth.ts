import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { Role } from "@shared/roles";
import { isShopRole } from "@shared/roles";
import type { AppEnv, AuthContext } from "../env";
import { sha256Hex } from "../lib/crypto";
import { forbidden, unauthorized } from "../lib/errors";
import { SESSION_COOKIE, clearSessionCookie } from "../lib/session";

/**
 * CSRF 対策。状態を変える要求は、同一オリジンからのものだけ受け付ける。
 * (Cookie は SameSite=Lax だが、Origin 検査を二重の防御として入れる)
 */
export const originCheck = createMiddleware<AppEnv>(async (c, next) => {
  const method = c.req.method;
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    const origin = c.req.header("origin");
    if (!origin || origin !== new URL(c.req.url).origin) {
      throw forbidden("不正なリクエスト元です", "BAD_ORIGIN");
    }
  }
  await next();
});

interface SessionRow {
  id_hash: string;
  last_seen_at: number;
  id: string;
  role: Role;
  nickname: string;
  login_id: string | null;
  shop_id: string | null;
}

/** Cookie からセッションを復元して c.var.auth に入れる。無効なら Cookie を消す */
export const sessionLoader = createMiddleware<AppEnv>(async (c, next) => {
  c.set("auth", null);
  const sid = getCookie(c, SESSION_COOKIE);
  if (sid) {
    const hash = await sha256Hex(sid);
    const now = Date.now();
    const row = await c.env.DB.prepare(
      `SELECT s.id_hash, s.last_seen_at, u.id, u.role, u.nickname, u.login_id, u.shop_id
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id_hash = ? AND s.expires_at > ? AND u.status = 'ACTIVE'`,
    )
      .bind(hash, now)
      .first<SessionRow>();
    if (row) {
      c.set("auth", {
        sessionHash: row.id_hash,
        userId: row.id,
        role: row.role,
        nickname: row.nickname,
        loginId: row.login_id,
        shopId: row.shop_id,
      });
      if (now - row.last_seen_at > 60_000) {
        try {
          c.executionCtx.waitUntil(
            c.env.DB.prepare("UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?").bind(now, hash).run(),
          );
        } catch {
          // executionCtx が無い環境(テスト等)では更新を省略する
        }
      }
    } else {
      clearSessionCookie(c);
    }
  }
  await next();
});

export function requireAuth(c: { get(key: "auth"): AuthContext | null }): AuthContext {
  const auth = c.get("auth");
  if (!auth) throw unauthorized();
  return auth;
}

/** 指定した役割のどれかでログインしていること。サーバー側の権限確認の入口 */
export function requireRole(...roles: Role[]) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const auth = requireAuth(c);
    if (!roles.includes(auth.role)) throw forbidden();
    await next();
  });
}

/**
 * 店舗単位の操作権限。全体管理者は全店舗、店舗責任者・店員は所属店舗だけ。
 * 別店舗の商品・売上・スタッフには触れない(仕様 §3.7, §20.2)。
 */
export function assertShopAccess(auth: AuthContext, shopId: string): void {
  if (auth.role === "ADMIN") return;
  if (isShopRole(auth.role) && auth.shopId === shopId) return;
  throw forbidden("他の店舗は操作できません");
}
