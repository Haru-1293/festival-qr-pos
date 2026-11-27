import { assertMenuImage, dropMenuImageIfUnused, menuImageKeySchema } from "../lib/menuImages";
import { Hono } from "hono";
import { z } from "zod";
import type { SetDto } from "@shared/api";
import type { AppEnv } from "../env";
import { auditStmt } from "../lib/audit";
import { bumpCatalogStmt, loadRunningCut } from "../lib/catalog";
import { badRequest, notFound } from "../lib/errors";
import { newId } from "../lib/ids";
import { loadSets } from "../lib/sets";
import { zv as zValidator } from "../lib/validate";
import { assertShopAccess, requireAuth, requireRole } from "../middleware/auth";

const id26 = z.string().length(26);
const shopParam = zValidator("param", z.object({ shopId: id26 }));
const setParam = zValidator("param", z.object({ shopId: id26, setId: id26 }));

const yen = z.number().int("金額は整数で入力してください").min(0, "金額は0以上にしてください").max(10_000_000);

const setSchema = z.object({
  name: z.string().trim().min(1, "セット名を入力してください").max(60, "セット名は60文字以内にしてください"),
  price: yen,
  description: z.string().trim().max(300).nullable().optional(),
  /** メニュー画像(アップロード済みのキー)。省略=変えない(作成時は画像なし)、null=外す */
  imageKey: menuImageKeySchema.nullable().optional(),
  discountable: z.boolean(),
  sortOrder: z.number().int().min(0).max(100000),
  segments: z
    .array(
      z.object({
        id: id26.optional(),
        name: z.string().trim().min(1, "内訳の名前を入力してください").max(30, "内訳の名前は30文字以内にしてください"),
        required: z.boolean(),
        pickCount: z.number().int().min(1, "選ぶ数は1以上にしてください").max(10, "選ぶ数は10までです"),
        allowDuplicate: z.boolean(),
        items: z.array(z.object({ productId: id26, surcharge: yen })).min(1, "各内訳に商品を1つ以上入れてください").max(40),
      }),
    )
    .min(1, "内訳を1つ以上作ってください")
    .max(8, "内訳は8つまでです"),
});
type SetBody = z.infer<typeof setSchema>;

/** 内訳の商品が自店舗のもので、セットに入れられる(単品専用・アーカイブ済みでない)ことを確かめる */
async function assertSegments(db: D1Database, shopId: string, b: SetBody) {
  const ids = [...new Set(b.segments.flatMap((g) => g.items.map((i) => i.productId)))];
  const { results } = await db
    .prepare(`SELECT id, name, sale_mode, status FROM products WHERE shop_id = ? AND id IN (${ids.map(() => "?").join(",")})`)
    .bind(shopId, ...ids)
    .all<{ id: string; name: string; sale_mode: string; status: string }>();
  const byId = new Map(results.map((r) => [r.id, r]));
  for (const g of b.segments) {
    const seen = new Set<string>();
    for (const i of g.items) {
      const p = byId.get(i.productId);
      if (!p) throw badRequest("存在しない商品が含まれています");
      if (p.status === "ARCHIVED") throw badRequest(`${p.name} はアーカイブ済みのため入れられません`);
      if (p.sale_mode === "SINGLE_ONLY") throw badRequest(`${p.name} は「単品のみ」の商品のため、セットには入れられません`);
      if (seen.has(i.productId)) throw badRequest(`「${g.name}」に同じ商品が重複しています`);
      seen.add(i.productId);
    }
    if (!g.allowDuplicate && g.pickCount > g.items.length) {
      throw badRequest(`「${g.name}」は重複不可のため、選ぶ数(${g.pickCount})より多い商品が必要です`);
    }
  }
}

/** 店舗責任者のセット管理API。変更は catalog_version を増やし、レジへ反映される */
export const setRoutes = new Hono<AppEnv>()
  .use("*", requireRole("SHOP_MANAGER", "ADMIN"))

  .get("/:shopId/sets", shopParam, async (c) => {
    const auth = requireAuth(c);
    const { shopId } = c.req.valid("param");
    assertShopAccess(auth, shopId);
    const cut = await loadRunningCut(c.env.DB, shopId, Date.now());
    const sets: SetDto[] = await loadSets(c.env.DB, shopId, { cut, includeArchived: true });
    return c.json({ sets, cut });
  })

  .post("/:shopId/sets", shopParam, zValidator("json", setSchema), async (c) => {
    const auth = requireAuth(c);
    const { shopId } = c.req.valid("param");
    assertShopAccess(auth, shopId);
    const b = c.req.valid("json");
    const db = c.env.DB;
    await assertSegments(db, shopId, b);
    await assertMenuImage(c.env, b.imageKey);
    const id = newId();
    const now = Date.now();
    await db.batch([
      db
        .prepare(
          `INSERT INTO sets (id, shop_id, name, price, description, image_key, status, manual_sold_out, discountable, sort_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', 0, ?, ?, ?, ?)`,
        )
        .bind(id, shopId, b.name, b.price, b.description ?? null, b.imageKey ?? null, b.discountable ? 1 : 0, b.sortOrder, now, now),
      ...segmentStmts(db, id, b, []),
      bumpCatalogStmt(db, shopId),
      auditStmt(db, { actor: auth, action: "set.create", targetType: "set", targetId: id, after: { name: b.name, price: b.price, segments: b.segments.length } }),
    ]);
    return c.json({ id }, 201);
  })

  // 内訳IDを渡した内訳は残し(カートの選択が壊れないように)、渡していない内訳は削除、新しい内訳は追加する
  .put("/:shopId/sets/:setId", setParam, zValidator("json", setSchema), async (c) => {
    const auth = requireAuth(c);
    const { shopId, setId } = c.req.valid("param");
    assertShopAccess(auth, shopId);
    const b = c.req.valid("json");
    const db = c.env.DB;
    const cur = await db
      .prepare("SELECT name, price, image_key FROM sets WHERE id = ? AND shop_id = ? AND status <> 'ARCHIVED'")
      .bind(setId, shopId)
      .first<{ name: string; price: number; image_key: string | null }>();
    if (!cur) throw notFound("セットが見つかりません");
    await assertSegments(db, shopId, b);
    await assertMenuImage(c.env, b.imageKey);
    const nextImage = b.imageKey === undefined ? cur.image_key : b.imageKey;
    const { results: old } = await db.prepare("SELECT id FROM set_segments WHERE set_id = ?").bind(setId).all<{ id: string }>();
    const oldIds = old.map((o) => o.id);
    for (const g of b.segments) if (g.id && !oldIds.includes(g.id)) throw badRequest("このセットの内訳ではありません");
    const now = Date.now();
    await db.batch([
      db
        .prepare("UPDATE sets SET name = ?, price = ?, description = ?, image_key = ?, discountable = ?, sort_order = ?, updated_at = ? WHERE id = ? AND shop_id = ?")
        .bind(b.name, b.price, b.description ?? null, nextImage, b.discountable ? 1 : 0, b.sortOrder, now, setId, shopId),
      ...segmentStmts(db, setId, b, oldIds),
      bumpCatalogStmt(db, shopId),
      auditStmt(db, {
        actor: auth,
        action: "set.update",
        targetType: "set",
        targetId: setId,
        before: { name: cur.name, price: cur.price },
        after: { name: b.name, price: b.price, segments: b.segments.length },
      }),
    ]);
    if (cur.image_key && cur.image_key !== nextImage) c.executionCtx.waitUntil(dropMenuImageIfUnused(c.env, cur.image_key));
    return c.json({ ok: true });
  })

  // 販売停止・再開・アーカイブ(売った実績の履歴を壊さないため削除はしない)
  .post("/:shopId/sets/:setId/status", setParam, zValidator("json", z.object({ status: z.enum(["ACTIVE", "STOPPED", "ARCHIVED"]) })), async (c) => {
    const auth = requireAuth(c);
    const { shopId, setId } = c.req.valid("param");
    assertShopAccess(auth, shopId);
    const { status } = c.req.valid("json");
    const db = c.env.DB;
    const cur = await db.prepare("SELECT status FROM sets WHERE id = ? AND shop_id = ?").bind(setId, shopId).first<{ status: string }>();
    if (!cur) throw notFound("セットが見つかりません");
    await db.batch([
      db.prepare("UPDATE sets SET status = ?, updated_at = ? WHERE id = ? AND shop_id = ?").bind(status, Date.now(), setId, shopId),
      bumpCatalogStmt(db, shopId),
      auditStmt(db, { actor: auth, action: "set.status", targetType: "set", targetId: setId, before: { status: cur.status }, after: { status } }),
    ]);
    return c.json({ ok: true });
  });

/** 内訳の更新。old は更新前の内訳ID。渡された内訳IDは UPDATE、なければ INSERT、残りは削除 */
function segmentStmts(db: D1Database, setId: string, b: SetBody, old: string[]): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [];
  const keep = new Set(b.segments.map((g) => g.id).filter((x): x is string => !!x));
  for (const oid of old) {
    stmts.push(db.prepare("DELETE FROM set_segment_items WHERE segment_id = ?").bind(oid));
    if (!keep.has(oid)) stmts.push(db.prepare("DELETE FROM set_segments WHERE id = ?").bind(oid));
  }
  b.segments.forEach((g, gi) => {
    const sid = g.id ?? newId();
    if (g.id) {
      stmts.push(
        db
          .prepare("UPDATE set_segments SET name = ?, required = ?, pick_count = ?, allow_duplicate = ?, sort_order = ? WHERE id = ?")
          .bind(g.name, g.required ? 1 : 0, g.pickCount, g.allowDuplicate ? 1 : 0, gi, sid),
      );
    } else {
      stmts.push(
        db
          .prepare("INSERT INTO set_segments (id, set_id, name, required, pick_count, allow_duplicate, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .bind(sid, setId, g.name, g.required ? 1 : 0, g.pickCount, g.allowDuplicate ? 1 : 0, gi),
      );
    }
    g.items.forEach((i, ii) =>
      stmts.push(
        db.prepare("INSERT INTO set_segment_items (segment_id, product_id, surcharge, sort_order) VALUES (?, ?, ?, ?)").bind(sid, i.productId, i.surcharge, ii),
      ),
    );
  });
  return stmts;
}
