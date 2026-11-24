/** 呼び出し番号(自動・番号札どちらも)が、その店舗で「まだ受け渡しが済んでいない注文」に使われているか。全額返金・取消しした注文は除く */
export async function isCallNoActive(db: D1Database, shopId: string, callNo: number, exceptOrderId?: string): Promise<boolean> {
  const r = await db
    .prepare(
      `SELECT 1 FROM order_tracking t JOIN orders o ON o.id = t.order_id
        WHERE t.shop_id = ? AND t.call_no = ? AND t.status IN ('PREPARING','READY') AND o.refunded_total < o.total_paid ${exceptOrderId ? "AND t.order_id <> ?" : ""} LIMIT 1`,
    )
    .bind(shopId, callNo, ...(exceptOrderId ? [exceptOrderId] : []))
    .first();
  return r !== null;
}
