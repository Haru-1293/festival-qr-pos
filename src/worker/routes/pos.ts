import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { auditStmtIfExists } from "../lib/audit";
import { bumpCatalogStmt, buildPosCatalog } from "../lib/catalog";
import { notFound } from "../lib/errors";
import { zv as zValidator } from "../lib/validate";
import { assertShopAccess, requireAuth, requireRole } from "../middleware/auth";

const shopParam = zValidator("param", z.object({ shopId: z.string().length(26) }));
const productParam = zValidator("param", z.object({ shopId: z.string().length(26), productId: z.string().length(26) }));

/** 店員・店舗責任者向けの POS API(会計画面が使う)。自店舗のものだけ操作できる */
export const posRoutes = new Hono<AppEnv>()
  .use("*", requireRole("CLERK", "SHOP_MANAGER", "ADMIN"))

  // 商品一覧(値下げ後の価格つき)。`sig` に前回の署名を付けると、変わっていなければ changed:false だけ返す
  .get("/:shopId/catalog", shopParam, zValidator("query", z.object({ sig: z.string().max(60).optional() })), async (c) => {
    const auth = requireAuth(c);
    const { shopId } = c.req.valid("param");
    assertShopAccess(auth, shopId);
    c.header("Cache-Control", "no-store");
    return c.json(await buildPosCatalog(c.env.DB, shopId, c.req.valid("query").sig));
  })

  // 手動の売り切れ/販売再開。店員も行える(仕様 v0.2 §11.2)
  .post(
    "/:shopId/products/:productId/sold-out",
    productParam,
    zValidator("json", z.object({ soldOut: z.boolean() })),
    async (c) => {
      const auth = requireAuth(c);
      const { shopId, productId } = c.req.valid("param");
      assertShopAccess(auth, shopId);
      const { soldOut } = c.req.valid("json");
      const db = c.env.DB;
      const p = await db
        .prepare("SELECT manual_sold_out FROM products WHERE id = ? AND shop_id = ? AND status <> 'ARCHIVED'")
        .bind(productId, shopId)
        .first<{ manual_sold_out: number }>();
      if (!p) throw notFound("商品が見つかりません");
      await db.batch([
        db
          .prepare("UPDATE products SET manual_sold_out = ?, updated_at = ? WHERE id = ? AND shop_id = ?")
          .bind(soldOut ? 1 : 0, Date.now(), productId, shopId),
        bumpCatalogStmt(db, shopId),
        auditStmtIfExists(
          db,
          {
            actor: auth,
            action: soldOut ? "product.sold_out" : "product.resume_sale",
            targetType: "product",
            targetId: productId,
            before: { manualSoldOut: p.manual_sold_out === 1 },
            after: { manualSoldOut: soldOut },
          },
          "SELECT 1 FROM products WHERE id = ? AND manual_sold_out = ?",
          [productId, soldOut ? 1 : 0],
        ),
      ]);
      return c.json({ ok: true });
    },
  );
