import { zv as zValidator } from "../lib/validate";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { auditStmt } from "../lib/audit";
import type { ReceptionQrIssued, ShopOptions } from "@shared/api";
import { hashPassword } from "../lib/crypto";
import { badRequest, conflict, notFound } from "../lib/errors";
import { buildLoginQrIssue, createStaffUser, getUserBasic, isUniqueViolation, listUsers } from "../lib/users";
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

  // 注文ステータス・呼び出しボードのオプション(店舗ごと)
  .get("/:shopId/options", shopParam, async (c) => {
    const auth = requireAuth(c);
    const { shopId } = c.req.valid("param");
    assertShopAccess(auth, shopId);
    const r = await c.env.DB.prepare("SELECT use_order_tracking, use_call_board, call_mode FROM shops WHERE id = ?").bind(shopId).first<{ use_order_tracking: number; use_call_board: number; call_mode: "AUTO" | "TAG" }>();
    if (!r) throw notFound("店舗が見つかりません");
    return c.json({ options: { orderTracking: r.use_order_tracking === 1, callBoard: r.use_call_board === 1, callMode: r.call_mode } satisfies ShopOptions });
  })
  .put("/:shopId/options", shopParam, zValidator("json", z.object({ orderTracking: z.boolean(), callBoard: z.boolean(), callMode: z.enum(["AUTO", "TAG"]).default("AUTO") })), async (c) => {
    const auth = requireAuth(c);
    const { shopId } = c.req.valid("param");
    assertShopAccess(auth, shopId);
    const b = c.req.valid("json");
    if (b.callBoard && !b.orderTracking) throw badRequest("呼び出しボードを使うには、注文ステータスもオンにしてください");
    const res = await c.env.DB.batch([
      c.env.DB.prepare("UPDATE shops SET use_order_tracking = ?, use_call_board = ?, call_mode = ? WHERE id = ?").bind(b.orderTracking ? 1 : 0, b.callBoard ? 1 : 0, b.callMode, shopId),
      auditStmt(c.env.DB, { actor: auth, action: "shop.options", targetType: "shop", targetId: shopId, after: b }),
    ]);
    if ((res[0].meta.changes ?? 0) === 0) throw notFound("店舗が見つかりません");
    return c.json({ ok: true });
  })
  .get("/:shopId/staff", shopParam, async (c) => {
    const auth = requireAuth(c);
    const { shopId } = c.req.valid("param");
    assertShopAccess(auth, shopId);
    return c.json({ staff: await listUsers(c.env.DB, { shopId, roles: ["CLERK", "SHOP_MANAGER"] }) });
  })
  .post(
    "/:shopId/staff",
    shopParam,
    zValidator("json", z.object({ loginId: staffLoginIdSchema, password: passwordSchema, nickname: nicknameSchema, role: z.enum(["CLERK", "SHOP_MANAGER"]).default("CLERK") })),
    async (c) => {
      const auth = requireAuth(c);
      const { shopId } = c.req.valid("param");
      assertShopAccess(auth, shopId);
      const shop = await c.env.DB.prepare("SELECT status FROM shops WHERE id = ?").bind(shopId).first<{ status: string }>();
      if (!shop) throw notFound("店舗が見つかりません");
      const b = c.req.valid("json");
      const id = await createStaffUser(c.env.DB, auth, {
        role: b.role,
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
      if (!target || (target.role !== "CLERK" && target.role !== "SHOP_MANAGER") || target.shop_id !== shopId) throw notFound("スタッフが見つかりません");
      // 共同の店舗責任者の操作は、他の責任者に対してだけ(自分のパスワード・IDは各自の設定から変える)
      if (target.role === "SHOP_MANAGER" && target.id === auth.userId) throw badRequest("自分自身のアカウントはここでは変更できません");
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
      if (!target || (target.role !== "CLERK" && target.role !== "SHOP_MANAGER") || target.shop_id !== shopId) throw notFound("スタッフが見つかりません");
      // 共同の店舗責任者の操作は、他の責任者に対してだけ(自分のパスワード・IDは各自の設定から変える)
      if (target.role === "SHOP_MANAGER" && target.id === auth.userId) throw badRequest("自分自身のアカウントはここでは変更できません");
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
  )
  // 店員のログインIDの変更(IDは店舗責任者が設定する)。ログイン中の端末はログアウトされる
  .patch(
    "/:shopId/staff/:userId/login-id",
    staffParam,
    zValidator("json", z.object({ loginId: staffLoginIdSchema })),
    async (c) => {
      const auth = requireAuth(c);
      const { shopId, userId } = c.req.valid("param");
      assertShopAccess(auth, shopId);
      const { loginId } = c.req.valid("json");
      const target = await getUserBasic(c.env.DB, userId);
      if (!target || (target.role !== "CLERK" && target.role !== "SHOP_MANAGER") || target.shop_id !== shopId) throw notFound("スタッフが見つかりません");
      // 共同の店舗責任者の操作は、他の責任者に対してだけ(自分のパスワード・IDは各自の設定から変える)
      if (target.role === "SHOP_MANAGER" && target.id === auth.userId) throw badRequest("自分自身のアカウントはここでは変更できません");
      try {
        await c.env.DB.batch([
          c.env.DB.prepare("UPDATE users SET login_id = ? WHERE id = ?").bind(loginId, userId),
          c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
          auditStmt(c.env.DB, {
            actor: auth,
            action: "user.change_login_id",
            targetType: "user",
            targetId: userId,
            before: { loginId: target.login_id },
            after: { loginId },
          }),
        ]);
      } catch (e) {
        if (isUniqueViolation(e, "users.login_id")) throw conflict("このログインIDはすでに使われています", "LOGIN_ID_TAKEN");
        throw e;
      }
      return c.json({ ok: true });
    },
  )
  // 店員のログインQRの発行・再発行。古いQRは即時失効し、ログイン中の端末もログアウトされる
  .post(
    "/:shopId/staff/:userId/qr",
    staffParam,
    zValidator("json", z.object({ reason: z.string().trim().max(200).optional() })),
    async (c) => {
      const auth = requireAuth(c);
      const { shopId, userId } = c.req.valid("param");
      assertShopAccess(auth, shopId);
      const target = await getUserBasic(c.env.DB, userId);
      if (!target || target.role !== "CLERK" || target.shop_id !== shopId) throw notFound("店員が見つかりません");
      if (target.status !== "ACTIVE") throw badRequest("停止中の店員にはQRを発行できません");
      const qr = await buildLoginQrIssue(c.env.DB, auth, userId, "CLERK", c.req.valid("json").reason ?? "再発行");
      await c.env.DB.batch(qr.stmts);
      return c.json({ userId, token: qr.token } satisfies ReceptionQrIssued);
    },
  )
  // 店員のログインQRの即時失効(再発行はしない)
  .post(
    "/:shopId/staff/:userId/qr/revoke",
    staffParam,
    zValidator("json", z.object({ reason: z.string().trim().min(1, "理由を入力してください").max(200) })),
    async (c) => {
      const auth = requireAuth(c);
      const { shopId, userId } = c.req.valid("param");
      assertShopAccess(auth, shopId);
      const { reason } = c.req.valid("json");
      const target = await getUserBasic(c.env.DB, userId);
      if (!target || target.role !== "CLERK" || target.shop_id !== shopId) throw notFound("店員が見つかりません");
      await c.env.DB.batch([
        c.env.DB.prepare(
          "UPDATE reception_login_qrs SET revoked_at = ?, revoked_by = ?, revoke_reason = ? WHERE user_id = ? AND revoked_at IS NULL",
        ).bind(Date.now(), auth.userId, reason, userId),
        c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
        auditStmt(c.env.DB, { actor: auth, action: "clerk_qr.revoke", targetType: "user", targetId: userId, reason }),
      ]);
      return c.json({ ok: true });
    },
  );
