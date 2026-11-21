import { zv as zValidator } from "../lib/validate";
import { Hono } from "hono";
import { z } from "zod";
import type { ReceptionQrIssued, ShopDto } from "@shared/api";
import { DEFAULT_CURRENCY } from "@shared/currency";
import { ROLES, SHOP_STATUSES } from "@shared/roles";
import type { AppEnv } from "../env";
import { auditStmt } from "../lib/audit";
import { EMERGENCY_KEY, getEmergency } from "../lib/emergency";
import { hashPassword } from "../lib/crypto";
import { badRequest, conflict, notFound } from "../lib/errors";
import { newId } from "../lib/ids";
import { SETTING_KEYS, getCurrency, getOperations, setSettingStmt } from "../lib/settings";
import { buildReceptionQrIssue, createStaffUser, getUserBasic, isUniqueViolation, listUsers } from "../lib/users";
import { nicknameSchema, passwordSchema, staffLoginIdSchema } from "../lib/validation";
import { requireAuth, requireRole } from "../middleware/auth";

const idSchema = z.string().length(26);
const idParam = zValidator("param", z.object({ id: idSchema }));

interface ShopRow {
  id: string;
  name: string;
  display_name: string;
  status: ShopDto["status"];
  sort_order: number;
}
const toShopDto = (r: ShopRow): ShopDto => ({
  id: r.id,
  name: r.name,
  displayName: r.display_name,
  status: r.status,
  sortOrder: r.sort_order,
});

const currencySchema = z.object({
  name: z.string().trim().min(1).max(20),
  shortName: z.string().trim().min(1).max(8),
  symbolPosition: z.enum(["before", "after"]),
  // 内部の金額は整数。小数表示に必要な最小単位の扱いが未実装のため、現時点では false のみ受け付ける
  allowDecimals: z.literal(false, { message: "小数の使用にはまだ対応していません" }),
  yenPerUnit: z.number().positive().max(1_000_000),
  description: z.string().trim().max(200),
});

/** 全体管理者専用。すべてサーバー側で ADMIN を確認する(画面側の非表示に頼らない) */
export const adminRoutes = new Hono<AppEnv>()
  .use("*", requireRole("ADMIN"))

  // ---------- 店舗 ----------
  .get("/shops", async (c) => {
    const { results } = await c.env.DB.prepare(
      "SELECT id, name, display_name, status, sort_order FROM shops ORDER BY sort_order, created_at",
    ).all<ShopRow>();
    return c.json({ shops: results.map(toShopDto) });
  })
  .post(
    "/shops",
    zValidator(
      "json",
      z.object({
        name: z.string().trim().min(1).max(50),
        displayName: z.string().trim().min(1).max(50),
        sortOrder: z.number().int().min(0).max(10_000).default(0),
      }),
    ),
    async (c) => {
      const auth = requireAuth(c);
      const b = c.req.valid("json");
      const id = newId();
      await c.env.DB.batch([
        c.env.DB.prepare(
          "INSERT INTO shops (id, name, display_name, status, sort_order, created_at) VALUES (?, ?, ?, 'ACTIVE', ?, ?)",
        ).bind(id, b.name, b.displayName, b.sortOrder, Date.now()),
        auditStmt(c.env.DB, { actor: auth, action: "shop.create", targetType: "shop", targetId: id, after: b }),
      ]);
      return c.json({ shop: { id, name: b.name, displayName: b.displayName, status: "ACTIVE", sortOrder: b.sortOrder } satisfies ShopDto }, 201);
    },
  )
  .patch(
    "/shops/:id",
    idParam,
    zValidator(
      "json",
      z.object({
        name: z.string().trim().min(1).max(50).optional(),
        displayName: z.string().trim().min(1).max(50).optional(),
        status: z.enum(SHOP_STATUSES).optional(),
        sortOrder: z.number().int().min(0).max(10_000).optional(),
      }),
    ),
    async (c) => {
      const auth = requireAuth(c);
      const { id } = c.req.valid("param");
      const b = c.req.valid("json");
      const before = await c.env.DB.prepare("SELECT id, name, display_name, status, sort_order FROM shops WHERE id = ?")
        .bind(id)
        .first<ShopRow>();
      if (!before) throw notFound("店舗が見つかりません");
      const next = {
        name: b.name ?? before.name,
        display_name: b.displayName ?? before.display_name,
        status: b.status ?? before.status,
        sort_order: b.sortOrder ?? before.sort_order,
      };
      await c.env.DB.batch([
        c.env.DB.prepare("UPDATE shops SET name = ?, display_name = ?, status = ?, sort_order = ? WHERE id = ?").bind(
          next.name,
          next.display_name,
          next.status,
          next.sort_order,
          id,
        ),
        auditStmt(c.env.DB, {
          actor: auth,
          action: "shop.update",
          targetType: "shop",
          targetId: id,
          before: { name: before.name, displayName: before.display_name, status: before.status, sortOrder: before.sort_order },
          after: next,
        }),
      ]);
      return c.json({ shop: toShopDto({ id, ...next }) });
    },
  )

  // ---------- ユーザー ----------
  .get(
    "/users",
    zValidator("query", z.object({ role: z.enum(ROLES).optional(), shopId: idSchema.optional() })),
    async (c) => {
      const { role, shopId } = c.req.valid("query");
      return c.json({ users: await listUsers(c.env.DB, { role, shopId }) });
    },
  )
  // 全体管理者の追加
  .post(
    "/users/admin",
    zValidator("json", z.object({ loginId: staffLoginIdSchema, password: passwordSchema, nickname: nicknameSchema })),
    async (c) => {
      const auth = requireAuth(c);
      const b = c.req.valid("json");
      const id = await createStaffUser(c.env.DB, auth, {
        role: "ADMIN",
        shopId: null,
        loginId: b.loginId,
        passwordHash: await hashPassword(b.password),
        nickname: b.nickname,
      });
      return c.json({ id }, 201);
    },
  )
  // 店舗責任者の登録(全体管理者が行う)
  .post(
    "/users/shop-manager",
    zValidator(
      "json",
      z.object({ shopId: idSchema, loginId: staffLoginIdSchema, password: passwordSchema, nickname: nicknameSchema }),
    ),
    async (c) => {
      const auth = requireAuth(c);
      const b = c.req.valid("json");
      const shop = await c.env.DB.prepare("SELECT id FROM shops WHERE id = ?").bind(b.shopId).first();
      if (!shop) throw notFound("店舗が見つかりません");
      const id = await createStaffUser(c.env.DB, auth, {
        role: "SHOP_MANAGER",
        shopId: b.shopId,
        loginId: b.loginId,
        passwordHash: await hashPassword(b.password),
        nickname: b.nickname,
      });
      return c.json({ id }, 201);
    },
  )
  // 受付担当者の登録。恒久ログインQRを発行する(生トークンはこのレスポンスだけ)
  .post("/users/reception", zValidator("json", z.object({ nickname: nicknameSchema, loginId: staffLoginIdSchema.optional(), password: passwordSchema.optional() }).refine((b) => !b.loginId === !b.password, "ログインIDとパスワードは両方入力してください")), async (c) => {
    const auth = requireAuth(c);
    const { nickname, loginId, password } = c.req.valid("json");
    const passwordHash = password ? await hashPassword(password) : null;
    const id = newId();
    const qr = await buildReceptionQrIssue(c.env.DB, auth, id, "新規発行");
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO users (id, role, login_id, password_hash, nickname, status, created_at, created_by)
         VALUES (?, 'RECEPTION', ?, ?, ?, 'ACTIVE', ?, ?)`,
      ).bind(id, loginId ?? null, passwordHash, nickname, Date.now(), auth.userId),
      auditStmt(c.env.DB, { actor: auth, action: "user.create", targetType: "user", targetId: id, after: { role: "RECEPTION", nickname } }),
      ...qr.stmts,
    ]).catch((e) => {
      if (isUniqueViolation(e, "users.login_id")) throw conflict("このログインIDはすでに使われています", "LOGIN_ID_TAKEN");
      throw e;
    });
    return c.json({ userId: id, token: qr.token } satisfies ReceptionQrIssued, 201);
  })
  // 受付担当者のID・パスワードの設定/変更(QRとは別のログイン手段)。端末はログアウトされる
  .post(
    "/users/:id/reception-credentials",
    idParam,
    zValidator("json", z.object({ loginId: staffLoginIdSchema, password: passwordSchema })),
    async (c) => {
      const auth = requireAuth(c);
      const { id } = c.req.valid("param");
      const b = c.req.valid("json");
      const target = await getUserBasic(c.env.DB, id);
      if (!target || target.role !== "RECEPTION") throw notFound("受付担当者が見つかりません");
      const hash = await hashPassword(b.password);
      try {
        await c.env.DB.batch([
          c.env.DB.prepare("UPDATE users SET login_id = ?, password_hash = ? WHERE id = ?").bind(b.loginId, hash, id),
          c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id),
          auditStmt(c.env.DB, { actor: auth, action: "user.set_credentials", targetType: "user", targetId: id, after: { loginId: b.loginId } }),
        ]);
      } catch (e) {
        if (isUniqueViolation(e, "users.login_id")) throw conflict("このログインIDはすでに使われています", "LOGIN_ID_TAKEN");
        throw e;
      }
      return c.json({ ok: true });
    },
  )
  // 受付ログインQRの再発行(紛失時など)。古いQRは即時失効し、その担当者の端末はログアウトされる
  .post(
    "/users/:id/reception-qr",
    idParam,
    zValidator("json", z.object({ reason: z.string().trim().max(200).optional() })),
    async (c) => {
      const auth = requireAuth(c);
      const { id } = c.req.valid("param");
      const { reason } = c.req.valid("json");
      const target = await getUserBasic(c.env.DB, id);
      if (!target || target.role !== "RECEPTION") throw notFound("受付担当者が見つかりません");
      if (target.status !== "ACTIVE") throw badRequest("停止中の担当者にはQRを発行できません");
      const qr = await buildReceptionQrIssue(c.env.DB, auth, id, reason ?? "再発行");
      await c.env.DB.batch(qr.stmts);
      return c.json({ userId: id, token: qr.token } satisfies ReceptionQrIssued);
    },
  )
  // 受付ログインQRの即時失効(再発行はしない)
  .post(
    "/users/:id/reception-qr/revoke",
    idParam,
    zValidator("json", z.object({ reason: z.string().trim().min(1, "理由を入力してください").max(200) })),
    async (c) => {
      const auth = requireAuth(c);
      const { id } = c.req.valid("param");
      const { reason } = c.req.valid("json");
      const target = await getUserBasic(c.env.DB, id);
      if (!target || target.role !== "RECEPTION") throw notFound("受付担当者が見つかりません");
      await c.env.DB.batch([
        c.env.DB.prepare(
          "UPDATE reception_login_qrs SET revoked_at = ?, revoked_by = ?, revoke_reason = ? WHERE user_id = ? AND revoked_at IS NULL",
        ).bind(Date.now(), auth.userId, reason, id),
        c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id),
        auditStmt(c.env.DB, { actor: auth, action: "reception_qr.revoke", targetType: "user", targetId: id, reason }),
      ]);
      return c.json({ ok: true });
    },
  )
  // パスワード再設定(顧客・店員・店舗責任者・全体管理者)。メール送信は行わず、管理者が直接設定する
  .post(
    "/users/:id/reset-password",
    idParam,
    zValidator("json", z.object({ password: passwordSchema })),
    async (c) => {
      const auth = requireAuth(c);
      const { id } = c.req.valid("param");
      const { password } = c.req.valid("json");
      const target = await getUserBasic(c.env.DB, id);
      if (!target) throw notFound("ユーザーが見つかりません");
      if (target.role === "RECEPTION" && !target.login_id) throw badRequest("この受付担当者にはログインIDがありません。先にID・パスワードを設定してください");
      const hash = await hashPassword(password);
      await c.env.DB.batch([
        c.env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(hash, id),
        c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id),
        auditStmt(c.env.DB, { actor: auth, action: "user.reset_password", targetType: "user", targetId: id }),
      ]);
      return c.json({ ok: true });
    },
  )
  // 利用停止/再開。停止時はそのユーザーのセッションを破棄する
  .patch(
    "/users/:id/status",
    idParam,
    zValidator("json", z.object({ status: z.enum(["ACTIVE", "SUSPENDED"]) })),
    async (c) => {
      const auth = requireAuth(c);
      const { id } = c.req.valid("param");
      const { status } = c.req.valid("json");
      if (id === auth.userId) throw badRequest("自分自身のアカウントは停止できません");
      const target = await getUserBasic(c.env.DB, id);
      if (!target) throw notFound("ユーザーが見つかりません");
      await c.env.DB.batch([
        c.env.DB.prepare("UPDATE users SET status = ? WHERE id = ?").bind(status, id),
        ...(status === "SUSPENDED" ? [c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id)] : []),
        auditStmt(c.env.DB, {
          actor: auth,
          action: status === "SUSPENDED" ? "user.suspend" : "user.resume",
          targetType: "user",
          targetId: id,
          before: { status: target.status },
          after: { status },
        }),
      ]);
      return c.json({ ok: true });
    },
  )

  // ---------- 共通設定 ----------
  .get("/settings/currency", async (c) => c.json({ currency: await getCurrency(c.env.DB), defaults: DEFAULT_CURRENCY }))
  // 通貨表示の変更。内部の残高・過去の取引金額は一切変えない(名称・表示位置・説明だけ)
  .put("/settings/currency", zValidator("json", currencySchema), async (c) => {
    const auth = requireAuth(c);
    const next = c.req.valid("json");
    const before = await getCurrency(c.env.DB);
    await c.env.DB.batch([
      setSettingStmt(c.env.DB, SETTING_KEYS.currency, next, auth.userId),
      auditStmt(c.env.DB, { actor: auth, action: "settings.currency", targetType: "settings", targetId: SETTING_KEYS.currency, before, after: next }),
    ]);
    return c.json({ currency: next });
  })
  // 運用設定: 現金の締めの単位、顧客QRの有効時間
  .get("/settings/operations", async (c) => c.json({ operations: await getOperations(c.env.DB) }))
  .put(
    "/settings/operations",
    zValidator(
      "json",
      z.object({
        closingMode: z.enum(["DAY", "SHIFT", "MANUAL"]),
        qrTtlSeconds: z.number().int().min(60, "60秒以上にしてください").max(1800, "30分(1800秒)以内にしてください"),
        paymentSessionSeconds: z.number().int().min(60, "60秒以上にしてください").max(1800, "30分(1800秒)以内にしてください").optional(),
      }),
    ),
    async (c) => {
      const auth = requireAuth(c);
      const before = await getOperations(c.env.DB);
      // 送られなかった項目は、いまの値を保つ(古い画面・呼び出しが他の設定を壊さない)
      const next = { ...before, ...Object.fromEntries(Object.entries(c.req.valid("json")).filter(([, v]) => v !== undefined)) };
      await c.env.DB.batch([
        setSettingStmt(c.env.DB, SETTING_KEYS.operations, next, auth.userId),
        auditStmt(c.env.DB, { actor: auth, action: "settings.operations", targetType: "settings", targetId: SETTING_KEYS.operations, before, after: next }),
      ]);
      return c.json({ operations: next });
    },
  )
  .put(
    "/settings/festival-name",
    zValidator("json", z.object({ name: z.string().trim().min(1).max(50) })),
    async (c) => {
      const auth = requireAuth(c);
      const { name } = c.req.valid("json");
      await c.env.DB.batch([
        setSettingStmt(c.env.DB, SETTING_KEYS.festivalName, name, auth.userId),
        auditStmt(c.env.DB, { actor: auth, action: "settings.festival_name", targetType: "settings", targetId: SETTING_KEYS.festivalName, after: { name } }),
      ]);
      return c.json({ name });
    },
  )
  // 緊急停止: お金が動く入口(レジの読み取り・確定、受付のチャージ・払戻し、顧客のQR発行)を止める
  .get("/settings/emergency", async (c) => c.json({ emergency: await getEmergency(c.env.DB) }))
  .put(
    "/settings/emergency",
    zValidator("json", z.object({ on: z.boolean(), message: z.string().trim().max(100).default("") })),
    async (c) => {
      const auth = requireAuth(c);
      const next = c.req.valid("json");
      const before = await getEmergency(c.env.DB);
      await c.env.DB.batch([
        setSettingStmt(c.env.DB, EMERGENCY_KEY, next, auth.userId),
        auditStmt(c.env.DB, { actor: auth, action: next.on ? "emergency.start" : "emergency.end", targetType: "settings", targetId: EMERGENCY_KEY, before, after: next }),
      ]);
      c.header("Cache-Control", "no-store");
      return c.json({ emergency: next });
    },
  );
