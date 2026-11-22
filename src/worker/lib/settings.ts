import type { ClosingMode, OperationSettings } from "@shared/api";
import { DEFAULT_CURRENCY, type CurrencySettings } from "@shared/currency";

export const SETTING_KEYS = {
  currency: "currency",
  festivalName: "festival.name",
  operations: "operations",
  expiry: "expiry",
} as const;

export const DEFAULT_OPERATIONS: OperationSettings = { closingMode: "DAY", qrTtlSeconds: 300, paymentSessionSeconds: 300 };

export async function getSetting<T>(db: D1Database, key: string, fallback: T): Promise<T> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export function setSettingStmt(db: D1Database, key: string, value: unknown, actorUserId: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    )
    .bind(key, JSON.stringify(value), Date.now(), actorUserId);
}

export async function getCurrency(db: D1Database): Promise<CurrencySettings> {
  const saved = await getSetting<Partial<CurrencySettings>>(db, SETTING_KEYS.currency, {});
  return { ...DEFAULT_CURRENCY, ...saved };
}

export async function getFestivalName(db: D1Database): Promise<string> {
  return getSetting<string>(db, SETTING_KEYS.festivalName, "学園祭");
}

export async function getOperations(db: D1Database): Promise<OperationSettings> {
  const saved = await getSetting<Partial<OperationSettings>>(db, SETTING_KEYS.operations, {});
  return { ...DEFAULT_OPERATIONS, ...saved };
}

export type { ClosingMode };
