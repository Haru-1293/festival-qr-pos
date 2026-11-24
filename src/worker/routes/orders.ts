import { Hono } from "hono";
import { z } from "zod";
import type { FulfillmentStatus, TrackedOrderDto } from "@shared/api";
import type { AppEnv } from "../env";
import { auditStmtIfExists } from "../lib/audit";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors";
import { orderNo } from "../lib/order";
import { callLabelSql, isCallNoActive } from "../lib/callno";
import { normalizeCallTag, splitCallTag } from "@shared/callTag";
import { auditStmtIfExists as auditIfExists } from "../lib/audit";
import { performRefund } from "./refunds";
import { zv as zValidator } from "../lib/validate";
import { assertShopAccess, requireAuth, requireRole } from "../middleware/auth";

const shopParam = zValidator("param", z.object({ shopId: z.string().length(26) }));
const orderParam = zValidator("param", z.object({ shopId: z.string().length(26), orderId: z.string().length(26) }));

/** 店員が取り消せるのは、支払いから この時間以内の注文だけ(店舗責任者・全体管理者は期限なし) */
export const CLERK_CANCEL_WINDOW_MS = 2 * 3600_000;

/** 注文ステータス(調理中・提供可能)。店員・店舗責任者が自店舗の分を扱う */
export const orderRoutes = new Hono<AppEnv>()
  .use("*", requireRole("CLERK", "SHOP_MANAGER", "ADMIN"))
  // 調理中・提供可能の注文(全額返金済みは除く)。古い順
  .get("/:shopId/active", shopParam, async (c) => {
    const auth = requireAuth(c);
    const { shopId } = c.req.valid("param");
    assertShopAccess(auth, shopId);
    const db = c.env.DB;
    const shop = await db.prepare("SELECT use_order_tracking FROM shops WHERE id = ?").bind(shopId).first<{ use_order_tracking: number }>();
    if (!shop) throw notFound("店舗が見つかりません");
    const { results } = await db
      .prepare(
        `SELECT t.order_id, ${callLabelSql("t")} AS call_no, t.status, t.created_at, t.updated_at
           FROM order_tracking t JOIN orders o ON o.id = t.order_id
          WHERE t.shop_id = ? AND t.status IN ('PREPARING','READY') AND o.refunded_total < o.total_paid
          ORDER BY t.created_at, t.rowid LIMIT 200`,
      )
      .bind(shopId)
      .all<{ order_id: string; call_no: string; status: FulfillmentStatus; created_at: number; updated_at: number }>();
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
    return c.json({ enabled: shop.use_order_tracking === 1, orders, serverTime: Date.now() });
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
  })
  // 呼び出し番号(番号札)の付け替え。入力の間違いや、番号札の取り違えの直しに使う。受け渡し済みは変えられない
  .post(
    "/:shopId/:orderId/call-no",
    orderParam,
    zValidator("json", z.object({ callNo: z.string().trim().max(20) })),
    async (c) => {
      const auth = requireAuth(c);
      const { shopId, orderId } = c.req.valid("param");
      assertShopAccess(auth, shopId);
      const callNo = normalizeCallTag(c.req.valid("json").callNo);
      if (callNo === null) throw badRequest("呼び出し札は半角の英数字・記号で8文字までです(スペース不可)", "TAG_INVALID");
      const split = splitCallTag(callNo);
      const db = c.env.DB;
      const cur = await db.prepare(`SELECT ${callLabelSql("t")} AS call_no, t.status FROM order_tracking t WHERE t.order_id = ? AND t.shop_id = ?`).bind(orderId, shopId).first<{ call_no: string; status: string }>();
      if (!cur) throw notFound("注文が見つかりません");
      if (cur.status === "DONE") throw badRequest("受け渡し済みの注文の番号は変えられません", "ORDER_DELIVERED");
      if (cur.call_no === callNo) return c.json({ ok: true, callNo });
      if (await isCallNoActive(db, shopId, callNo, orderId)) throw conflict(`番号 ${callNo} は、まだ受け渡しが済んでいない別の注文で使われています`, "CALL_NO_IN_USE");
      const now = Date.now();
      const res = await db.batch([
        db.prepare("UPDATE order_tracking SET call_label = ?, call_no = COALESCE(?, call_no), updated_at = ? WHERE order_id = ? AND shop_id = ? AND status <> 'DONE'").bind(split.label, split.callNo, now, orderId, shopId),
        auditIfExists(
          db,
          { actor: auth, action: "order.call_no", targetType: "order", targetId: orderId, before: { callNo: cur.call_no }, after: { callNo } },
          "SELECT 1 FROM order_tracking WHERE order_id = ? AND COALESCE(call_label, CAST(call_no AS TEXT)) = ? AND updated_at = ?",
          [orderId, callNo, now],
        ),
      ]);
      if ((res[0].meta.changes ?? 0) === 0) throw conflict("注文の状態が変わりました。もう一度お試しください", "STATE_CHANGED");
      return c.json({ ok: true, callNo });
    },
  )
  // 最近の注文(取消しの対象を探す用)。支払いから2時間以内で、まだ取り消していないもの。新しい順
  .get("/:shopId/recent", shopParam, async (c) => {
    const auth = requireAuth(c);
    const { shopId } = c.req.valid("param");
    assertShopAccess(auth, shopId);
    const since = Date.now() - CLERK_CANCEL_WINDOW_MS;
    const { results } = await c.env.DB
      .prepare(
        `SELECT o.id, o.paid_at, o.total_paid, o.refunded_total, ${callLabelSql("t")} AS call_no, t.status AS tstatus,
                (SELECT group_concat(name_snapshot || '×' || quantity, ' / ') FROM order_lines l WHERE l.order_id = o.id) AS items
           FROM orders o LEFT JOIN order_tracking t ON t.order_id = o.id
          WHERE o.shop_id = ? AND o.paid_at >= ? AND o.refunded_total = 0 ORDER BY o.paid_at DESC LIMIT 50`,
      )
      .bind(shopId, since)
      .all<{ id: string; paid_at: number; total_paid: number; refunded_total: number; call_no: string | null; tstatus: FulfillmentStatus | null; items: string | null }>();
    c.header("Cache-Control", "no-store");
    return c.json({
      orders: results.map((r) => ({
        orderId: r.id,
        orderNo: orderNo(r.id),
        paidAt: r.paid_at,
        total: r.total_paid,
        callNo: r.call_no,
        status: r.tstatus,
        items: r.items,
      })),
    });
  })
  // 注文の取消し(在庫切れなどで受けた注文を提供できないとき)。全額をお客様のウォレットへ戻す。理由は必須で、監査ログに残る。
  //  取り消せるのは、まだ返金のない注文で、受け渡し済みでないもの。店員は支払いから2時間以内の注文だけ。
  .post(
    "/:shopId/:orderId/cancel",
    orderParam,
    zValidator(
      "json",
      z.object({
        requestId: z.string().min(16).max(64).regex(/^[A-Za-z0-9_-]+$/),
        reason: z.string().trim().min(1, "取消しの理由を入力してください").max(200),
        /** 商品を在庫へ戻すか。在庫が足りなくて作れなかったときは戻さない */
        restoreStock: z.boolean(),
      }),
    ),
    async (c) => {
      const auth = requireAuth(c);
      const { shopId, orderId } = c.req.valid("param");
      assertShopAccess(auth, shopId);
      const b = c.req.valid("json");
      const db = c.env.DB;
      const cur = await db.prepare("SELECT total_paid FROM orders WHERE id = ? AND shop_id = ?").bind(orderId, shopId).first<{ total_paid: number }>();
      if (!cur) throw notFound("注文が見つかりません");
      const out = await performRefund(
        db,
        auth,
        orderId,
        { requestId: b.requestId, kind: "FULL", reason: b.reason, restoreStock: b.restoreStock, restoreCoupon: true, expectedAmount: Math.max(1, cur.total_paid) },
        {
          cancel: true,
          checkOrder: async (o) => {
            if (o.refunded_total > 0) throw badRequest("この注文はすでに返金・取消しされています", "ALREADY_REFUNDED");
            if (auth.role === "CLERK" && Date.now() - o.paid_at > CLERK_CANCEL_WINDOW_MS)
              throw forbidden("支払いから時間がたっているため、店員は取り消せません。店舗責任者に依頼してください", "CANCEL_WINDOW_PASSED");
            const t = await db.prepare("SELECT status FROM order_tracking WHERE order_id = ?").bind(orderId).first<{ status: string }>();
            if (t?.status === "DONE") throw badRequest("受け渡し済みの注文は取り消せません。返金は店舗責任者が行います", "ORDER_DELIVERED");
          },
        },
      );
      return c.json(out.result, out.created ? 201 : 200);
    },
  );
