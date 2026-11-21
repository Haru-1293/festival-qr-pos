import { Hono } from "hono";
import { z } from "zod";
import type { FulfillmentStatus, TrackedOrderDto } from "@shared/api";
import type { AppEnv } from "../env";
import { auditStmtIfExists } from "../lib/audit";
import { notFound } from "../lib/errors";
import { zv as zValidator } from "../lib/validate";
import { assertShopAccess, requireAuth, requireRole } from "../middleware/auth";

const shopParam = zValidator("param", z.object({ shopId: z.string().length(26) }));
const orderParam = zValidator("param", z.object({ shopId: z.string().length(26), orderId: z.string().length(26) }));

/** 注文ステータス(調理中・提供可能)。店員・店舗責任者が自店舗の分を扱う */
export const orderRoutes = new Hono<AppEnv>()
  .use("*", requireRole("CLERK", "SHOP_MANAGER", "ADMIN"))
  // 調理中・提供可能の注文(全額返金済みは除く)。古い順
  .get("/:shopId/active", shopParam, async (c) => {
    const auth = requireAuth(c);
    const { shopId } = c.req.valid("param");
    assertShopAccess(auth, shopId);
    const db = c.env.DB;
    const { results } = await db
      .prepare(
        `SELECT t.order_id, t.call_no, t.status, t.created_at, t.updated_at
           FROM order_tracking t JOIN orders o ON o.id = t.order_id
          WHERE t.shop_id = ? AND t.status IN ('PREPARING','READY') AND o.refunded_total < o.total_paid
          ORDER BY t.created_at, t.rowid LIMIT 200`,
      )
      .bind(shopId)
      .all<{ order_id: string; call_no: number; status: FulfillmentStatus; created_at: number; updated_at: number }>();
    const ids = results.map((r) => r.order_id);
    const items = new Map<string, { name: string; quantity: number }[]>();
    for (let i = 0; i < ids.length; i += 50) {
      const part = ids.slice(i, i + 50);
      const { results: ls } = await db
        .prepare(`SELECT order_id, name_snapshot, quantity FROM order_lines WHERE order_id IN (${part.map(() => "?").join(",")}) ORDER BY line_no`)
        .bind(...part)
        .all<{ order_id: string; name_snapshot: string; quantity: number }>();
      for (const l of ls) (items.get(l.order_id) ?? items.set(l.order_id, []).get(l.order_id)!).push({ name: l.name_snapshot, quantity: l.quantity });
    }
    const orders: TrackedOrderDto[] = results.map((r) => ({
      orderId: r.order_id,
      callNo: r.call_no,
      status: r.status,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      items: items.get(r.order_id) ?? [],
    }));
    return c.json({ orders, serverTime: Date.now() });
  })
  // 状態の変更。調理中 → 提供可能 → 受け渡し済み(戻すこともできる)
  .post("/:shopId/:orderId/status", orderParam, zValidator("json", z.object({ status: z.enum(["PREPARING", "READY", "DONE"]) })), async (c) => {
    const auth = requireAuth(c);
    const { shopId, orderId } = c.req.valid("param");
    assertShopAccess(auth, shopId);
    const { status } = c.req.valid("json");
    const db = c.env.DB;
    const now = Date.now();
    const res = await db.batch([
      db.prepare("UPDATE order_tracking SET status = ?, updated_at = ? WHERE order_id = ? AND shop_id = ?").bind(status, now, orderId, shopId),
      auditStmtIfExists(
        db,
        { actor: auth, action: `order.${status.toLowerCase()}`, targetType: "order", targetId: orderId },
        "SELECT 1 FROM order_tracking WHERE order_id = ? AND status = ? AND updated_at = ?",
        [orderId, status, now],
      ),
    ]);
    if ((res[0].meta.changes ?? 0) === 0) throw notFound("注文が見つかりません");
    return c.json({ ok: true });
  });
