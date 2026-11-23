import { Hono } from "hono";
import { z } from "zod";
import type { OrderDetail, OrderLineDto, OrderStatus, OrderSummary, QuoteDiscount, RefundDto, RefundKind, RefundResult } from "@shared/api";
import type { AppEnv } from "../env";
import { auditStmtIfExists } from "../lib/audit";
import { bumpCatalogStmt } from "../lib/catalog";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors";
import { newId } from "../lib/ids";
import { refundAmountForLine as sharedRefundAmount } from "@shared/pricing";
import { orderNo } from "../lib/order";
import { zv as zValidator } from "../lib/validate";
import { assertShopAccess, requireAuth, requireRole } from "../middleware/auth";

const id26 = z.string().length(26);
const shopParam = zValidator("param", z.object({ shopId: id26 }));
const orderParam = zValidator("param", z.object({ orderId: id26 }));
const requestIdSchema = z
  .string()
  .min(16, "リクエストIDが短すぎます")
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "リクエストIDの形式が正しくありません");

interface OrderRow {
  id: string;
  shop_id: string;
  wallet_id: string;
  total_paid: number;
  discount_total: number;
  refunded_total: number;
  status: OrderStatus;
  paid_at: number;
}
interface LineRow {
  id: string;
  kind: "PRODUCT" | "SET";
  product_id: string | null;
  name_snapshot: string;
  unit_price: number;
  list_unit_price: number | null;
  price_cut_name: string | null;
  quantity: number;
  line_paid: number;
  refunded_amount: number;
  refunded_quantity: number;
}

async function loadOrder(db: D1Database, orderId: string): Promise<OrderRow> {
  const o = await db
    .prepare("SELECT id, shop_id, wallet_id, total_paid, discount_total, refunded_total, status, paid_at FROM orders WHERE id = ?")
    .bind(orderId)
    .first<OrderRow>();
  if (!o) throw notFound("注文が見つかりません");
  return o;
}

/** 返金は、注文の店舗の責任者(または全体管理者)だけが行える */
function assertOrderAccess(auth: { role: string; shopId: string | null }, o: OrderRow) {
  assertShopAccess(auth as Parameters<typeof assertShopAccess>[0], o.shop_id);
}

export const refundRoutes = new Hono<AppEnv>()
  .use("*", requireRole("SHOP_MANAGER", "ADMIN"))

  // 店舗の注文一覧(新しい順)。取引番号の一部で絞り込める
  .get(
    "/shops/:shopId/orders",
    shopParam,
    zValidator("query", z.object({ q: z.string().trim().max(20).optional() })),
    async (c) => {
      const auth = requireAuth(c);
      const { shopId } = c.req.valid("param");
      assertShopAccess(auth, shopId);
      const q = c.req.valid("query").q?.toUpperCase().replace(/[%_]/g, "");
      const { results } = await c.env.DB
        .prepare(
          `SELECT o.id, o.paid_at, o.total_paid, o.refunded_total, o.status, u.nickname
             FROM orders o JOIN wallets w ON w.id = o.wallet_id LEFT JOIN users u ON u.id = w.owner_user_id
            WHERE o.shop_id = ? ${q ? "AND UPPER(SUBSTR(o.id, -8)) LIKE ?" : ""}
            ORDER BY o.paid_at DESC LIMIT 50`,
        )
        .bind(...(q ? [shopId, `%${q}%`] : [shopId]))
        .all<{ id: string; paid_at: number; total_paid: number; refunded_total: number; status: OrderStatus; nickname: string | null }>();
      const orders: OrderSummary[] = results.map((r) => ({
        id: r.id,
        orderNo: orderNo(r.id),
        paidAt: r.paid_at,
        customerNickname: r.nickname,
        total: r.total_paid,
        refundedTotal: r.refunded_total,
        status: r.status,
      }));
      return c.json({ orders });
    },
  )

  // 注文の詳細(返金前の確認画面用)
  .get("/orders/:orderId", orderParam, async (c) => {
    const auth = requireAuth(c);
    const { orderId } = c.req.valid("param");
    const db = c.env.DB;
    const o = await loadOrder(db, orderId);
    assertOrderAccess(auth, o);
    const [{ results: lines }, { results: refunds }, { results: rlines }, meta, { results: comps }] = await Promise.all([
      db
        .prepare(
          `SELECT id, kind, product_id, name_snapshot, unit_price, list_unit_price, price_cut_name, quantity, line_paid, refunded_amount, refunded_quantity
             FROM order_lines WHERE order_id = ? ORDER BY line_no`,
        )
        .bind(orderId)
        .all<LineRow>(),
      db
        .prepare(
          `SELECT r.id, r.kind, r.amount, r.reason, r.created_at, r.coupon_restored, u.nickname FROM refunds r LEFT JOIN users u ON u.id = r.operator_user_id
            WHERE r.order_id = ? ORDER BY r.created_at`,
        )
        .bind(orderId)
        .all<{ id: string; kind: RefundKind; amount: number; reason: string; created_at: number; coupon_restored: number; nickname: string | null }>(),
      db
        .prepare(
          `SELECT rl.refund_id, ol.name_snapshot, rl.quantity, rl.amount, rl.restore_stock FROM refund_lines rl
             JOIN order_lines ol ON ol.id = rl.order_line_id WHERE ol.order_id = ?`,
        )
        .bind(orderId)
        .all<{ refund_id: string; name_snapshot: string; quantity: number; amount: number; restore_stock: number }>(),
      db
        .prepare(
          `SELECT s.display_name AS shop, cu.nickname AS customer, k.nickname AS clerk
             FROM orders o JOIN shops s ON s.id = o.shop_id JOIN wallets w ON w.id = o.wallet_id
             LEFT JOIN users cu ON cu.id = w.owner_user_id LEFT JOIN users k ON k.id = o.clerk_user_id WHERE o.id = ?`,
        )
        .bind(orderId)
        .first<{ shop: string; customer: string | null; clerk: string | null }>(),
      db
        .prepare(
          `SELECT c.order_line_id, c.segment_name_snapshot AS segment, c.name_snapshot AS name, c.quantity, c.surcharge
             FROM order_line_components c JOIN order_lines l ON l.id = c.order_line_id WHERE l.order_id = ? ORDER BY c.rowid`,
        )
        .bind(orderId)
        .all<{ order_line_id: string; segment: string; name: string; quantity: number; surcharge: number }>(),
    ]);
    const [{ results: discs }, used] = await Promise.all([
      db
        .prepare("SELECT kind, discount_id, coupon_id, name_snapshot, amount FROM order_discounts WHERE order_id = ? ORDER BY apply_seq")
        .bind(orderId)
        .all<{ kind: QuoteDiscount["kind"]; discount_id: string | null; coupon_id: string | null; name_snapshot: string; amount: number }>(),
      db.prepare("SELECT 1 AS x FROM coupon_redemptions WHERE order_id = ? AND status = 'USED'").bind(orderId).first(),
    ]);
    const detail: OrderDetail = {
      id: o.id,
      orderNo: orderNo(o.id),
      paidAt: o.paid_at,
      customerNickname: meta?.customer ?? null,
      total: o.total_paid,
      refundedTotal: o.refunded_total,
      status: o.status,
      shopId: o.shop_id,
      shopName: meta?.shop ?? "",
      clerkNickname: meta?.clerk ?? null,
      refundable: o.total_paid - o.refunded_total,
      subtotal: o.total_paid + o.discount_total,
      discounts: discs.map((d) => ({ kind: d.kind, discountId: d.discount_id ?? "", couponId: d.coupon_id, name: d.name_snapshot, amount: d.amount })),
      couponUsed: !!used,
      lines: lines.map(
        (l): OrderLineDto => ({
          id: l.id,
          kind: l.kind,
          productId: l.product_id,
          components:
            l.kind === "SET"
              ? comps
                  .filter((x) => x.order_line_id === l.id)
                  .map((x) => ({ segmentName: x.segment, name: x.name, quantity: x.quantity / l.quantity, surcharge: x.surcharge }))
              : undefined,
          name: l.name_snapshot,
          quantity: l.quantity,
          unitPrice: l.unit_price,
          listUnitPrice: l.list_unit_price,
          priceCutName: l.price_cut_name,
          linePaid: l.line_paid,
          refundedQuantity: l.refunded_quantity,
          refundedAmount: l.refunded_amount,
        }),
      ),
      refunds: refunds.map(
        (r): RefundDto => ({
          id: r.id,
          kind: r.kind,
          amount: r.amount,
          reason: r.reason,
          operatorNickname: r.nickname,
          createdAt: r.created_at,
          couponRestored: r.coupon_restored === 1,
          lines: rlines
            .filter((x) => x.refund_id === r.id)
            .map((x) => ({ name: x.name_snapshot, quantity: x.quantity, amount: x.amount, restoreStock: x.restore_stock === 1 })),
        }),
      ),
    };
    c.header("Cache-Control", "no-store");
    return c.json(detail);
  })

  // 返金の実行。
  //  FULL: 元取引の全額(まだ返金がないときだけ) / PARTIAL: 商品・数量を選ぶ / ARBITRARY: 全体管理者だけの任意金額
  //  返金額は実支払額が上限。残高への加算・台帳・注文・在庫戻しは1つのトランザクション。同じ requestId の再送は元の結果を返す
  .post(
    "/orders/:orderId/refund",
    orderParam,
    zValidator(
      "json",
      z.object({
        requestId: requestIdSchema,
        kind: z.enum(["FULL", "PARTIAL", "ARBITRARY"]),
        reason: z.string().trim().min(1, "返金の理由を入力してください").max(200),
        lines: z
          .array(z.object({ orderLineId: id26, quantity: z.number().int().min(1).max(99), restoreStock: z.boolean() }))
          .max(30)
          .optional(),
        /** FULL のとき、全商品を在庫へ戻すか */
        restoreStock: z.boolean().optional(),
        /** FULL のとき、使ったクーポンを使える状態へ戻すか(既定は戻す。仕様 v0.2 §14.6 / §18.7) */
        restoreCoupon: z.boolean().optional(),
        amount: z.number().int().min(1).max(10_000_000).optional(),
        /** 画面で確認した返金額。サーバーの計算と違えば実行しない */
        expectedAmount: z.number().int().min(1),
      }),
    ),
    async (c) => {
      const auth = requireAuth(c);
      const { orderId } = c.req.valid("param");
      const b = c.req.valid("json");
      const db = c.env.DB;

      // 同じ requestId の再送 → 元の結果
      const prior = await db
        .prepare("SELECT id, order_id, kind, amount FROM refunds WHERE idempotency_key = ?")
        .bind(b.requestId)
        .first<{ id: string; order_id: string; kind: RefundKind; amount: number }>();
      if (prior) {
        if (prior.order_id !== orderId) throw conflict("このリクエストIDは別の返金で使われています", "REQUEST_ID_REUSED");
        return c.json(await refundResult(db, prior.id, true));
      }

      const o = await loadOrder(db, orderId);
      assertOrderAccess(auth, o);
      if (b.kind === "ARBITRARY" && auth.role !== "ADMIN") throw forbidden("任意金額の返金は全体管理者だけが行えます");
      const refundable = o.total_paid - o.refunded_total;
      if (refundable <= 0) throw badRequest("この注文はすべて返金済みです", "ALREADY_REFUNDED");

      const { results: lines } = await db
        .prepare(
          `SELECT id, kind, product_id, name_snapshot, unit_price, list_unit_price, price_cut_name, quantity, line_paid, refunded_amount, refunded_quantity
             FROM order_lines WHERE order_id = ?`,
        )
        .bind(orderId)
        .all<LineRow>();
      const lineById = new Map(lines.map((l) => [l.id, l]));
      const { results: comps } = await db
        .prepare(
          `SELECT c.order_line_id, c.product_id, c.quantity FROM order_line_components c JOIN order_lines l ON l.id = c.order_line_id WHERE l.order_id = ?`,
        )
        .bind(orderId)
        .all<{ order_line_id: string; product_id: string; quantity: number }>();

      // 返金する行と金額を決める
      interface Pick {
        line: LineRow;
        qty: number;
        amount: number;
        restore: boolean;
      }
      let picks: Pick[] = [];
      let amount: number;
      if (b.kind === "ARBITRARY") {
        if (b.amount === undefined) throw badRequest("返金額を入力してください");
        amount = b.amount;
      } else if (b.kind === "FULL") {
        if (o.refunded_total > 0) throw badRequest("すでに一部が返金されています。「商品を選んで返金」で残りを返金してください", "ALREADY_PARTIALLY_REFUNDED");
        picks = lines.map((l) => ({ line: l, qty: l.quantity, amount: l.line_paid, restore: b.restoreStock ?? true }));
        amount = o.total_paid;
      } else {
        if (!b.lines || b.lines.length === 0) throw badRequest("返金する商品を選んでください");
        const seen = new Set<string>();
        for (const sel of b.lines) {
          const l = lineById.get(sel.orderLineId);
          if (!l) throw badRequest("この注文にない商品が含まれています");
          if (seen.has(sel.orderLineId)) throw badRequest("同じ商品が重複しています");
          seen.add(sel.orderLineId);
          if (sel.quantity > l.quantity - l.refunded_quantity) throw badRequest(`${l.name_snapshot} は返金できる数量(${l.quantity - l.refunded_quantity}個)を超えています`);
          picks.push({ line: l, qty: sel.quantity, amount: sharedRefundAmount({ quantity: l.quantity, linePaid: l.line_paid, refundedAmount: l.refunded_amount, refundedQuantity: l.refunded_quantity }, sel.quantity), restore: sel.restoreStock });
        }
        amount = picks.reduce((s, p) => s + p.amount, 0);
      }
      if (amount <= 0) throw badRequest("返金額が0になります。数量を選び直してください");
      if (amount > refundable) throw badRequest(`返金できるのは残り ${refundable} までです`, "OVER_REFUNDABLE");
      if (amount !== b.expectedAmount) {
        throw conflict("返金額が画面の表示と一致しません。もう一度確認してください", "AMOUNT_CHANGED", { amount, refundable });
      }

      const now = Date.now();
      // 全額取消(FULL)のときだけ、使ったクーポンを戻す。部分返金では戻さない
      const usedCoupon =
        b.kind === "FULL" && b.restoreCoupon !== false
          ? await db.prepare("SELECT 1 AS x FROM coupon_redemptions WHERE order_id = ? AND status = 'USED'").bind(orderId).first()
          : null;
      const refundId = newId(now);
      const ledgerId = newId(now);
      const refundExists = "EXISTS (SELECT 1 FROM refunds WHERE id = ?)";
      const ledgerExists = "EXISTS (SELECT 1 FROM wallet_ledger WHERE id = ?)";
      const stmts: D1PreparedStatement[] = [
        // ① 台帳。注文の返金済み額が見ていたとおり(=同時に別の返金が入っていない)ときだけ作られる
        db
          .prepare(
            `INSERT INTO wallet_ledger (id, wallet_id, kind, amount, balance_after, ref_type, ref_id, operator_user_id, reason, idempotency_key, created_at)
             SELECT ?, w.id, 'REFUND', ?, w.balance + ?, 'REFUND', ?, ?, ?, ?, ?
               FROM orders o JOIN wallets w ON w.id = o.wallet_id
              WHERE o.id = ? AND o.refunded_total = ? AND o.total_paid - o.refunded_total >= ?`,
          )
          .bind(ledgerId, amount, amount, refundId, auth.userId, b.reason, `refund:${b.requestId}`, now, orderId, o.refunded_total, amount),
        // ② 残高(①ができたときだけ)
        db.prepare(`UPDATE wallets SET balance = balance + ? WHERE id = ? AND ${ledgerExists}`).bind(amount, o.wallet_id, ledgerId),
        // ③ 返金の記録
        db
          .prepare(
            `INSERT INTO refunds (id, order_id, kind, amount, reason, operator_user_id, coupon_restored, ledger_id, idempotency_key, created_at)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${ledgerExists}`,
          )
          .bind(refundId, orderId, b.kind, amount, b.reason, auth.userId, usedCoupon ? 1 : 0, ledgerId, b.requestId, now, ledgerId),
        // ④ 注文の返金済み額・状態(上限を超えれば CHECK 制約が全体を巻き戻す)
        db
          .prepare(
            `UPDATE orders SET refunded_total = refunded_total + ?,
                    status = CASE WHEN refunded_total + ? = total_paid THEN 'REFUNDED' ELSE 'PARTIALLY_REFUNDED' END
              WHERE id = ? AND ${refundExists}`,
          )
          .bind(amount, amount, orderId, refundId),
      ];
      if (usedCoupon) {
        stmts.push(
          db
            .prepare(
              `UPDATE coupons SET used_count = MAX(used_count - 1, 0)
                WHERE id IN (SELECT coupon_id FROM coupon_redemptions WHERE order_id = ? AND status = 'USED') AND ${refundExists}`,
            )
            .bind(orderId, refundId),
          db
            .prepare(`UPDATE coupon_redemptions SET status = 'RESTORED', restored_at = ? WHERE order_id = ? AND status = 'USED' AND ${refundExists}`)
            .bind(now, orderId, refundId),
        );
      }
      let restored = false;
      for (const p of picks) {
        stmts.push(
          db
            .prepare(`INSERT INTO refund_lines (id, refund_id, order_line_id, quantity, amount, restore_stock) SELECT ?, ?, ?, ?, ?, ? WHERE ${refundExists}`)
            .bind(newId(now), refundId, p.line.id, p.qty, p.amount, p.restore ? 1 : 0, refundId),
          db
            .prepare(
              `UPDATE order_lines SET refunded_amount = refunded_amount + ?, refunded_quantity = refunded_quantity + ? WHERE id = ? AND ${refundExists}`,
            )
            .bind(p.amount, p.qty, p.line.id, refundId),
        );
        if (p.restore && p.line.kind === "SET") {
          // セット内の商品は、返金する数に応じて1セットあたりの個数ぶん戻す
          const per = new Map<string, number>();
          for (const cmp of comps) {
            if (cmp.order_line_id !== p.line.id) continue;
            per.set(cmp.product_id, (per.get(cmp.product_id) ?? 0) + cmp.quantity / p.line.quantity);
          }
          for (const [pid, perSet] of per) {
            const qty = perSet * p.qty;
            restored = true;
            stmts.push(
              db
                .prepare(`UPDATE products SET stock_qty = stock_qty + ?, updated_at = ? WHERE id = ? AND track_stock = 1 AND ${refundExists}`)
                .bind(qty, now, pid, refundId),
              db
                .prepare(
                  `INSERT INTO stock_movements (id, product_id, delta, qty_after, reason, ref_type, ref_id, operator_user_id, created_at)
                   SELECT ?, p.id, ?, p.stock_qty, 'REFUND_RESTORE', 'REFUND', ?, ?, ? FROM products p WHERE p.id = ? AND p.track_stock = 1 AND ${refundExists}`,
                )
                .bind(newId(now), qty, refundId, auth.userId, now, pid, refundId),
            );
          }
        } else if (p.restore && p.line.product_id) {
          restored = true;
          stmts.push(
            db
              .prepare(`UPDATE products SET stock_qty = stock_qty + ?, updated_at = ? WHERE id = ? AND track_stock = 1 AND ${refundExists}`)
              .bind(p.qty, now, p.line.product_id, refundId),
            db
              .prepare(
                `INSERT INTO stock_movements (id, product_id, delta, qty_after, reason, ref_type, ref_id, operator_user_id, created_at)
                 SELECT ?, p.id, ?, p.stock_qty, 'REFUND_RESTORE', 'REFUND', ?, ?, ? FROM products p WHERE p.id = ? AND p.track_stock = 1 AND ${refundExists}`,
              )
              .bind(newId(now), p.qty, refundId, auth.userId, now, p.line.product_id, refundId),
          );
        }
      }
      if (restored) stmts.push(bumpCatalogStmt(db, o.shop_id));
      stmts.push(
        auditStmtIfExists(
          db,
          { actor: auth, action: `refund.${b.kind.toLowerCase()}`, targetType: "order", targetId: orderId, reason: b.reason, after: { refundId, amount } },
          "SELECT 1 FROM refunds WHERE id = ?",
          [refundId],
        ),
      );

      let results: D1Result[];
      try {
        results = await db.batch(stmts);
      } catch (e) {
        const msg = String(e);
        if (msg.includes("idempotency_key")) {
          const again = await db.prepare("SELECT id FROM refunds WHERE idempotency_key = ?").bind(b.requestId).first<{ id: string }>();
          if (again) return c.json(await refundResult(db, again.id, true));
        }
        if (msg.includes("refunded")) throw conflict("返金できる上限を超えています。画面を更新して確認してください", "OVER_REFUNDABLE");
        throw e;
      }
      if ((results[0].meta.changes ?? 0) === 0) {
        // 同じリクエストIDの同時送信で、先の1件がすでに確定していた場合は、競合ではなく「同じ結果の再送」として返す
        const again = await db.prepare("SELECT id FROM refunds WHERE idempotency_key = ?").bind(b.requestId).first<{ id: string }>();
        if (again) return c.json(await refundResult(db, again.id, true));
        throw conflict("この注文は、確認している間に別の返金が行われました。画面を更新して確認してください", "REFUND_CHANGED");
      }
      return c.json(await refundResult(db, refundId, false), 201);
    },
  );

async function refundResult(db: D1Database, refundId: string, replayed: boolean): Promise<RefundResult> {
  const r = await db
    .prepare(
      `SELECT r.id, r.kind, r.amount, o.refunded_total, o.total_paid, o.status, l.balance_after
         FROM refunds r JOIN orders o ON o.id = r.order_id LEFT JOIN wallet_ledger l ON l.id = r.ledger_id WHERE r.id = ?`,
    )
    .bind(refundId)
    .first<{ id: string; kind: RefundKind; amount: number; refunded_total: number; total_paid: number; status: OrderStatus; balance_after: number | null }>();
  if (!r) throw notFound("返金が見つかりません");
  return {
    refundId: r.id,
    kind: r.kind,
    amount: r.amount,
    refundedTotal: r.refunded_total,
    refundable: r.total_paid - r.refunded_total,
    balanceAfter: r.balance_after ?? 0,
    status: r.status,
    ...(replayed ? { replayed: true } : {}),
  };
}
