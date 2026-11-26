import { vaultSecret } from "../lib/vault";
import { zv as zValidator } from "../lib/validate";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { auditStmt } from "../lib/audit";
import type { ReceptionQrIssued, ShopNameHistoryItem, ShopOptions } from "@shared/api";
import { renameStmts } from "../lib/shopname";
import { hashPassword } from "../lib/crypto";
import { badRequest, conflict, notFound } from "../lib/errors";
import { readLoginQr, buildLoginQrIssue, createStaffUser, getUserBasic, isUniqueViolation, listUsers } from "../lib/users";
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
  // 店舗名と変更履歴。店舗責任者(自店舗)と全体管理者が見られる
  .get("/:shopId/name", shopParam, async (c) => {
    const auth = requireAuth(c);
    const { shopId } = c.req.valid("param");
    assertShopAccess(auth, shopId);
    const shop = await c.env.DB.prepare("SELECT display_name FROM shops WHERE id = ?").bind(shopId).first<{ display_name: string }>();
    if (!shop) throw notFound("店舗が見つかりません");
    const { results } = await c.env.DB
      .prepare(
        `SELECT h.display_name, h.valid_from, u.nickname FROM shop_name_history h LEFT JOIN users u ON u.id = h.changed_by
          WHERE h.shop_id = ? ORDER BY h.valid_from DESC, h.id DESC LIMIT 50`,
      )
      .bind(shopId)
      .all<{ display_name: string; valid_from: number; nickname: string | null }>();
    return c.json({
      displayName: shop.display_name,
      history: results.map((r) => ({ displayName: r.display_name, validFrom: r.valid_from, changedBy: r.nickname }) satisfies ShopNameHistoryItem),
    });
  })
  // 店舗名の変更。店舗責任者(自店舗)と全体管理者。過去の注文・ログは同じ店舗のまま、その時点の名前で見られる
  .post("/:shopId/rename", shopParam, zValidator("json", z.object({ displayName: z.string().trim().min(1, "店舗名を入力してください").max(50, "店舗名は50文字までです") })), async (c) => {
    const auth = requireAuth(c);
    const { shopId } = c.req.valid("param");
    assertShopAccess(auth, shopId);
    const { displayName } = c.req.valid("json");
    const db = c.env.DB;
    const cur = await db.prepare("SELECT display_name FROM shops WHERE id = ?").bind(shopId).first<{ display_name: string }>();
    if (!cur) throw notFound("店舗が見つかりません");
    if (cur.display_name === displayName) return c.json({ ok: true, displayName, changed: false });
    const dup = await db.prepare("SELECT 1 FROM shops WHERE display_name = ? AND id <> ? LIMIT 1").bind(displayName, shopId).first();
    if (dup) throw conflict("同じ名前の店舗がすでにあります。別の名前にしてください", "SHOP_NAME_TAKEN");
    const res = await db.batch(renameStmts(db, auth, shopId, cur.display_name, displayName, Date.now()));
    if ((res[0].meta.changes ?? 0) === 0) throw conflict("店舗名がほかの操作で変わりました。画面を開き直してください", "STATE_CHANGED");
    return c.json({ ok: true, displayName, changed: true });
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
      const qr = await buildLoginQrIssue(c.env.DB, auth, userId, "CLERK", c.req.valid("json").reason ?? "再発行", vaultSecret(c.env));
      await c.env.DB.batch(qr.stmts);
      return c.json({ userId, token: qr.token } satisfies ReceptionQrIssued);
    },
  )
  // 店員の有効なログインQRを何度でも表示する。閲覧は監査ログに残る
  .get("/:shopId/staff/:userId/qr", staffParam, async (c) => {
    const auth = requireAuth(c);
    const { shopId, userId } = c.req.valid("param");
    assertShopAccess(auth, shopId);
    const target = await getUserBasic(c.env.DB, userId);
    if (!target || target.role !== "CLERK" || target.shop_id !== shopId) throw notFound("店員が見つかりません");
    const qr = await readLoginQr(c.env.DB, vaultSecret(c.env), userId);
    if (!qr) throw notFound("このQRは再表示できません(保存される前に発行されたQRです)。「QR再発行」で作り直してください", "QR_NOT_STORED");
    await c.env.DB.batch([auditStmt(c.env.DB, { actor: auth, action: "login_qr.view", targetType: "user", targetId: userId })]);
    c.header("Cache-Control", "no-store");
    return c.json({ userId, token: qr.token, issuedAt: qr.issuedAt });
  })
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
