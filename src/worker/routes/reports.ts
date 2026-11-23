import { Hono } from "hono";
import { z } from "zod";
import { AUDIT_CATEGORIES, type AuditEntryDto, type GrossProfit, SalesReport, ShopOrderRow, ShopSalesSummary, TimeSeriesPoint } from "@shared/api";
import type { AppEnv } from "../env";
import { badRequest, notFound } from "../lib/errors";
import { zv as zValidator } from "../lib/validate";
import { assertShopAccess, requireAuth, requireRole } from "../middleware/auth";

const range = z.object({
  from: z.coerce.number().int().min(0).optional(),
  to: z.coerce.number().int().min(0).optional(),
});
const auditQuery = z.object({
  category: z.enum(AUDIT_CATEGORIES.map((x) => x.key) as [string, ...string[]]).optional(),
  action: z.string().trim().max(60).optional(),
  shopId: z.string().length(26).optional(),
  role: z.enum(["ADMIN", "SHOP_MANAGER", "CLERK", "RECEPTION", "CUSTOMER"]).optional(),
  q: z.string().trim().max(60).optional(),
  from: z.coerce.number().int().min(0).optional(),
  to: z.coerce.number().int().min(0).optional(),
  order: z.enum(["desc", "asc"]).default("desc"),
  /** 1回に読む件数(最大100)。「直近n件」はこれを新しい順で使う */
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** 続きを読む位置(前回の next) */
  cursor: z.string().regex(/^\d{1,16}:[A-Za-z0-9]{26}$/).optional(),
});
const shopParam = zValidator("param", z.object({ shopId: z.string().length(26) }));

/** CSV の1セル。表計算ソフトで式として実行されないよう、= + - @ で始まる文字には ' を付ける */
export function csvCell(v: string | number | null | undefined): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csvResponse = (name: string, rows: (string | number | null)[][]) =>
  new Response("﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n", {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${name}"`,
      "cache-control": "no-store",
    },
  });
/** 日本時間の「2026-11-20 14:36:00」 */
export const jst = (ms: number): string => new Date(ms + 9 * 3600_000).toISOString().replace("T", " ").slice(0, 19);

const ORDER_WHERE = "o.paid_at >= ? AND o.paid_at < ?";
const bounds = (q: { from?: number; to?: number }): [number, number] => {
  const from = q.from ?? 0;
  const to = q.to ?? 8_640_000_000_000_000;
  if (to <= from) throw badRequest("期間の終わりは始まりより後にしてください");
  return [from, to];
};

/**
 * 粗利の元になる集計(原価が入力された行だけ)。
 * 売上 = 行の支払額 - 返金額。原価 = 行の原価 ×(数量 - 返った数量)÷ 数量。
 * 「返った数量」は、在庫へ戻した返金と注文取消しの数量(作らなかった・売らなかった分)。戻さなかった返金は原価が残る(廃棄扱い)。
 * 返金率だけの返金(数量0)は値引きと同じ扱いで、原価は変わらない。
 */
const COST_NET = `l.cost_total * (l.quantity - COALESCE((SELECT SUM(rl.quantity) FROM refund_lines rl JOIN refunds r ON r.id = rl.refund_id
                      WHERE rl.order_line_id = l.id AND (rl.restore_stock = 1 OR r.cancel = 1)), 0)) / l.quantity`;

async function grossByShop(db: D1Database, from: number, to: number, shopId?: string): Promise<Map<string, { sales: number; cost: number }>> {
  const { results } = await db
    .prepare(
      `SELECT o.shop_id, SUM(l.line_paid - l.refunded_amount) AS sales, SUM(${COST_NET}) AS cost
         FROM order_lines l JOIN orders o ON o.id = l.order_id
        WHERE l.cost_total IS NOT NULL AND ${ORDER_WHERE} ${shopId ? "AND o.shop_id = ?" : ""} GROUP BY o.shop_id`,
    )
    .bind(from, to, ...(shopId ? [shopId] : []))
    .all<{ shop_id: string; sales: number; cost: number }>();
  return new Map(results.map((r) => [r.shop_id, { sales: r.sales, cost: r.cost }]));
}
function grossOf(g: { sales: number; cost: number } | undefined, netSales: number): GrossProfit | null {
  if (!g) return null;
  return {
    sales: g.sales,
    cost: g.cost,
    profit: g.sales - g.cost,
    margin: g.sales > 0 ? Math.round(((g.sales - g.cost) / g.sales) * 1000) / 10 : null,
    coverage: netSales > 0 ? Math.min(100, Math.round((g.sales / netSales) * 1000) / 10) : null,
  };
}

async function salesReport(db: D1Database, from: number, to: number): Promise<SalesReport> {
  const [shops, discs, gross] = await Promise.all([
    db
      .prepare(
        `SELECT s.id AS shop_id, s.display_name AS name, COUNT(o.id) AS orders,
                COALESCE(SUM(o.subtotal),0) AS subtotal, COALESCE(SUM(o.discount_total),0) AS discount_total,
                COALESCE(SUM(o.total_paid),0) AS paid_total, COALESCE(SUM(o.refunded_total),0) AS refunded_total
           FROM shops s LEFT JOIN orders o ON o.shop_id = s.id AND ${ORDER_WHERE}
          GROUP BY s.id, s.display_name ORDER BY s.display_name`,
      )
      .bind(from, to)
      .all<{ shop_id: string; name: string; orders: number; subtotal: number; discount_total: number; paid_total: number; refunded_total: number }>(),
    db
      .prepare(
        `SELECT d.kind, d.name_snapshot AS name, COUNT(*) AS n, SUM(d.amount) AS amount
           FROM order_discounts d JOIN orders o ON o.id = d.order_id
          WHERE ${ORDER_WHERE} GROUP BY d.kind, d.name_snapshot ORDER BY amount DESC`,
      )
      .bind(from, to)
      .all<{ kind: "AUTO" | "COMMON_COUPON" | "ONE_TIME_COUPON"; name: string; n: number; amount: number }>(),
    grossByShop(db, from, to),
  ]);
  const rows = shops.results.map((r) => ({
    shopId: r.shop_id,
    name: r.name,
    orders: r.orders,
    subtotal: r.subtotal,
    discountTotal: r.discount_total,
    paidTotal: r.paid_total,
    refundedTotal: r.refunded_total,
    netSales: r.paid_total - r.refunded_total,
    gross: grossOf(gross.get(r.shop_id), r.paid_total - r.refunded_total),
  }));
  let gs = 0;
  let gc = 0;
  let any = false;
  for (const g of gross.values()) {
    gs += g.sales;
    gc += g.cost;
    any = true;
  }
  const sum = (k: "orders" | "subtotal" | "discountTotal" | "paidTotal" | "refundedTotal" | "netSales") => rows.reduce((a, r) => a + r[k], 0);
  return {
    from,
    to,
    shops: rows,
    totals: { orders: sum("orders"), subtotal: sum("subtotal"), discountTotal: sum("discountTotal"), paidTotal: sum("paidTotal"), refundedTotal: sum("refundedTotal"), netSales: sum("netSales"), gross: grossOf(any ? { sales: gs, cost: gc } : undefined, sum("netSales")) },
    discounts: discs.results.map((d) => ({ kind: d.kind, name: d.name, count: d.n, amount: d.amount })),
  };
}

const bucketQuery = range.extend({ bucket: z.enum(["hour", "day"]).default("hour") });
const JST_OFFSET = 9 * 3600_000;

/** 売上の時間帯別・日別の推移(日本時間で区切る)。shopId を省くと全店舗 */
async function timeSeries(db: D1Database, from: number, to: number, bucket: "hour" | "day", shopId?: string): Promise<TimeSeriesPoint[]> {
  const size = bucket === "hour" ? 3600_000 : 86_400_000;
  const { results } = await db
    .prepare(
      `SELECT ((o.paid_at + ${JST_OFFSET}) / ${size}) * ${size} - ${JST_OFFSET} AS t, COUNT(*) AS orders, SUM(o.total_paid - o.refunded_total) AS net
         FROM orders o WHERE ${ORDER_WHERE} ${shopId ? "AND o.shop_id = ?" : ""} GROUP BY t ORDER BY t LIMIT 2000`,
    )
    .bind(from, to, ...(shopId ? [shopId] : []))
    .all<{ t: number; orders: number; net: number }>();
  return results.map((r) => ({ t: r.t, orders: r.orders, netSales: r.net }));
}

/** 売上・精算(各店舗の純売上 = 支払額 - 返金額)、監査ログ、CSV */
export const reportRoutes = new Hono<AppEnv>()
  .get("/sales", requireRole("ADMIN"), zValidator("query", range), async (c) => {
    const [from, to] = bounds(c.req.valid("query"));
    c.header("Cache-Control", "no-store");
    return c.json(await salesReport(c.env.DB, from, to));
  })

  .get("/timeseries", requireRole("ADMIN"), zValidator("query", bucketQuery), async (c) => {
    const q = c.req.valid("query");
    const [from, to] = bounds(q);
    c.header("Cache-Control", "no-store");
    return c.json({ points: await timeSeries(c.env.DB, from, to, q.bucket) });
  })

  .get("/shops/:shopId/timeseries", requireRole("ADMIN", "SHOP_MANAGER"), shopParam, zValidator("query", bucketQuery), async (c) => {
    const { shopId } = c.req.valid("param");
    assertShopAccess(requireAuth(c), shopId);
    const q = c.req.valid("query");
    const [from, to] = bounds(q);
    c.header("Cache-Control", "no-store");
    return c.json({ points: await timeSeries(c.env.DB, from, to, q.bucket, shopId) });
  })

  .get("/sales.csv", requireRole("ADMIN"), zValidator("query", range), async (c) => {
    const [from, to] = bounds(c.req.valid("query"));
    const r = await salesReport(c.env.DB, from, to);
    return csvResponse("sales.csv", [
      ["店舗", "取引数", "割引前の売上", "割引", "支払額", "返金額", "純売上(精算対象)", "粗利(原価入力分)", "原価入力分の売上", "原価"],
      ...r.shops.map((s) => [s.name, s.orders, s.subtotal, s.discountTotal, s.paidTotal, s.refundedTotal, s.netSales, s.gross?.profit ?? "", s.gross?.sales ?? "", s.gross?.cost ?? ""]),
      ["合計", r.totals.orders, r.totals.subtotal, r.totals.discountTotal, r.totals.paidTotal, r.totals.refundedTotal, r.totals.netSales, r.totals.gross?.profit ?? "", r.totals.gross?.sales ?? "", r.totals.gross?.cost ?? ""],
    ]);
  })

  // 店舗ごとの商品別売上(店舗責任者は自店舗のみ)
  .get("/shops/:shopId/products", requireRole("ADMIN", "SHOP_MANAGER"), shopParam, zValidator("query", range), async (c) => {
    assertShopAccess(requireAuth(c), c.req.valid("param").shopId);
    const [from, to] = bounds(c.req.valid("query"));
    c.header("Cache-Control", "no-store");
    return c.json({ products: await productRows(c.env.DB, c.req.valid("param").shopId, from, to) });
  })

  // 店舗の売上サマリ(期間内の件数・支払・返金・割引・純売上、支払い方法別、割引の内訳)
  .get("/shops/:shopId/summary", requireRole("ADMIN", "SHOP_MANAGER"), shopParam, zValidator("query", range), async (c) => {
    const { shopId } = c.req.valid("param");
    assertShopAccess(requireAuth(c), shopId);
    const [from, to] = bounds(c.req.valid("query"));
    const db = c.env.DB;
    const [head, src, discs, gross] = await Promise.all([
      db
        .prepare(
          `SELECT s.id AS shop_id, s.display_name AS name, s.status, COUNT(o.id) AS orders,
                  COALESCE(SUM(o.subtotal),0) AS subtotal, COALESCE(SUM(o.discount_total),0) AS discount_total,
                  COALESCE(SUM(o.total_paid),0) AS paid_total, COALESCE(SUM(o.refunded_total),0) AS refunded_total
             FROM shops s LEFT JOIN orders o ON o.shop_id = s.id AND ${ORDER_WHERE} WHERE s.id = ? GROUP BY s.id`,
        )
        .bind(from, to, shopId)
        .first<{ shop_id: string; name: string; status: ShopSalesSummary["shop"]["status"]; orders: number; subtotal: number; discount_total: number; paid_total: number; refunded_total: number }>(),
      db
        .prepare(`SELECT o.pay_source AS source, COUNT(*) AS orders, SUM(o.total_paid) AS paid FROM orders o WHERE o.shop_id = ? AND ${ORDER_WHERE} GROUP BY o.pay_source`)
        .bind(shopId, from, to)
        .all<{ source: string; orders: number; paid: number }>(),
      db
        .prepare(
          `SELECT d.kind, d.name_snapshot AS name, COUNT(*) AS n, SUM(d.amount) AS amount
             FROM order_discounts d JOIN orders o ON o.id = d.order_id
            WHERE o.shop_id = ? AND ${ORDER_WHERE} GROUP BY d.kind, d.name_snapshot ORDER BY amount DESC`,
        )
        .bind(shopId, from, to)
        .all<{ kind: "AUTO" | "COMMON_COUPON" | "ONE_TIME_COUPON"; name: string; n: number; amount: number }>(),
      grossByShop(db, from, to, shopId),
    ]);
    if (!head) throw notFound("店舗が見つかりません");
    c.header("Cache-Control", "no-store");
    return c.json({
      from,
      to,
      shop: {
        shopId: head.shop_id,
        name: head.name,
        status: head.status,
        orders: head.orders,
        subtotal: head.subtotal,
        discountTotal: head.discount_total,
        paidTotal: head.paid_total,
        refundedTotal: head.refunded_total,
        netSales: head.paid_total - head.refunded_total,
        gross: grossOf(gross.get(shopId), head.paid_total - head.refunded_total),
      },
      discounts: discs.results.map((d) => ({ kind: d.kind, name: d.name, count: d.n, amount: d.amount })),
      bySource: src.results.map((r) => ({ source: r.source === "CARD" ? "CARD" : "PHONE", orders: r.orders, paid: r.paid })),
    } satisfies ShopSalesSummary);
  })

  // 店舗の取引履歴(新しい順。before=この時刻より前、20件ずつ)
  .get(
    "/shops/:shopId/orders",
    requireRole("ADMIN", "SHOP_MANAGER"),
    shopParam,
    zValidator("query", range.extend({ before: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(100).default(30) })),
    async (c) => {
      const { shopId } = c.req.valid("param");
      assertShopAccess(requireAuth(c), shopId);
      const q = c.req.valid("query");
      const [from, to] = bounds(q);
      const upper = Math.min(to, q.before ?? to);
      const { results } = await c.env.DB
        .prepare(
          `SELECT o.id, o.order_no, o.paid_at, o.pay_source, o.subtotal, o.discount_total, o.total_paid, o.refunded_total, o.status,
                  (SELECT group_concat(name_snapshot || '×' || quantity, ' / ') FROM order_lines l WHERE l.order_id = o.id) AS items,
                  u.nickname AS clerk
             FROM orders o LEFT JOIN users u ON u.id = o.clerk_user_id
            WHERE o.shop_id = ? AND ${ORDER_WHERE} ORDER BY o.paid_at DESC, o.id DESC LIMIT ?`,
        )
        .bind(shopId, from, upper, q.limit + 1)
        .all<{ id: string; order_no: string; paid_at: number; pay_source: string; subtotal: number; discount_total: number; total_paid: number; refunded_total: number; status: string; items: string | null; clerk: string | null }>();
      const page = results.slice(0, q.limit);
      c.header("Cache-Control", "no-store");
      return c.json({
        orders: page.map(
          (o): ShopOrderRow => ({
            id: o.id,
            orderNo: o.order_no,
            paidAt: o.paid_at,
            source: o.pay_source === "CARD" ? "CARD" : "PHONE",
            subtotal: o.subtotal,
            discountTotal: o.discount_total,
            totalPaid: o.total_paid,
            refundedTotal: o.refunded_total,
            status: o.status,
            items: o.items,
            clerkNickname: o.clerk,
          }),
        ),
        next: results.length > q.limit ? page[page.length - 1].paid_at : null,
      });
    },
  )

  .get("/shops/:shopId/orders.csv", requireRole("ADMIN", "SHOP_MANAGER"), shopParam, zValidator("query", range), async (c) => {
    const { shopId } = c.req.valid("param");
    assertShopAccess(requireAuth(c), shopId);
    const [from, to] = bounds(c.req.valid("query"));
    const { results } = await c.env.DB
      .prepare(
        `SELECT o.order_no, o.paid_at, o.pay_source, o.subtotal, o.discount_total, o.total_paid, o.refunded_total, o.status,
                (SELECT group_concat(name_snapshot || '×' || quantity, ' / ') FROM order_lines l WHERE l.order_id = o.id) AS items
           FROM orders o WHERE o.shop_id = ? AND ${ORDER_WHERE} ORDER BY o.paid_at, o.id LIMIT 20000`,
      )
      .bind(shopId, from, to)
      .all<{ order_no: string; paid_at: number; pay_source: string; subtotal: number; discount_total: number; total_paid: number; refunded_total: number; status: string; items: string | null }>();
    return csvResponse(`orders-${shopId}.csv`, [
      ["取引番号", "日時(日本時間)", "支払い方法", "割引前", "割引", "支払額", "返金額", "状態", "商品"],
      ...results.map((o) => [o.order_no, jst(o.paid_at), o.pay_source === "CARD" ? "カード" : "スマホQR", o.subtotal, o.discount_total, o.total_paid, o.refunded_total, o.status, o.items]),
    ]);
  })

  // 監査ログの検索。全件を一度に出さず、条件(種類・店舗・期間・操作者の役割・並び・件数)で絞って読む。1回に最大100件
  .get("/audit", requireRole("ADMIN"), zValidator("query", auditQuery), async (c) => {
    const f = c.req.valid("query");
    c.header("Cache-Control", "no-store");
    const rows = await auditRows(c.env.DB, f, f.limit + 1);
    const page = rows.slice(0, f.limit);
    const last = page[page.length - 1];
    return c.json({ entries: page, next: rows.length > f.limit && last ? `${last.createdAt}:${last.id}` : null });
  })

  .get("/audit.csv", requireRole("ADMIN"), zValidator("query", auditQuery.omit({ cursor: true, limit: true })), async (c) => {
    const rows = await auditRows(c.env.DB, { ...c.req.valid("query"), limit: 1000 }, 1000);
    return csvResponse("audit.csv", [
      ["日時(日本時間)", "操作者", "役割", "店舗", "操作", "対象の種類", "対象ID", "理由", "変更前", "変更後"],
      ...rows.map((r) => [jst(r.createdAt), r.actorNickname, r.actorRole, r.shopName ?? "", r.action, r.targetType, r.targetId, r.reason, r.before, r.after]),
    ]);
  });

type AuditFilter = z.infer<typeof auditQuery>;

/** 先頭一致の範囲(索引を使うため LIKE ではなく >= と < で書く)。'refund.' → ['refund.', 'refund/'] */
const prefixRange = (p: string): [string, string] => [p, p.slice(0, -1) + String.fromCharCode(p.charCodeAt(p.length - 1) + 1)];

async function auditRows(db: D1Database, o: Partial<AuditFilter> & { order?: "desc" | "asc" }, limit: number): Promise<AuditEntryDto[]> {
  const where: string[] = [];
  const args: (string | number)[] = [];
  const prefixes: string[] = [];
  if (o.category) prefixes.push(...(AUDIT_CATEGORIES.find((x) => x.key === o.category)?.prefixes ?? []));
  if (o.action) prefixes.push(o.action.replace(/[%_]/g, ""));
  if (prefixes.length) {
    // 種類と操作名を両方指定したときは、操作名(先頭一致)だけで絞る
    const use = o.action ? [o.action.replace(/[%_]/g, "")] : prefixes;
    where.push("(" + use.map(() => "(a.action >= ? AND a.action < ?)").join(" OR ") + ")");
    for (const p of use) args.push(...prefixRange(p));
  }
  if (o.shopId) {
    where.push("a.shop_id = ?");
    args.push(o.shopId);
  }
  if (o.role) {
    where.push("a.actor_role = ?");
    args.push(o.role);
  }
  if (o.from !== undefined) {
    where.push("a.created_at >= ?");
    args.push(o.from);
  }
  if (o.to !== undefined) {
    where.push("a.created_at < ?");
    args.push(o.to);
  }
  if (o.q) {
    where.push("(a.target_id = ? OR a.actor_user_id IN (SELECT id FROM users WHERE nickname LIKE ? LIMIT 50))");
    args.push(o.q, `%${o.q.replace(/[%_]/g, "")}%`);
  }
  const asc = o.order === "asc";
  if (o.cursor) {
    const [t, id] = o.cursor.split(":");
    where.push(`(a.created_at ${asc ? ">" : "<"} ? OR (a.created_at = ? AND a.id ${asc ? ">" : "<"} ?))`);
    args.push(Number(t), Number(t), id);
  }
  const dir = asc ? "ASC" : "DESC";
  const { results } = await db
    .prepare(
      `SELECT a.id, a.created_at, a.actor_role, a.action, a.target_type, a.target_id, a.reason, a.before_json, a.after_json, u.nickname, s.display_name AS shop_name
         FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id LEFT JOIN shops s ON s.id = a.shop_id
        ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY a.created_at ${dir}, a.id ${dir} LIMIT ?`,
    )
    .bind(...args, limit)
    .all<{ id: string; created_at: number; actor_role: string | null; action: string; target_type: string | null; target_id: string | null; reason: string | null; before_json: string | null; after_json: string | null; nickname: string | null; shop_name: string | null }>();
  return results.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    shopName: r.shop_name,
    actorNickname: r.nickname,
    actorRole: r.actor_role,
    action: r.action,
    targetType: r.target_type,
    targetId: r.target_id,
    reason: r.reason,
    before: r.before_json,
    after: r.after_json,
  }));
}

async function productRows(db: D1Database, shopId: string, from: number, to: number) {
  const { results } = await db
    .prepare(
      `SELECT l.name_snapshot AS name, l.kind, SUM(l.quantity) AS qty, SUM(l.line_subtotal) AS gross, SUM(l.discount_allocated) AS disc, SUM(l.line_paid) AS paid,
             SUM(CASE WHEN l.cost_total IS NOT NULL THEN l.line_paid - l.refunded_amount END) AS cost_sales,
             SUM(CASE WHEN l.cost_total IS NOT NULL THEN ${COST_NET} END) AS cost
         FROM order_lines l JOIN orders o ON o.id = l.order_id
        WHERE o.shop_id = ? AND ${ORDER_WHERE} GROUP BY l.name_snapshot, l.kind ORDER BY paid DESC, name`,
    )
    .bind(shopId, from, to)
    .all<{ name: string; kind: "PRODUCT" | "SET"; qty: number; gross: number; disc: number; paid: number; cost_sales: number | null; cost: number | null }>();
  return results.map((r) => ({ name: r.name, kind: r.kind, quantity: r.qty, gross: r.gross, discount: r.disc, paid: r.paid, costSales: r.cost_sales, cost: r.cost }));
}
