import { Hono } from "hono";
import { z } from "zod";
import type { CallBoardDto, PublicMenuItem, PublicShopDto } from "@shared/api";
import type { AppEnv } from "../env";
import { notFound } from "../lib/errors";
import { MENU_IMAGE_KEY, menuImageUrl, readMenuImage } from "../lib/menuImages";
import { zv as zValidator } from "../lib/validate";

const shopParam = zValidator("param", z.object({ shopId: z.string().length(26) }));

/**
 * ログイン不要の公開API。個人情報・残高・取引は一切返さない。
 * 訪問者向けの店舗・メニュー一覧と、呼び出しボード(番号だけ)。
 */
export const publicRoutes = new Hono<AppEnv>()
  .get("/shops", async (c) => {
    const { results } = await c.env.DB
      .prepare("SELECT id, display_name, description, use_call_board FROM shops WHERE status = 'ACTIVE' ORDER BY sort_order, display_name")
      .all<{ id: string; display_name: string; description: string | null; use_call_board: number }>();
    c.header("Cache-Control", "public, max-age=30");
    return c.json({ shops: results.map((s) => ({ id: s.id, name: s.display_name, description: s.description, callBoard: s.use_call_board === 1 }) satisfies PublicShopDto) });
  })
  .get("/shops/:shopId/menu", shopParam, async (c) => {
    const { shopId } = c.req.valid("param");
    const db = c.env.DB;
    const shop = await db.prepare("SELECT display_name FROM shops WHERE id = ? AND status = 'ACTIVE'").bind(shopId).first<{ display_name: string }>();
    if (!shop) throw notFound("店舗が見つかりません");
    const [products, sets] = await Promise.all([
      db
        .prepare(
          `SELECT name, price, description, image_key, manual_sold_out, track_stock, stock_qty FROM products
            WHERE shop_id = ? AND status = 'ACTIVE' AND sale_mode <> 'SET_ONLY' AND price IS NOT NULL ORDER BY sort_order, created_at`,
        )
        .bind(shopId)
        .all<{ name: string; price: number; description: string | null; image_key: string | null; manual_sold_out: number; track_stock: number; stock_qty: number | null }>(),
      db
        .prepare("SELECT name, price, description, image_key, manual_sold_out FROM sets WHERE shop_id = ? AND status = 'ACTIVE' ORDER BY sort_order, created_at")
        .bind(shopId)
        .all<{ name: string; price: number; description: string | null; image_key: string | null; manual_sold_out: number }>(),
    ]);
    const items: PublicMenuItem[] = [
      ...products.results.map((p) => ({
        kind: "PRODUCT" as const,
        name: p.name,
        price: p.price,
        description: p.description,
        imageUrl: menuImageUrl(p.image_key),
        soldOut: p.manual_sold_out === 1 || (p.track_stock === 1 && (p.stock_qty ?? 0) <= 0),
      })),
      ...sets.results.map((s) => ({ kind: "SET" as const, name: s.name, price: s.price, description: s.description, imageUrl: menuImageUrl(s.image_key), soldOut: s.manual_sold_out === 1 })),
    ];
    c.header("Cache-Control", "public, max-age=15");
    return c.json({ shopName: shop.display_name, items });
  })
  // メニュー画像(公開。キーは画像ごとに別で変わらないので、長くキャッシュする)
  .get("/menu-images/:key", zValidator("param", z.object({ key: z.string().regex(MENU_IMAGE_KEY) })), async (c) => {
    const { key } = c.req.valid("param");
    const img = await readMenuImage(c.env, key);
    if (!img) throw notFound("画像が見つかりません");
    return new Response(img.body, {
      headers: {
        "content-type": img.type,
        "cache-control": "public, max-age=86400, immutable",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'",
      },
    });
  })
  // 呼び出しボード。店舗がオンにしているときだけ。番号だけを返す(最近の受け渡し済みは出さない)
  .get("/shops/:shopId/board", shopParam, async (c) => {
    const { shopId } = c.req.valid("param");
    const db = c.env.DB;
    const shop = await db.prepare("SELECT display_name, use_call_board FROM shops WHERE id = ?").bind(shopId).first<{ display_name: string; use_call_board: number }>();
    if (!shop || shop.use_call_board !== 1) throw notFound("この店舗では呼び出しボードを使っていません");
    const { results } = await db
      .prepare(
        `SELECT COALESCE(t.call_label, CAST(t.call_no AS TEXT)) AS call_no, t.status FROM order_tracking t JOIN orders o ON o.id = t.order_id
          WHERE t.shop_id = ? AND t.status IN ('PREPARING','READY') AND (o.refunded_total < o.total_paid OR o.total_paid = 0) ORDER BY t.created_at, t.rowid LIMIT 200`,
      )
      .bind(shopId)
      .all<{ call_no: string; status: "PREPARING" | "READY" }>();
    c.header("Cache-Control", "no-store");
    return c.json({
      shopName: shop.display_name,
      preparing: results.filter((r) => r.status === "PREPARING").map((r) => r.call_no),
      ready: results.filter((r) => r.status === "READY").map((r) => r.call_no),
      serverTime: Date.now(),
    } satisfies CallBoardDto);
  });
