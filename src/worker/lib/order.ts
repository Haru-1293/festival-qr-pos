import type { PayResult, Quote, QuoteLine, QuoteProblem, CartItemInput } from "@shared/api";
import { cutAmount } from "@shared/pricing";
import { catalogSignature, loadRunningCut, loadVersion } from "./catalog";

/** 取引番号(画面表示用)。注文IDの末尾8文字 */
export const orderNo = (orderId: string): string => orderId.slice(-8);

/** 見積もりの1行。確定時の整合チェック(SQL のガード)に使う値も持つ */
export interface RawLine extends QuoteLine {
  discountable: boolean;
  trackStock: boolean;
}

export interface CartQuote extends Quote {
  raw: RawLine[];
}

interface ProductRow {
  id: string;
  name: string;
  price: number | null;
  sale_mode: string;
  status: string;
  manual_sold_out: number;
  track_stock: number;
  stock_qty: number | null;
  discountable: number;
}

/**
 * カートを、いまの価格・値下げ・在庫で見積もる。価格は必ずサーバーで計算し、画面の価格は信用しない。
 * 買えない商品(停止・売り切れ・在庫不足など)は problems に入れる。
 */
export async function quoteCart(db: D1Database, shopId: string, items: CartItemInput[], now: number): Promise<CartQuote> {
  // 同じ商品が複数行に分かれていても1行にまとめる
  const merged = new Map<string, number>();
  for (const i of items) merged.set(i.productId, (merged.get(i.productId) ?? 0) + i.quantity);
  const ids = [...merged.keys()];
  const [{ results }, cut, version] = await Promise.all([
    db
      .prepare(
        `SELECT id, name, price, sale_mode, status, manual_sold_out, track_stock, stock_qty, discountable
           FROM products WHERE shop_id = ? AND id IN (${ids.map(() => "?").join(",")})`,
      )
      .bind(shopId, ...ids)
      .all<ProductRow>(),
    loadRunningCut(db, shopId, now),
    loadVersion(db, shopId),
  ]);
  const byId = new Map(results.map((r) => [r.id, r]));
  const raw: RawLine[] = [];
  const problems: QuoteProblem[] = [];
  for (const [productId, quantity] of merged) {
    const p = byId.get(productId);
    if (!p) {
      problems.push({ productId, name: null, code: "NOT_FOUND", message: "商品が見つかりません" });
      continue;
    }
    if (p.status !== "ACTIVE" || p.sale_mode === "SET_ONLY") {
      problems.push({ productId, name: p.name, code: "UNAVAILABLE", message: `${p.name} は現在販売していません` });
      continue;
    }
    if (p.price === null) {
      problems.push({ productId, name: p.name, code: "NO_PRICE", message: `${p.name} は価格が設定されていません` });
      continue;
    }
    if (p.manual_sold_out === 1 || (p.track_stock === 1 && p.stock_qty === 0)) {
      problems.push({ productId, name: p.name, code: "SOLD_OUT", message: `${p.name} は売り切れです` });
      continue;
    }
    if (p.track_stock === 1 && p.stock_qty !== null && p.stock_qty < quantity) {
      problems.push({ productId, name: p.name, code: "INSUFFICIENT_STOCK", message: `${p.name} は残り${p.stock_qty}個です`, available: p.stock_qty });
      continue;
    }
    const down = p.discountable === 1 ? cutAmount(p.price, cut) : 0;
    const unit = p.price - down;
    raw.push({
      productId,
      name: p.name,
      quantity,
      listUnitPrice: p.price,
      unitPrice: unit,
      lineTotal: unit * quantity,
      discountable: p.discountable === 1,
      trackStock: p.track_stock === 1,
    });
  }
  const lines: QuoteLine[] = raw.map(({ discountable: _d, trackStock: _t, ...l }) => l);
  return {
    lines,
    raw,
    total: lines.reduce((s, l) => s + l.lineTotal, 0),
    cut: cut ? { id: cut.id, name: cut.name } : null,
    problems,
    signature: catalogSignature(version, cut),
  };
}

/** 確定済みの注文の結果(再送・結果照会で同じ内容を返すために使う) */
export async function loadPayResult(db: D1Database, orderId: string): Promise<PayResult | null> {
  const o = await db
    .prepare(
      `SELECT o.id, o.total_paid, o.paid_at, l.balance_after FROM orders o LEFT JOIN wallet_ledger l ON l.id = o.ledger_id WHERE o.id = ?`,
    )
    .bind(orderId)
    .first<{ id: string; total_paid: number; paid_at: number; balance_after: number | null }>();
  if (!o) return null;
  const { results } = await db
    .prepare(
      `SELECT product_id, name_snapshot, quantity, list_unit_price, unit_price, line_subtotal FROM order_lines WHERE order_id = ? ORDER BY line_no`,
    )
    .bind(orderId)
    .all<{ product_id: string; name_snapshot: string; quantity: number; list_unit_price: number | null; unit_price: number; line_subtotal: number }>();
  return {
    orderId: o.id,
    orderNo: orderNo(o.id),
    total: o.total_paid,
    balanceAfter: o.balance_after ?? 0,
    paidAt: o.paid_at,
    lines: results.map((r) => ({
      productId: r.product_id,
      name: r.name_snapshot,
      quantity: r.quantity,
      listUnitPrice: r.list_unit_price ?? r.unit_price,
      unitPrice: r.unit_price,
      lineTotal: r.line_subtotal,
    })),
  };
}
