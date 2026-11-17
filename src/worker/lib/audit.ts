import type { AuthContext } from "../env";
import { newId } from "./ids";

export interface AuditEntry {
  actor: Pick<AuthContext, "userId" | "role"> | null;
  action: string;
  targetType?: string;
  targetId?: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
}

/**
 * 監査ログの INSERT 文を返す。変更本体と同じ db.batch() に入れて原子的に記録する。
 * パスワード・PIN・生のQRトークンは呼び出し側が before/after に含めないこと。
 */
export function auditStmt(db: D1Database, e: AuditEntry): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_logs (id, actor_user_id, actor_role, action, target_type, target_id, before_json, after_json, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(...auditBindings(e));
}

/**
 * 「この行が実際に作られたときだけ」監査ログを書く版。
 * 条件付きの INSERT(ガードに外れて 0 行だった操作)と同じ batch に入れ、失敗した操作の記録が残らないようにする。
 * existsSql は `SELECT 1 FROM ... WHERE ...` の形で、先に実行した文の結果を見る。
 */
export function auditStmtIfExists(
  db: D1Database,
  e: AuditEntry,
  existsSql: string,
  existsArgs: unknown[],
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_logs (id, actor_user_id, actor_role, action, target_type, target_id, before_json, after_json, reason, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (${existsSql})`,
    )
    .bind(...auditBindings(e), ...existsArgs);
}

function auditBindings(e: AuditEntry): unknown[] {
  return [
    newId(),
    e.actor?.userId ?? null,
    e.actor?.role ?? null,
    e.action,
    e.targetType ?? null,
    e.targetId ?? null,
    e.before === undefined ? null : JSON.stringify(e.before),
    e.after === undefined ? null : JSON.stringify(e.after),
    e.reason ?? null,
    Date.now(),
  ];
}
