import { Hono } from "hono";
import { z } from "zod";
import type { PriceCutDto, ProductDto, TagDto } from "@shared/api";
import type { AppEnv } from "../env";
import { auditStmt, auditStmtIfExists } from "../lib/audit";
import { bumpCatalogStmt, loadProducts, loadRunningCut, toCutDto } from "../lib/catalog";
import { badRequest, conflict, notFound } from "../lib/errors";
import { newId } from "../lib/ids";
import { zv as zValidator } from "../lib/validate";
import { assertShopAccess, requireAuth, requireRole } from "../middleware/auth";

const id26 = z.string().length(26);
const shopParam = zValidator("param", z.object({ shopId: id26 }));
const productParam = zValidator("param", z.object({ shopId: id26, productId: id26 }));
const tagParam = zValidator("param", z.object({ shopId: id26, tagId: id26 }));
const cutParam = zValidator("param", z.object({ shopId: id26, cutId: id26 }));

const priceSchema = z.number().int("価格は整数で入力してください").min(0, "価格は0以上にしてください").max(10_000_000);
const saleModeSchema = z.enum(["BOTH", "SINGLE_ONLY", "SET_ONLY"]);

const productBase = {
  name: z.string().trim().min(1, "商品名を入力してください").max(60, "商品名は60文字以内にしてください"),
  price: priceSchema.nullable(),
  description: z.string().trim().max(300).nullable().optional(),
  saleMode: saleModeSchema,
  discountable: z.boolean(),
  sortOrder: z.number().int().min(0).max(100000),
  tagIds: z.array(id26).max(20),
};

/** 販売形態と価格の整合(セット限定以外は価格が必要) */
function assertPriceForMode(saleMode: string, price: number | null) {
  if (saleMode !== "SET_ONLY" && price === null) throw badRequest("単品で売る商品には価格が必要です");
}

async function assertTagsBelongToShop(db: D1Database, shopId: string, tagIds: string[]) {
  if (tagIds.length === 0) return;
  const { results } = await db
    .prepare(`SELECT id FROM tags WHERE shop_id = ? AND id IN (${tagIds.map(() => "?").join(",")})`)
    .bind(shopId, ...tagIds)
    .all<{ id: string }>();
  if (new Set(results.map((r) => r.id)).size !== new Set(tagIds).size) throw badRequest("存在しないタグが含まれています");
}

/**
 * 店舗責任者の商品管理API。商品・タグ・在庫・一律値下げ。
 * 変更はすべて shops.catalog_version を増やし、POS 画面へリアルタイムに反映される。
 */
export const catalogRoutes = new Hono<AppEnv>()
  .use("*", requireRole("SHOP_MANAGER", "ADMIN"))

  // ---------- 一覧 ----------
  .get("/:shopId/products", shopParam, async (c) => {
    const auth = requireAuth(c);
    const { shopId } = c.req.valid("param");
    assertShopAccess(auth, shopId);
    const cut = await loadRunningCut(c.env.DB, shopId, Date.now());
    const products: ProductDto[] = await loadProducts(c.env.DB, shopId, { cut, includeArchived: true });
    return c.json({ products, cut });
  })
  .get("/:shopId/tags", shopParam, async (c) => {
    const auth = requireAuth(c);
    const { shopId } = c.req.valid("param");
    assertShopAccess(auth, shopId);
    const { results } = await c.env.DB.prepare("SELECT id, name, color, active FROM tags WHERE shop_id = ? ORDER BY sort_order, name")
      .bind(shopId)
      .all<{ id: string; name: string; color: string | null; active: number }>();
    const tags: TagDto[] = results.map((t) => ({ id: t.id, name: t.name, color: t.color, active: t.active === 1 }));
    return c.json({ tags });
  })

  // ---------- タグ ----------
  .post(
    "/:shopId/tags",
    shopParam,
    zValidator("json", z.object({ name: z.string().trim().min(1, "タグ名を入力してください").max(20), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional() })),
    async (c) => {
      const auth = requireAuth(c);
      const { shopId } = c.req.valid("param");
      assertShopAccess(auth, shopId);
      const b = c.req.valid("json");
      const tagId = newId();
      try {
        await c.env.DB.batch([
          c.env.DB.prepare("INSERT INTO tags (id, shop_id, name, color) VALUES (?, ?, ?, ?)").bind(tagId, shopId, b.name, b.color ?? null),
          bumpCatalogStmt(c.env.DB, shopId),
          auditStmt(c.env.DB, { actor: auth, action: "tag.create", targetType: "tag", targetId: tagId, after: { name: b.name } }),
        ]);
      } catch (e) {
        if (String(e).includes("UNIQUE")) throw conflict("同じ名前のタグがすでにあります", "TAG_EXISTS");
        throw e;
      }
      return c.json({ id: tagId }, 201);
    },
  )
  .patch(
    "/:shopId/tags/:tagId",
    tagParam,
    zValidator("json", z.object({ name: z.string().trim().min(1).max(20).optional(), active: z.boolean().optional() })),
    async (c) => {
      const auth = requireAuth(c);
      const { shopId, tagId } = c.req.valid("param");
      assertShopAccess(auth, shopId);
      const b = c.req.valid("json");
      const t = await c.env.DB.prepare("SELECT name, active FROM tags WHERE id = ? AND shop_id = ?").bind(tagId, shopId).first<{ name: string; active: number }>();
      if (!t) throw notFound("タグが見つかりません");
      try {
        await c.env.DB.batch([
          c.env.DB.prepare("UPDATE tags SET name = ?, active = ? WHERE id = ? AND shop_id = ?").bind(b.name ?? t.name, (b.active ?? t.active === 1) ? 1 : 0, tagId, shopId),
          bumpCatalogStmt(c.env.DB, shopId),
          auditStmt(c.env.DB, { actor: auth, action: "tag.update", targetType: "tag", targetId: tagId, before: t, after: b }),
        ]);
      } catch (e) {
        if (String(e).includes("UNIQUE")) throw conflict("同じ名前のタグがすでにあります", "TAG_EXISTS");
        throw e;
      }
      return c.json({ ok: true });
    },
  )

  // ---------- 商品 ----------
  .post(
    "/:shopId/products",
    shopParam,
    zValidator(
      "json",
      z.object({ ...productBase, trackStock: z.boolean(), stockQty: z.number().int().min(0).max(1_000_000).nullable().optional() }),
    ),
    async (c) => {
      const auth = requireAuth(c);
      const { shopId } = c.req.valid("param");
      assertShopAccess(auth, shopId);
      const b = c.req.valid("json");
      assertPriceForMode(b.saleMode, b.price);
      if (b.trackStock && (b.stockQty === null || b.stockQty === undefined)) throw badRequest("数量を管理する商品は、準備数量を入力してください");
      const db = c.env.DB;
      const shop = await db.prepare("SELECT status FROM shops WHERE id = ?").bind(shopId).first<{ status: string }>();
      if (!shop) throw notFound("店舗が見つかりません");
      await assertTagsBelongToShop(db, shopId, b.tagIds);
      const id = newId();
      const now = Date.now();
      const qty = b.trackStock ? (b.stockQty ?? 0) : null;
      await db.batch([
        db
          .prepare(
            `INSERT INTO products (id, shop_id, name, price, description, sale_mode, status, manual_sold_out, track_stock, stock_qty, discountable, sort_order, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', 0, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(id, shopId, b.name, b.price, b.description ?? null, b.saleMode, b.trackStock ? 1 : 0, qty, b.discountable ? 1 : 0, b.sortOrder, now, now),
        ...[...new Set(b.tagIds)].map((t) => db.prepare("INSERT INTO product_tags (product_id, tag_id) VALUES (?, ?)").bind(id, t)),
        ...(qty && qty > 0
          ? [
              db
                .prepare(
                  `INSERT INTO stock_movements (id, product_id, delta, qty_after, reason, operator_user_id, created_at) VALUES (?, ?, ?, ?, 'INITIAL', ?, ?)`,
                )
                .bind(newId(), id, qty, qty, auth.userId, now),
            ]
          : []),
        bumpCatalogStmt(db, shopId),
        auditStmt(db, { actor: auth, action: "product.create", targetType: "product", targetId: id, after: { name: b.name, price: b.price, saleMode: b.saleMode } }),
      ]);
      return c.json({ id }, 201);
    },
  )
  .patch(
    "/:shopId/products/:productId",
    productParam,
    zValidator(
      "json",
      z.object({
        name: productBase.name.optional(),
        price: productBase.price.optional(),
        description: productBase.description,
        saleMode: saleModeSchema.optional(),
        status: z.enum(["ACTIVE", "STOPPED", "ARCHIVED"]).optional(),
        discountable: z.boolean().optional(),
        sortOrder: productBase.sortOrder.optional(),
        tagIds: productBase.tagIds.optional(),
      }),
    ),
    async (c) => {
      const auth = requireAuth(c);
      const { shopId, productId } = c.req.valid("param");
      assertShopAccess(auth, shopId);
      const b = c.req.valid("json");
      const db = c.env.DB;
      const cur = await db
        .prepare("SELECT name, price, description, sale_mode, status, discountable, sort_order FROM products WHERE id = ? AND shop_id = ?")
        .bind(productId, shopId)
        .first<{ name: string; price: number | null; description: string | null; sale_mode: string; status: string; discountable: number; sort_order: number }>();
      if (!cur) throw notFound("商品が見つかりません");
      if (cur.status === "ARCHIVED" && b.status === undefined) throw badRequest("アーカイブ済みの商品は変更できません");
      const next = {
        name: b.name ?? cur.name,
        price: b.price === undefined ? cur.price : b.price,
        description: b.description === undefined ? cur.description : b.description,
        saleMode: b.saleMode ?? cur.sale_mode,
        status: b.status ?? cur.status,
        discountable: b.discountable ?? cur.discountable === 1,
        sortOrder: b.sortOrder ?? cur.sort_order,
      };
      assertPriceForMode(next.saleMode, next.price);
      if (b.tagIds) await assertTagsBelongToShop(db, shopId, b.tagIds);
      await db.batch([
        db
          .prepare(
            `UPDATE products SET name = ?, price = ?, description = ?, sale_mode = ?, status = ?, discountable = ?, sort_order = ?, updated_at = ? WHERE id = ? AND shop_id = ?`,
          )
          .bind(next.name, next.price, next.description, next.saleMode, next.status, next.discountable ? 1 : 0, next.sortOrder, Date.now(), productId, shopId),
        ...(b.tagIds
          ? [
              db.prepare("DELETE FROM product_tags WHERE product_id = ?").bind(productId),
              ...[...new Set(b.tagIds)].map((t) => db.prepare("INSERT INTO product_tags (product_id, tag_id) VALUES (?, ?)").bind(productId, t)),
            ]
          : []),
        bumpCatalogStmt(db, shopId),
        auditStmt(db, {
          actor: auth,
          action: b.status && b.status !== cur.status ? `product.${b.status.toLowerCase()}` : "product.update",
          targetType: "product",
          targetId: productId,
          before: { name: cur.name, price: cur.price, saleMode: cur.sale_mode, status: cur.status },
          after: { name: next.name, price: next.price, saleMode: next.saleMode, status: next.status },
        }),
      ]);
      return c.json({ ok: true });
    },
  )
  // 数量管理の切り替え(オン: 準備数量が必要 / オフ: 残数の計算をやめる)
  .post(
    "/:shopId/products/:productId/stock-mode",
    productParam,
    zValidator("json", z.object({ trackStock: z.boolean(), stockQty: z.number().int().min(0).max(1_000_000).optional() })),
    async (c) => {
      const auth = requireAuth(c);
      const { shopId, productId } = c.req.valid("param");
      assertShopAccess(auth, shopId);
      const b = c.req.valid("json");
      const db = c.env.DB;
      const cur = await db.prepare("SELECT track_stock FROM products WHERE id = ? AND shop_id = ? AND status <> 'ARCHIVED'").bind(productId, shopId).first<{ track_stock: number }>();
      if (!cur) throw notFound("商品が見つかりません");
      if (b.trackStock && cur.track_stock === 0 && b.stockQty === undefined) throw badRequest("準備数量を入力してください");
      if (b.trackStock === (cur.track_stock === 1)) return c.json({ ok: true });
      const now = Date.now();
      await db.batch([
        db
          .prepare("UPDATE products SET track_stock = ?, stock_qty = ?, updated_at = ? WHERE id = ? AND shop_id = ?")
          .bind(b.trackStock ? 1 : 0, b.trackStock ? b.stockQty! : null, now, productId, shopId),
        ...(b.trackStock && b.stockQty
          ? [
              db
                .prepare(`INSERT INTO stock_movements (id, product_id, delta, qty_after, reason, operator_user_id, created_at) VALUES (?, ?, ?, ?, 'INITIAL', ?, ?)`)
                .bind(newId(), productId, b.stockQty, b.stockQty, auth.userId, now),
            ]
          : []),
        bumpCatalogStmt(db, shopId),
        auditStmt(db, { actor: auth, action: b.trackStock ? "product.stock_on" : "product.stock_off", targetType: "product", targetId: productId }),
      ]);
      return c.json({ ok: true });
    },
  )
  // 在庫の増減(追加準備・廃棄・棚卸調整)。同時に売れた場合に備え、見ていた残数と違えば409
  .post(
    "/:shopId/products/:productId/stock",
    productParam,
    zValidator(
      "json",
      z.object({
        delta: z.number().int().min(-1_000_000).max(1_000_000).refine((n) => n !== 0, "増減は0以外にしてください"),
        reason: z.enum(["RESTOCK", "ADJUST", "DISCARD"]),
        expectedQty: z.number().int().min(0),
        note: z.string().trim().max(200).optional(),
      }),
    ),
    async (c) => {
      const auth = requireAuth(c);
      const { shopId, productId } = c.req.valid("param");
      assertShopAccess(auth, shopId);
      const b = c.req.valid("json");
      if (b.reason === "RESTOCK" && b.delta < 0) throw badRequest("追加準備は正の数にしてください");
      if (b.reason === "DISCARD" && b.delta > 0) throw badRequest("廃棄は負の数にしてください");
      const db = c.env.DB;
      const cur = await db.prepare("SELECT track_stock, stock_qty FROM products WHERE id = ? AND shop_id = ? AND status <> 'ARCHIVED'").bind(productId, shopId).first<{ track_stock: number; stock_qty: number | null }>();
      if (!cur) throw notFound("商品が見つかりません");
      if (cur.track_stock !== 1 || cur.stock_qty === null) throw badRequest("この商品は数量管理をしていません");
      if (cur.stock_qty !== b.expectedQty) throw conflict("残数が変わりました。画面を更新して確認してください", "STOCK_CHANGED");
      const after = cur.stock_qty + b.delta;
      if (after < 0) throw badRequest("残数がマイナスになります");
      const now = Date.now();
      const results = await db.batch([
        // 見ていた残数のままのときだけ更新する(同時に売れていたら 0 行)
        db
          .prepare("UPDATE products SET stock_qty = ?, updated_at = ? WHERE id = ? AND shop_id = ? AND track_stock = 1 AND stock_qty = ?")
          .bind(after, now, productId, shopId, cur.stock_qty),
        db
          .prepare(
            `INSERT INTO stock_movements (id, product_id, delta, qty_after, reason, operator_user_id, note, created_at)
             SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM products WHERE id = ? AND stock_qty = ? AND updated_at = ?)`,
          )
          .bind(newId(), productId, b.delta, after, b.reason, auth.userId, b.note ?? null, now, productId, after, now),
        bumpCatalogStmt(db, shopId),
        auditStmtIfExists(
          db,
          { actor: auth, action: `stock.${b.reason.toLowerCase()}`, targetType: "product", targetId: productId, before: { qty: cur.stock_qty }, after: { qty: after }, reason: b.note },
          "SELECT 1 FROM products WHERE id = ? AND stock_qty = ? AND updated_at = ?",
          [productId, after, now],
        ),
      ]);
      if ((results[0].meta.changes ?? 0) === 0) throw conflict("残数が変わりました。画面を更新して確認してください", "STOCK_CHANGED");
      return c.json({ stockQty: after });
    },
  )

  // ---------- 定価の一律値下げ ----------
  .get("/:shopId/price-cuts", shopParam, async (c) => {
    const auth = requireAuth(c);
    const { shopId } = c.req.valid("param");
    assertShopAccess(auth, shopId);
    const now = Date.now();
    const { results } = await c.env.DB
      .prepare("SELECT id, name, method, value, starts_at, ends_at, status, created_at FROM shop_price_cuts WHERE shop_id = ? ORDER BY created_at DESC LIMIT 50")
      .bind(shopId)
      .all<Parameters<typeof toCutDto>[0]>();
    const cuts: PriceCutDto[] = results.map((r) => toCutDto(r, now));
    return c.json({ cuts });
  })
  .post(
    "/:shopId/price-cuts",
    shopParam,
    zValidator(
      "json",
      z
        .object({
          name: z.string().trim().min(1, "名前を入力してください").max(40),
          method: z.enum(["PERCENT", "FIXED"]),
          value: z.number().int("整数で入力してください").min(1, "1以上にしてください").max(1_000_000),
          startsAt: z.number().int().nullable().optional(),
          endsAt: z.number().int().nullable().optional(),
        })
        .refine((b) => b.method !== "PERCENT" || b.value <= 100, { message: "割合は100%以下にしてください", path: ["value"] })
        .refine((b) => !b.startsAt || !b.endsAt || b.endsAt > b.startsAt, { message: "終了は開始より後にしてください", path: ["endsAt"] }),
    ),
    async (c) => {
      const auth = requireAuth(c);
      const { shopId } = c.req.valid("param");
      assertShopAccess(auth, shopId);
      const b = c.req.valid("json");
      const db = c.env.DB;
      const now = Date.now();
      if (b.endsAt && b.endsAt <= now) throw badRequest("終了時刻は現在より後にしてください");
      const shop = await db.prepare("SELECT 1 FROM shops WHERE id = ?").bind(shopId).first();
      if (!shop) throw notFound("店舗が見つかりません");
      const id = newId();
      try {
        await db.batch([
          // 期限が過ぎた設定を整理してから作る(同時に有効な設定は1件)
          db.prepare("UPDATE shop_price_cuts SET status = 'ENDED' WHERE shop_id = ? AND status = 'ACTIVE' AND ends_at IS NOT NULL AND ends_at <= ?").bind(shopId, now),
          db
            .prepare(
              `INSERT INTO shop_price_cuts (id, shop_id, name, method, value, starts_at, ends_at, status, created_at, created_by)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
            )
            .bind(id, shopId, b.name, b.method, b.value, b.startsAt ?? null, b.endsAt ?? null, now, auth.userId),
          bumpCatalogStmt(db, shopId),
          auditStmt(db, { actor: auth, action: "price_cut.create", targetType: "shop", targetId: shopId, after: { id, name: b.name, method: b.method, value: b.value, startsAt: b.startsAt ?? null, endsAt: b.endsAt ?? null } }),
        ]);
      } catch (e) {
        if (String(e).includes("UNIQUE")) throw conflict("すでに値下げが設定されています。先に停止してください", "PRICE_CUT_EXISTS");
        throw e;
      }
      return c.json({ id }, 201);
    },
  )
  .post("/:shopId/price-cuts/:cutId/stop", cutParam, async (c) => {
    const auth = requireAuth(c);
    const { shopId, cutId } = c.req.valid("param");
    assertShopAccess(auth, shopId);
    const db = c.env.DB;
    const now = Date.now();
    const cut = await db.prepare("SELECT name, status FROM shop_price_cuts WHERE id = ? AND shop_id = ?").bind(cutId, shopId).first<{ name: string; status: string }>();
    if (!cut) throw notFound("値下げが見つかりません");
    if (cut.status !== "ACTIVE") throw badRequest("すでに終わっています");
    await db.batch([
      db.prepare("UPDATE shop_price_cuts SET status = 'STOPPED', stopped_at = ?, stopped_by = ? WHERE id = ? AND shop_id = ? AND status = 'ACTIVE'").bind(now, auth.userId, cutId, shopId),
      bumpCatalogStmt(db, shopId),
      auditStmtIfExists(db, { actor: auth, action: "price_cut.stop", targetType: "shop", targetId: shopId, after: { id: cutId, name: cut.name } }, "SELECT 1 FROM shop_price_cuts WHERE id = ? AND status = 'STOPPED' AND stopped_at = ?", [cutId, now]),
    ]);
    return c.json({ ok: true });
  });
