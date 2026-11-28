import { zv as zValidator } from "../lib/validate";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { auditStmt } from "../lib/audit";
import { hashPassword, timingSafeEqualStr } from "../lib/crypto";
import { conflict, forbidden, notFound } from "../lib/errors";
import { newId } from "../lib/ids";
import { buildSessionStmts, deviceLabelFrom, writeSessionCookie } from "../lib/session";
import { isUniqueViolation } from "../lib/users";
import { emailSchema, nicknameSchema, passwordSchema, staffLoginIdSchema } from "../lib/validation";
import { loadMe } from "./auth";

async function adminExists(db: D1Database): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS x FROM users WHERE role = 'ADMIN' LIMIT 1").first();
  return row !== null;
}

/**
 * 初回セットアップ。全体管理者が1人もいないときだけ、SETUP_TOKEN を知っている人が最初の全体管理者を作れる。
 * 作成後はこのAPIは常に拒否する(SETUP_TOKEN は削除してよい)。
 */
export const setupRoutes = new Hono<AppEnv>()
  .get("/status", async (c) => c.json({ needsSetup: !(await adminExists(c.env.DB)) }))
  .post(
    "/admin",
    zValidator("json", z.object({ loginId: staffLoginIdSchema, password: passwordSchema, nickname: nicknameSchema, recoveryEmail: emailSchema.optional() })),
    async (c) => {
      const expected = c.env.SETUP_TOKEN;
      if (!expected) throw notFound();
      const given = c.req.header("x-setup-token") ?? "";
      if (!timingSafeEqualStr(given, expected)) throw forbidden("セットアップトークンが違います", "BAD_SETUP_TOKEN");

      const { loginId, password, nickname, recoveryEmail } = c.req.valid("json");
      const db = c.env.DB;
      const id = newId();
      const passwordHash = await hashPassword(password);
      let changes = 0;
      try {
        // 「管理者がまだいない」条件を INSERT と同じ文で判定し、同時実行でも2人作られないようにする
        const res = await db
          .prepare(
            `INSERT INTO users (id, role, login_id, password_hash, nickname, status, created_at, created_by, recovery_email)
             SELECT ?, 'ADMIN', ?, ?, ?, 'ACTIVE', ?, ?, ?
              WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'ADMIN')`,
          )
          .bind(id, loginId, passwordHash, nickname, Date.now(), id, recoveryEmail ?? null)
          .run();
        changes = res.meta.changes ?? 0;
      } catch (e) {
        if (isUniqueViolation(e, "users.login_id")) throw conflict("このログインIDはすでに使われています", "LOGIN_ID_TAKEN");
        throw e;
      }
      if (changes === 0) throw conflict("全体管理者はすでに作成されています", "ALREADY_SETUP");

      const session = await buildSessionStmts(db, { id, role: "ADMIN" }, deviceLabelFrom(c));
      await db.batch([
        ...session.stmts,
        auditStmt(db, { actor: { userId: id, role: "ADMIN" }, action: "setup.create_admin", targetType: "user", targetId: id }),
      ]);
      writeSessionCookie(c, session.token, "ADMIN");
      return c.json(await loadMe(db, { userId: id }), 201);
    },
  );
