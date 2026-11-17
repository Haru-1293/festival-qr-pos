import type { Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import type { Role } from "@shared/roles";
import type { AppEnv } from "../env";
import { randomToken, sha256Hex } from "./crypto";

export const SESSION_COOKIE = "fqp_sid";

const HOUR = 60 * 60 * 1000;

/** 役割ごとの絶対有効期限。スタッフは短め、顧客は会期中使えるよう長め */
export function sessionTtlMs(role: Role): number {
  return role === "CUSTOMER" ? 72 * HOUR : 12 * HOUR;
}

/** 受付担当者は同時ログイン1端末のみ(uq_sessions_single が DB 側でも保証する) */
export function isSingleSessionRole(role: Role): boolean {
  return role === "RECEPTION";
}

export interface NewSession {
  token: string; // Cookie に載せる生のセッションID(DBにはハッシュだけ保存)
  stmts: D1PreparedStatement[];
}

/**
 * セッション作成の SQL 文。呼び出し側の db.batch() に含めて原子的に実行する。
 * 受付担当者は、先に既存セッションを削除してから挿入する(古い端末は次のリクエストでログアウトされる)。
 */
export async function buildSessionStmts(
  db: D1Database,
  user: { id: string; role: Role },
  deviceLabel: string | null,
): Promise<NewSession> {
  const token = randomToken(32);
  const hash = await sha256Hex(token);
  const now = Date.now();
  const single = isSingleSessionRole(user.role);
  const stmts: D1PreparedStatement[] = [];
  if (single) {
    stmts.push(db.prepare("DELETE FROM sessions WHERE user_id = ? AND single_session = 1").bind(user.id));
  }
  stmts.push(
    db
      .prepare(
        `INSERT INTO sessions (id_hash, user_id, device_label, single_session, created_at, expires_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(hash, user.id, deviceLabel, single ? 1 : 0, now, now + sessionTtlMs(user.role), now),
  );
  return { token, stmts };
}

export function writeSessionCookie(c: Context<AppEnv>, token: string, role: Role): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: "/",
    maxAge: Math.floor(sessionTtlMs(role) / 1000),
  });
}

export function clearSessionCookie(c: Context<AppEnv>): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

export function deviceLabelFrom(c: Context<AppEnv>): string | null {
  const ua = c.req.header("user-agent");
  return ua ? ua.slice(0, 120) : null;
}
