import { Hono } from "hono";
import { z } from "zod";
import type { AdminCashSummary, ClosingDto } from "@shared/api";
import type { AppEnv } from "../env";
import { auditStmtIfExists } from "../lib/audit";
import { loadOpenTotals } from "../lib/cash";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors";
import { newId } from "../lib/ids";
import { getOperations } from "../lib/settings";
import { getUserBasic } from "../lib/users";
import { zv } from "../lib/validate";
import { requireAuth, requireRole } from "../middleware/auth";

interface ClosingRow {
  id: string;
  scope_kind: ClosingDto["scopeKind"];
  scope_nickname: string | null;
  period_start: number;
  period_end: number;
  expected_amount: number;
  counted_amount: number | null;
  difference: number | null;
  note: string | null;
  closed_by_nickname: string | null;
  closed_at: number;
}

const toClosingDto = (r: ClosingRow): ClosingDto => ({
  id: r.id,
  scopeKind: r.scope_kind,
  scopeUserNickname: r.scope_nickname,
  periodStart: r.period_start,
  periodEnd: r.period_end,
  expectedAmount: r.expected_amount,
  countedAmount: r.counted_amount,
  difference: r.difference,
  note: r.note,
  closedByNickname: r.closed_by_nickname,
  closedAt: r.closed_at,
});

const CLOSING_SELECT = `SELECT c.id, c.scope_kind, su.nickname AS scope_nickname, c.period_start, c.period_end,
       c.expected_amount, c.counted_amount, c.difference, c.note, cb.nickname AS closed_by_nickname, c.closed_at
  FROM cash_closings c
  LEFT JOIN users su ON su.id = c.scope_user_id
  LEFT JOIN users cb ON cb.id = c.closed_by`;

/**
 * 現金の締め。
 *  - 全体管理者: 全受付をまとめて(ALL)、または特定の担当者だけ(USER)を締められる。
 *  - 受付担当者: 締めの単位が「担当者交代ごと(SHIFT)」のときだけ、自分の分(SELF)を締められる。
 * 締めた現金イベントは以後変更できない(DBトリガ)。誤りは新しい訂正イベントで直す。
 */
export const cashRoutes = new Hono<AppEnv>()
  .use("*", requireRole("RECEPTION", "ADMIN"))

  .get("/admin-summary", requireRole("ADMIN"), async (c) => {
    const [{ total, byUser }, ops] = await Promise.all([loadOpenTotals(c.env.DB), getOperations(c.env.DB)]);
    const ids = [...byUser.keys()];
    const names = new Map<string, string>();
    if (ids.length) {
      const { results } = await c.env.DB.prepare(`SELECT id, nickname FROM users WHERE id IN (${ids.map(() => "?").join(",")})`)
        .bind(...ids)
        .all<{ id: string; nickname: string }>();
      for (const r of results) names.set(r.id, r.nickname);
    }
    return c.json({
      total,
      users: ids.map((id) => ({ userId: id, nickname: names.get(id) ?? "(不明)", totals: byUser.get(id)! })),
      closingMode: ops.closingMode,
    } satisfies AdminCashSummary);
  })

  .get("/closings", async (c) => {
    const auth = requireAuth(c);
    const { results } = await c.env.DB.prepare(
      `${CLOSING_SELECT} ${auth.role === "ADMIN" ? "" : "WHERE c.closed_by = ?"} ORDER BY c.closed_at DESC LIMIT 100`,
    )
      .bind(...(auth.role === "ADMIN" ? [] : [auth.userId]))
      .all<ClosingRow>();
    return c.json({ closings: results.map(toClosingDto) });
  })

  .post(
    "/closings",
    zv(
      "json",
      z.object({
        target: z.enum(["SELF", "ALL", "USER"]),
        userId: z.string().length(26).optional(),
        // 実際に数えた金額は任意。入力があれば差異(数えた額 − 期待額)を記録する
        countedAmount: z.number().int().min(0).max(100_000_000).nullable().optional(),
        note: z.string().trim().max(300).optional(),
      }),
    ),
    async (c) => {
      const auth = requireAuth(c);
      const b = c.req.valid("json");
      const db = c.env.DB;
      const ops = await getOperations(db);

      let scopeUserId: string | null = null;
      if (auth.role === "RECEPTION") {
        if (b.target !== "SELF") throw forbidden("自分の分だけ締められます");
        if (ops.closingMode !== "SHIFT") throw forbidden("現在の設定では、受付担当者は締められません。全体管理者が締めます", "CLOSING_ADMIN_ONLY");
        scopeUserId = auth.userId;
      } else {
        if (b.target === "SELF") throw badRequest("全体管理者は「全受付」または担当者を指定してください");
        if (b.target === "USER") {
          if (!b.userId) throw badRequest("担当者を指定してください");
          const u = await getUserBasic(db, b.userId);
          if (!u || u.role !== "RECEPTION") throw notFound("受付担当者が見つかりません");
          scopeUserId = b.userId;
        }
      }
      const scopeKind: ClosingDto["scopeKind"] = scopeUserId ? "SHIFT" : ops.closingMode === "MANUAL" ? "MANUAL" : "DAY";

      const closingId = newId();
      const now = Date.now();
      const filter = `closing_id IS NULL AND created_at <= ? ${scopeUserId ? "AND reception_user_id = ?" : ""}`;
      const filterArgs = scopeUserId ? [now, scopeUserId] : [now];
      const counted = b.countedAmount ?? null;

      // 同じ基準時刻(now)以前の未締めイベントだけを、集計と紐付けの両方で使う。1つのトランザクションで実行される
      await db.batch([
        db
          .prepare(
            `INSERT INTO cash_closings (id, scope_kind, scope_user_id, period_start, period_end, expected_amount, counted_amount, difference, note, closed_by, closed_at)
             SELECT ?, ?, ?, t.mn, ?, t.exp, ?, CASE WHEN ? IS NULL THEN NULL ELSE ? - t.exp END, ?, ?, ?
               FROM (SELECT COUNT(*) AS cnt, MIN(created_at) AS mn,
                            COALESCE(SUM(CASE kind WHEN 'CHARGE' THEN amount WHEN 'PAYOUT' THEN -amount WHEN 'DROP' THEN -amount ELSE amount END), 0) AS exp
                       FROM cash_events WHERE ${filter}) t
              WHERE t.cnt > 0`,
          )
          .bind(closingId, scopeKind, scopeUserId, now, counted, counted, counted, b.note ?? null, auth.userId, now, ...filterArgs),
        db
          .prepare(
            `UPDATE cash_events SET closing_id = ?
              WHERE ${filter} AND EXISTS (SELECT 1 FROM cash_closings WHERE id = ?)`,
          )
          .bind(closingId, ...filterArgs, closingId),
        auditStmtIfExists(
          db,
          {
            actor: auth,
            action: "cash.close",
            targetType: "cash_closing",
            targetId: closingId,
            after: { scopeKind, scopeUserId, countedAmount: counted },
            reason: b.note,
          },
          "SELECT 1 FROM cash_closings WHERE id = ?",
          [closingId],
        ),
      ]);

      const row = await db.prepare(`${CLOSING_SELECT} WHERE c.id = ?`).bind(closingId).first<ClosingRow>();
      if (!row) throw conflict("締める対象の現金記録がありません", "NOTHING_TO_CLOSE");
      return c.json({ closing: toClosingDto(row) }, 201);
    },
  );
