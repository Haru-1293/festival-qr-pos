/** 定価の一律値下げ(仕様 v0.3 §1.12)。サーバーと画面で同じ計算を使う */
export type PriceCutMethod = "PERCENT" | "FIXED";

export interface PriceCutRule {
  method: PriceCutMethod;
  value: number;
}

/**
 * 値下げ額。端数は値下げ額を切り捨てる(仮定 A14)。値下げ後の価格は0未満にならない。
 * 例: 150pt を 15%引き → 値下げ額 22(22.5 を切り捨て)→ 128pt
 */
export function cutAmount(price: number, rule: PriceCutRule | null): number {
  if (!rule || price <= 0) return 0;
  const raw = rule.method === "PERCENT" ? Math.floor((price * rule.value) / 100) : rule.value;
  return Math.max(0, Math.min(price, raw));
}

export function salePrice(price: number, rule: PriceCutRule | null): number {
  return price - cutAmount(price, rule);
}

/**
 * 数量を返金するときの金額。割引・値下げ後の実支払額(linePaid)を数量で按分する。
 * 端数は切り捨て、その行の残り数量をすべて返すときは残額ぴったりにして、累計が実支払額と一致するようにする。
 */
export function refundAmountForLine(
  l: { quantity: number; linePaid: number; refundedAmount: number; refundedQuantity: number },
  qty: number,
): number {
  const remainQty = l.quantity - l.refundedQuantity;
  const remainPaid = l.linePaid - l.refundedAmount;
  if (remainQty <= 0 || qty >= remainQty) return remainPaid;
  return Math.floor((remainPaid * qty) / remainQty);
}
