import type { CashEventDto, CashEventKind, CashOpResult, CashTotals } from "@shared/api";

export function emptyTotals(): CashTotals {
  return { charge: 0, payout: 0, drop: 0, correction: 0, expected: 0, eventCount: 0 };
}

/** 期待現金額 = チャージ受領 − 出金(払戻し) − 途中回収 ± 訂正(単位: 円) */
export function finalizeTotals(t: CashTotals): CashTotals {
  return { ...t, expected: t.charge - t.payout - t.drop + t.correction };
}

interface TotalsRow {
  reception_user_id: string;
  kind: CashEventKind;
  s: number;
  n: number;
}

/** 未締めの現金イベントの集計。userId を省略すると全受付担当者分を、担当者ごとに返す */
export async function loadOpenTotals(
  db: D1Database,
  userId?: string,
): Promise<{ total: CashTotals; byUser: Map<string, CashTotals> }> {
  const { results } = await db
    .prepare(
      `SELECT reception_user_id, kind, COALESCE(SUM(amount), 0) AS s, COUNT(*) AS n
         FROM cash_events
        WHERE closing_id IS NULL ${userId ? "AND reception_user_id = ?" : ""}
        GROUP BY reception_user_id, kind`,
    )
    .bind(...(userId ? [userId] : []))
    .all<TotalsRow>();
  const total = emptyTotals();
  const byUser = new Map<string, CashTotals>();
  const key = { CHARGE: "charge", PAYOUT: "payout", DROP: "drop", CORRECTION: "correction" } as const;
  for (const r of results) {
    const u = byUser.get(r.reception_user_id) ?? emptyTotals();
    u[key[r.kind]] += r.s;
    u.eventCount += r.n;
    byUser.set(r.reception_user_id, u);
    total[key[r.kind]] += r.s;
    total.eventCount += r.n;
  }
  for (const [k, v] of byUser) byUser.set(k, finalizeTotals(v));
  return { total: finalizeTotals(total), byUser };
}

interface EventRow {
  id: string;
  kind: CashEventKind;
  amount: number;
  reason: string | null;
  created_at: number;
  closing_id: string | null;
  ledger_id: string | null;
  customer_nickname: string | null;
  reception_nickname: string | null;
  effective_cash: number | null;
}

/** 担当者の直近の現金イベント(訂正の対象を選ぶ画面用) */
export async function loadRecentEvents(db: D1Database, userId: string, limit = 30): Promise<CashEventDto[]> {
  const { results } = await db
    .prepare(
      `SELECT e.id, e.kind, e.amount, e.reason, e.created_at, e.closing_id, e.ledger_id,
              cu.nickname AS customer_nickname, ru.nickname AS reception_nickname,
              CASE WHEN e.kind = 'CHARGE' THEN
                e.amount + COALESCE((SELECT SUM(ce.amount) FROM cash_events ce
                                      JOIN wallet_ledger cl ON cl.id = ce.ledger_id
                                     WHERE cl.corrects_ledger_id = e.ledger_id), 0)
              END AS effective_cash
         FROM cash_events e
         LEFT JOIN wallet_ledger l ON l.id = e.ledger_id
         LEFT JOIN wallets w ON w.id = l.wallet_id
         LEFT JOIN users cu ON cu.id = w.owner_user_id
         LEFT JOIN users ru ON ru.id = e.reception_user_id
        WHERE e.reception_user_id = ?
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT ?`,
    )
    .bind(userId, limit)
    .all<EventRow>();
  return results.map((r) => ({
    id: r.id,
    kind: r.kind,
    amount: r.amount,
    reason: r.reason,
    createdAt: r.created_at,
    closed: r.closing_id !== null,
    ledgerId: r.ledger_id,
    customerNickname: r.customer_nickname,
    receptionNickname: r.reception_nickname,
    effectiveCash: r.effective_cash,
  }));
}

/** 取引番号(画面表示用)。台帳IDの末尾8文字 */
export const txNo = (ledgerId: string): string => ledgerId.slice(-8);

interface LedgerResultRow {
  id: string;
  wallet_id: string;
  operator_user_id: string | null;
  amount: number;
  balance_after: number;
  cash: number | null;
}

export async function loadLedgerResult(db: D1Database, ledgerId: string): Promise<(LedgerResultRow & { result: Omit<CashOpResult, "replayed"> }) | null> {
  const row = await db
    .prepare(
      `SELECT l.id, l.wallet_id, l.operator_user_id, l.amount, l.balance_after, e.amount AS cash
         FROM wallet_ledger l LEFT JOIN cash_events e ON e.ledger_id = l.id
        WHERE l.id = ?`,
    )
    .bind(ledgerId)
    .first<LedgerResultRow>();
  if (!row) return null;
  return {
    ...row,
    result: {
      ledgerId: row.id,
      txNo: txNo(row.id),
      balanceAfter: row.balance_after,
      units: Math.abs(row.amount),
      cashAmount: Math.abs(row.cash ?? 0),
    },
  };
}
