import { Hono } from "hono";
import { z } from "zod";
import type { AutoDiscountDto, CouponDto, DiscountStatus, ItemTargetDto } from "@shared/api";
import type { AppEnv, AuthContext } from "../env";
import { auditStmt } from "../lib/audit";
import { normalizeCode } from "../lib/discounts";
import { badRequest, conflict, notFound } from "../lib/errors";
import { newId } from "../lib/ids";
import { zv as zValidator } from "../lib/validate";
import { assertShopAccess, requireAuth, requireRole } from "../middleware/auth";

const id26 = z.string().length(26);
const shopParam = zValidator("param", z.object({ shopId: id26 }));
const idParam = zValidator("param", z.object({ id: id26 }));
const yen = z.number().int("金額は整数で入力してください").min(1, "1以上にしてください").max(10_000_000);
const ms = z.number().int().min(0).nullable();

const ruleShape = {
  name: z.string().trim().min(1, "名前を入力してください").max(40, "名前は40文字以内にしてください"),
  method: z.enum(["PERCENT", "FIXED"]),
  value: z.number().int("値は整数で入力してください").min(1, "値は1以上にしてください").max(10_000_000),
  minOrderAmount: yen.nullable(),
  maxDiscountAmount: yen.nullable(),
  startsAt: ms,
  endsAt: ms,
  shopIds: z.array(id26).max(100),
  items: z.array(z.object({ type: z.enum(["PRODUCT", "TAG", "SET"]), id: id26 })).max(50).default([]),
};
type Rule = z.infer<z.ZodObject<typeof ruleShape>>;

function checkRule(b: Rule) {
  if (b.method === "PERCENT" && b.value > 100) throw badRequest("割合は100%以下にしてください");
  if (b.startsAt !== null && b.endsAt !== null && b.endsAt <= b.startsAt) throw badRequest("終了は開始より後にしてください");
}

const autoSchema = z.object({ ...ruleShape, combinableWithCoupon: z.boolean() });
const couponSchema = z.object({
  ...ruleShape,
  kind: z.enum(["COMMON", "ONE_TIME"]),
  code: z.string().trim().max(24).optional(),
  count: z.number().int().min(1).max(100).optional(),
  totalLimit: z.number().int().min(1).max(1_000_000).nullable(),
  perWalletLimit: z.number().int().min(1).max(1000).nullable(),
  /** 先着N人。totalLimit が人数、1人1回になる(共通コードのみ) */
  firstCome: z.boolean().optional(),
  combinableWithAuto: z.boolean(),
  note: z.string().trim().max(100).nullable(),
});
const statusSchema = z.object({ status: z.enum(["ACTIVE", "STOPPED"]) });

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function randomCode(len = 8): string {
  const b = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(b, (x) => CODE_ALPHABET[x % CODE_ALPHABET.length]).join("");
}

const stateOf = (status: DiscountStatus, startsAt: number | null, endsAt: number | null, now: number) =>
  status === "STOPPED" ? "STOPPED" : status === "ENDED" || (endsAt !== null && endsAt <= now) ? "ENDED" : startsAt !== null && startsAt > now ? "SCHEDULED" : "RUNNING";

/** 割引・クーポンの管理(全体管理者のみ。仕様 v0.2 §14.4) */
export const discountRoutes = new Hono<AppEnv>()
  .use("*", requireRole("ADMIN"))

  .get("/", async (c) => {
    const db = c.env.DB;
    const now = Date.now();
    const [d, t, u, coupons] = await Promise.all([
      db.prepare("SELECT * FROM discounts WHERE kind = 'AUTO' ORDER BY created_at DESC").all<DiscountRow>(),
      db.prepare("SELECT discount_id, target_id FROM discount_targets WHERE target_type = 'SHOP'").all<{ discount_id: string; target_id: string }>(),
      db
        .prepare("SELECT discount_id, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amt FROM order_discounts WHERE kind = 'AUTO' GROUP BY discount_id")
        .all<{ discount_id: string; n: number; amt: number }>(),
      loadCoupons(db, now),
    ]);
    const shops = (id: string) => t.results.filter((x) => x.discount_id === id).map((x) => x.target_id);
    const itemMap = await loadItemTargets(db);
    const autos: AutoDiscountDto[] = d.results.map((r) => ({
      id: r.id,
      name: r.name,
      method: r.method,
      value: r.value,
      minOrderAmount: r.min_order_amount,
      maxDiscountAmount: r.max_discount_amount,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      combinableWithCoupon: r.combinable_with_coupon === 1,
      status: r.status,
      shopIds: shops(r.id),
      items: itemMap.get(r.id) ?? [],
      state: stateOf(r.status, r.starts_at, r.ends_at, now),
      usedCount: u.results.find((x) => x.discount_id === r.id)?.n ?? 0,
      usedAmount: u.results.find((x) => x.discount_id === r.id)?.amt ?? 0,
    }));
    c.header("Cache-Control", "no-store");
    return c.json({ autos, coupons });
  })

  // 全ユーザー対象割引(条件を満たす注文に自動適用)
  .post("/auto", zValidator("json", autoSchema), async (c) => {
    const auth = requireAuth(c);
    const b = c.req.valid("json");
    checkRule(b);
    const db = c.env.DB;
    await assertShops(db, b.shopIds);
    await assertItems(db, b.items, b.shopIds);
    const id = newId();
    const now = Date.now();
    await db.batch([
      db
        .prepare(
          `INSERT INTO discounts (id, kind, name, method, value, min_order_amount, max_discount_amount, starts_at, ends_at, combinable_with_coupon, status, created_at, created_by)
           VALUES (?, 'AUTO', ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
        )
        .bind(id, b.name, b.method, b.value, b.minOrderAmount, b.maxDiscountAmount, b.startsAt, b.endsAt, b.combinableWithCoupon ? 1 : 0, now, auth.userId),
      ...b.shopIds.map((s) => db.prepare("INSERT INTO discount_targets (discount_id, target_type, target_id) VALUES (?, 'SHOP', ?)").bind(id, s)),
      ...b.items.map((i) => db.prepare("INSERT INTO discount_targets (discount_id, target_type, target_id) VALUES (?, ?, ?)").bind(id, i.type, i.id)),
      auditStmt(db, { actor: auth, action: "discount.create", targetType: "discount", targetId: id, after: { kind: "AUTO", name: b.name, method: b.method, value: b.value, shopIds: b.shopIds, items: b.items } }),
    ]);
    return c.json({ id }, 201);
  })

  .post("/auto/:id/status", idParam, zValidator("json", statusSchema), async (c) => {
    const auth = requireAuth(c);
    const { id } = c.req.valid("param");
    const { status } = c.req.valid("json");
    const db = c.env.DB;
    const cur = await db.prepare("SELECT status FROM discounts WHERE id = ? AND kind = 'AUTO'").bind(id).first<{ status: string }>();
    if (!cur) throw notFound("割引が見つかりません");
    await db.batch([
      db.prepare("UPDATE discounts SET status = ? WHERE id = ? AND kind = 'AUTO'").bind(status, id),
      auditStmt(db, { actor: auth, action: status === "ACTIVE" ? "discount.resume" : "discount.stop", targetType: "discount", targetId: id, before: { status: cur.status }, after: { status } }),
    ]);
    return c.json({ ok: true });
  })

  // クーポンの作成。ONE_TIME は count 枚ぶん、コードを自動で作る(共通の割引設定を共有)
  .post("/coupons", zValidator("json", couponSchema), async (c) => {
    const b = c.req.valid("json");
    return c.json({ codes: await createCoupons(c.env.DB, requireAuth(c), b, b.shopIds) }, 201);
  })

  .post("/coupons/:id/status", idParam, zValidator("json", statusSchema), async (c) => {
    await setCouponStatus(c.env.DB, requireAuth(c), c.req.valid("param").id, c.req.valid("json").status);
    return c.json({ ok: true });
  });

/** 店舗責任者の店舗限定クーポン。作れる種類・設定は全体管理者と同じで、対象の店舗だけが自店舗に固定される */
export const shopCouponRoutes = new Hono<AppEnv>()
  .use("*", requireRole("ADMIN", "SHOP_MANAGER"))
  .get("/:shopId", shopParam, async (c) => {
    const { shopId } = c.req.valid("param");
    assertShopAccess(requireAuth(c), shopId);
    c.header("Cache-Control", "no-store");
    return c.json({ coupons: await loadCoupons(c.env.DB, Date.now(), shopId) });
  })
  .post("/:shopId", shopParam, zValidator("json", couponSchema), async (c) => {
    const { shopId } = c.req.valid("param");
    const auth = requireAuth(c);
    assertShopAccess(auth, shopId);
    // 送られてきた対象店舗は無視して、自店舗だけにする
    return c.json({ codes: await createCoupons(c.env.DB, auth, c.req.valid("json"), [shopId]) }, 201);
  })
  .post("/:shopId/:id/status", zValidator("param", z.object({ shopId: id26, id: id26 })), zValidator("json", statusSchema), async (c) => {
    const { shopId, id } = c.req.valid("param");
    const auth = requireAuth(c);
    assertShopAccess(auth, shopId);
    await setCouponStatus(c.env.DB, auth, id, c.req.valid("json").status, shopId);
    return c.json({ ok: true });
  });

type CouponListRow = DiscountRow & {
  code: string;
  cstatus: DiscountStatus;
  total_limit: number | null;
  per_wallet_limit: number | null;
  used_count: number;
  first_come: number;
  note: string | null;
  discount_id: string;
  created_at: number;
};

/** クーポン一覧。shopId を渡すと、その店舗だけを対象にした店舗限定クーポンに絞る */
async function loadCoupons(db: D1Database, now: number, shopId?: string): Promise<CouponDto[]> {
  const onlyShop = shopId
    ? `WHERE EXISTS (SELECT 1 FROM discount_targets t WHERE t.discount_id = d.id AND t.target_type = 'SHOP' AND t.target_id = ?)
         AND (SELECT COUNT(*) FROM discount_targets t2 WHERE t2.discount_id = d.id AND t2.target_type = 'SHOP') = 1`
    : "";
  const stmt = db.prepare(
    `SELECT c.id, c.code, c.kind, c.total_limit, c.per_wallet_limit, c.used_count, c.first_come, c.status AS cstatus, c.note, c.created_at,
            d.name, d.method, d.value, d.min_order_amount, d.max_discount_amount, d.starts_at, d.ends_at, d.combinable_with_coupon, d.status, d.id AS discount_id
       FROM coupons c JOIN discounts d ON d.id = c.discount_id ${onlyShop} ORDER BY c.created_at DESC, c.code LIMIT 500`,
  );
  const [cp, t] = await Promise.all([
    (shopId ? stmt.bind(shopId) : stmt).all<CouponListRow>(),
    db.prepare("SELECT discount_id, target_id FROM discount_targets WHERE target_type = 'SHOP'").all<{ discount_id: string; target_id: string }>(),
  ]);
  const shops = (id: string) => t.results.filter((x) => x.discount_id === id).map((x) => x.target_id);
  const itemMap = await loadItemTargets(db);
  return cp.results.map((r) => {
    const base = stateOf(r.cstatus === "ACTIVE" ? r.status : r.cstatus, r.starts_at, r.ends_at, now);
    return {
      id: r.id,
      code: r.code,
      kind: r.kind as "COMMON" | "ONE_TIME",
      firstCome: r.first_come === 1,
      name: r.name,
      method: r.method,
      value: r.value,
      minOrderAmount: r.min_order_amount,
      maxDiscountAmount: r.max_discount_amount,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      combinableWithAuto: r.combinable_with_coupon === 1,
      totalLimit: r.total_limit,
      perWalletLimit: r.per_wallet_limit,
      usedCount: r.used_count,
      status: r.cstatus,
      state: base === "RUNNING" && r.total_limit !== null && r.used_count >= r.total_limit ? "USED_UP" : base,
      shopIds: shops(r.discount_id),
      items: itemMap.get(r.discount_id) ?? [],
      note: r.note,
      createdAt: r.created_at,
    } satisfies CouponDto;
  });
}

async function setCouponStatus(db: D1Database, auth: AuthContext, id: string, status: "ACTIVE" | "STOPPED", shopId?: string) {
  const cur = await db.prepare("SELECT c.status, c.code, c.discount_id FROM coupons c WHERE c.id = ?").bind(id).first<{ status: string; code: string; discount_id: string }>();
  if (!cur) throw notFound("クーポンが見つかりません");
  if (shopId) {
    // 店舗責任者は、自店舗だけが対象のクーポンしか操作できない(存在を隠すため、他は「見つからない」と同じ応答)
    const { results } = await db.prepare("SELECT target_id FROM discount_targets WHERE discount_id = ? AND target_type = 'SHOP'").bind(cur.discount_id).all<{ target_id: string }>();
    if (results.length !== 1 || results[0].target_id !== shopId) throw notFound("クーポンが見つかりません");
  }
  await db.batch([
    db.prepare("UPDATE coupons SET status = ? WHERE id = ?").bind(status, id),
    auditStmt(db, { actor: auth, action: status === "ACTIVE" ? "coupon.resume" : "coupon.stop", targetType: "coupon", targetId: id, before: { status: cur.status }, after: { status, code: cur.code } }),
  ]);
}

type CouponBody = z.infer<typeof couponSchema>;

/** クーポンを作る。shopIds が対象の店舗(空なら全店舗) */
async function createCoupons(db: D1Database, auth: AuthContext, b: CouponBody, shopIds: string[]): Promise<string[]> {
  checkRule(b);
  await assertShops(db, shopIds);
  await assertItems(db, b.items, shopIds);
  const firstCome = b.firstCome === true;
  if (firstCome) {
    if (b.kind !== "COMMON") throw badRequest("先着のクーポンは共通コードで作ってください");
    if (b.totalLimit === null) throw badRequest("先着の人数を入力してください");
  }
  let codes: string[];
  if (b.kind === "COMMON" && !b.code?.trim()) {
    codes = [randomCode()]; // 共通コードは空欄なら自動で作る
  } else if (b.code?.trim()) {
    const code = normalizeCode(b.code);
    if (!/^[A-Z0-9-]{3,24}$/.test(code)) throw badRequest("コードは英数字とハイフンの3〜24文字で入力してください");
    codes = [code];
  } else {
    codes = Array.from({ length: b.count ?? 1 }, () => randomCode());
  }
  const dup = await db
    .prepare(`SELECT code FROM coupons WHERE code IN (${codes.map(() => "?").join(",")}) LIMIT 1`)
    .bind(...codes)
    .first<{ code: string }>();
  if (dup) throw conflict(`コード ${dup.code} はすでに使われています`, "CODE_EXISTS");
  const discountId = newId();
  const now = Date.now();
  const totalLimit = b.kind === "ONE_TIME" ? 1 : b.totalLimit;
  const perWallet = b.kind === "ONE_TIME" ? null : firstCome ? 1 : b.perWalletLimit;
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO discounts (id, kind, name, method, value, min_order_amount, max_discount_amount, starts_at, ends_at, combinable_with_coupon, status, created_at, created_by)
           VALUES (?, 'COUPON', ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
        )
        .bind(discountId, b.name, b.method, b.value, b.minOrderAmount, b.maxDiscountAmount, b.startsAt, b.endsAt, b.combinableWithAuto ? 1 : 0, now, auth.userId),
      ...shopIds.map((s) => db.prepare("INSERT INTO discount_targets (discount_id, target_type, target_id) VALUES (?, 'SHOP', ?)").bind(discountId, s)),
      ...b.items.map((i) => db.prepare("INSERT INTO discount_targets (discount_id, target_type, target_id) VALUES (?, ?, ?)").bind(discountId, i.type, i.id)),
      ...codes.map((code) =>
        db
          .prepare(
            `INSERT INTO coupons (id, code, kind, discount_id, total_limit, per_wallet_limit, per_order_limit, used_count, status, note, created_at, created_by, first_come)
             VALUES (?, ?, ?, ?, ?, ?, 1, 0, 'ACTIVE', ?, ?, ?, ?)`,
          )
          .bind(newId(now), code, b.kind, discountId, totalLimit, perWallet, b.note, now, auth.userId, firstCome ? 1 : 0),
      ),
      auditStmt(db, {
        actor: auth,
        action: "coupon.create",
        targetType: "discount",
        targetId: discountId,
        after: { kind: b.kind, firstCome, name: b.name, method: b.method, value: b.value, count: codes.length, codes: codes.slice(0, 5), shopIds, items: b.items },
      }),
    ]);
  } catch (e) {
    if (String(e).includes("UNIQUE") && String(e).includes("code")) throw conflict("同じコードがすでにあります。もう一度お試しください", "CODE_EXISTS");
    throw e;
  }
  return codes;
}

interface DiscountRow {
  id: string;
  name: string;
  method: "PERCENT" | "FIXED";
  value: number;
  min_order_amount: number | null;
  max_discount_amount: number | null;
  starts_at: number | null;
  ends_at: number | null;
  combinable_with_coupon: number;
  status: DiscountStatus;
  kind?: string;
}

async function assertShops(db: D1Database, shopIds: string[]) {
  if (shopIds.length === 0) return;
  const { results } = await db.prepare(`SELECT id FROM shops WHERE id IN (${shopIds.map(() => "?").join(",")})`).bind(...shopIds).all();
  if (results.length !== new Set(shopIds).size) throw badRequest("存在しない店舗が含まれています");
}

/** 商品・タグ・セットで対象を絞る指定が、実在し、対象の店舗の持ち物かを確かめる(店舗を指定しないときは、どの店舗のものでもよい) */
async function assertItems(db: D1Database, items: { type: "PRODUCT" | "TAG" | "SET"; id: string }[], shopIds: string[]) {
  if (items.length === 0) return;
  const table = { PRODUCT: "products", TAG: "tags", SET: "sets" } as const;
  for (const type of ["PRODUCT", "TAG", "SET"] as const) {
    const ids = [...new Set(items.filter((i) => i.type === type).map((i) => i.id))];
    if (ids.length === 0) continue;
    const { results } = await db
      .prepare(`SELECT id, shop_id FROM ${table[type]} WHERE id IN (${ids.map(() => "?").join(",")})`)
      .bind(...ids)
      .all<{ id: string; shop_id: string }>();
    if (results.length !== ids.length) throw badRequest("存在しない商品・タグ・セットが含まれています");
    if (shopIds.length > 0 && results.some((r) => !shopIds.includes(r.shop_id))) throw badRequest("対象の店舗に含まれない商品・タグ・セットが指定されています");
  }
}

async function loadItemTargets(db: D1Database): Promise<Map<string, ItemTargetDto[]>> {
  const { results } = await db
    .prepare(
      `SELECT t.discount_id, t.target_type AS type, t.target_id AS id, COALESCE(p.name, g.name, s.name, '(削除済み)') AS name
         FROM discount_targets t
         LEFT JOIN products p ON t.target_type = 'PRODUCT' AND p.id = t.target_id
         LEFT JOIN tags g ON t.target_type = 'TAG' AND g.id = t.target_id
         LEFT JOIN sets s ON t.target_type = 'SET' AND s.id = t.target_id
        WHERE t.target_type <> 'SHOP'`,
    )
    .all<{ discount_id: string; type: ItemTargetDto["type"]; id: string; name: string }>();
  const m = new Map<string, ItemTargetDto[]>();
  for (const r of results) m.set(r.discount_id, [...(m.get(r.discount_id) ?? []), { type: r.type, id: r.id, name: r.name }]);
  return m;
}
