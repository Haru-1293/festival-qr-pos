import { zv as zValidator } from "../lib/validate";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { auditStmt } from "../lib/audit";
import { hashPassword } from "../lib/crypto";
import { badRequest, notFound } from "../lib/errors";
import { createStaffUser, getUserBasic, listUsers } from "../lib/users";
import { nicknameSchema, passwordSchema, staffLoginIdSchema } from "../lib/validation";
import { assertShopAccess, requireAuth, requireRole } from "../middleware/auth";

const shopParam = zValidator("param", z.object({ shopId: z.string().length(26) }));
const staffParam = zValidator("param", z.object({ shopId: z.string().length(26), userId: z.string().length(26) }));

/**
 * 店舗単位のAPI。店舗責任者は自店舗だけ、全体管理者は全店舗を操作できる。
 * 店員のアカウント登録は店舗責任者が行う(店員自身は不可)。
 */
export const shopRoutes = new Hono<AppEnv>()
  .use("*", requireRole("SHOP_MANAGER", "ADMIN"))

  .get("/:shopId/staff", shopParam, async (c) => {
    const auth = requireAuth(c);
    const { shopId } = c.req.valid("param");
    assertShopAccess(auth, shopId);
    return c.json({ staff: await listUsers(c.env.DB, { shopId, roles: ["CLERK", "SHOP_MANAGER"] }) });
  })
  .post(
    "/:shopId/staff",
    shopParam,
    zValidator("json", z.object({ loginId: staffLoginIdSchema, password: passwordSchema, nickname: nicknameSchema })),
    async (c) => {
      const auth = requireAuth(c);
      const { shopId } = c.req.valid("param");
      assertShopAccess(auth, shopId);
      const shop = await c.env.DB.prepare("SELECT status FROM shops WHERE id = ?").bind(shopId).first<{ status: string }>();
      if (!shop) throw notFound("店舗が見つかりません");
      const b = c.req.valid("json");
      const id = await createStaffUser(c.env.DB, auth, {
        role: "CLERK",
        shopId,
        loginId: b.loginId,
        passwordHash: await hashPassword(b.password),
        nickname: b.nickname,
      });
      return c.json({ id }, 201);
    },
  )
  // 店員のパスワード再設定(忘れた場合に店舗責任者が行う)。対象は自店舗の店員だけ
  .post(
    "/:shopId/staff/:userId/reset-password",
    staffParam,
    zValidator("json", z.object({ password: passwordSchema })),
    async (c) => {
      const auth = requireAuth(c);
      const { shopId, userId } = c.req.valid("param");
      assertShopAccess(auth, shopId);
      const target = await getUserBasic(c.env.DB, userId);
      if (!target || target.role !== "CLERK" || target.shop_id !== shopId) throw notFound("店員が見つかりません");
      const hash = await hashPassword(c.req.valid("json").password);
      await c.env.DB.batch([
        c.env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(hash, userId),
        c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
        auditStmt(c.env.DB, { actor: auth, action: "user.reset_password", targetType: "user", targetId: userId }),
      ]);
      return c.json({ ok: true });
    },
  )
  // 店員の利用停止/再開(退店・シフト外し)。対象は自店舗の店員だけ
  .patch(
    "/:shopId/staff/:userId/status",
    staffParam,
    zValidator("json", z.object({ status: z.enum(["ACTIVE", "SUSPENDED"]) })),
    async (c) => {
      const auth = requireAuth(c);
      const { shopId, userId } = c.req.valid("param");
      assertShopAccess(auth, shopId);
      const { status } = c.req.valid("json");
      if (userId === auth.userId) throw badRequest("自分自身のアカウントは停止できません");
      const target = await getUserBasic(c.env.DB, userId);
      if (!target || target.role !== "CLERK" || target.shop_id !== shopId) throw notFound("店員が見つかりません");
      await c.env.DB.batch([
        c.env.DB.prepare("UPDATE users SET status = ? WHERE id = ?").bind(status, userId),
        ...(status === "SUSPENDED" ? [c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId)] : []),
        auditStmt(c.env.DB, {
          actor: auth,
          action: status === "SUSPENDED" ? "user.suspend" : "user.resume",
          targetType: "user",
          targetId: userId,
          before: { status: target.status },
          after: { status },
        }),
      ]);
      return c.json({ ok: true });
    },
  );
