/** 呼び出し名(自動の番号も札も同じ扱い)。札の文字列があればそれ、なければ自動の番号 */
export const callLabelSql = (alias: string) => `COALESCE(${alias}.call_label, CAST(${alias}.call_no AS TEXT))`;

/** 呼び出し名が、その店舗で「まだ受け渡しが済んでいない注文」に使われているか。全額返金・取消しした注文は除く */
export async function isCallNoActive(db: D1Database, shopId: string, label: string, exceptOrderId?: string): Promise<boolean> {
  const r = await db
    .prepare(
      `SELECT 1 FROM order_tracking t JOIN orders o ON o.id = t.order_id
        WHERE t.shop_id = ? AND ${callLabelSql("t")} = ? AND t.status IN ('PREPARING','READY') AND (o.refunded_total < o.total_paid OR o.total_paid = 0) ${exceptOrderId ? "AND t.order_id <> ?" : ""} LIMIT 1`,
    )
    .bind(shopId, label, ...(exceptOrderId ? [exceptOrderId] : []))
    .first();
  return r !== null;
}
