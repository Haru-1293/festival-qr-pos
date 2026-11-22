import type { ExpiryPolicy } from "@shared/api";
import { getSetting, SETTING_KEYS } from "./settings";

/** 6か月特例の上限(日)。カード・ウォレットの有効期限はこの範囲に収める */
export const MAX_VALID_DAYS = 184;
export const DEFAULT_EXPIRY_POLICY: ExpiryPolicy = { mode: "DAYS", days: 180, date: null };
const DAY = 24 * 60 * 60 * 1000;

export async function getExpiryPolicy(db: D1Database): Promise<ExpiryPolicy> {
  const saved = await getSetting<Partial<ExpiryPolicy>>(db, SETTING_KEYS.expiry, {});
  return { ...DEFAULT_EXPIRY_POLICY, ...saved };
}

/** 日本時間のその日の終わり(23:59:59.999)をミリ秒で返す。YYYY-MM-DD 以外は NaN */
export function endOfDayJst(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NaN;
  return Date.parse(`${date}T23:59:59.999+09:00`);
}

export const maxExpiry = (now: number) => now + MAX_VALID_DAYS * DAY;

/** 設定した有効期限を、いまの時点の日時に直す。固定日がすでに過ぎている/不正なときは null */
export function resolveExpiry(policy: ExpiryPolicy, now: number): number | null {
  if (policy.mode === "DATE") {
    const t = policy.date ? endOfDayJst(policy.date) : NaN;
    if (!Number.isFinite(t) || t <= now) return null;
    return Math.min(t, maxExpiry(now));
  }
  return now + Math.min(Math.max(policy.days, 1), MAX_VALID_DAYS) * DAY;
}

/** 保存時の検証。問題があれば理由を返す */
export function validatePolicy(policy: ExpiryPolicy, now: number): string | null {
  if (policy.mode === "DAYS") {
    if (!Number.isInteger(policy.days) || policy.days < 1 || policy.days > MAX_VALID_DAYS) return `日数は1〜${MAX_VALID_DAYS}日で指定してください`;
    return null;
  }
  const t = policy.date ? endOfDayJst(policy.date) : NaN;
  if (!Number.isFinite(t)) return "日付を指定してください";
  if (t <= now) return "有効期限の日付は今日より後にしてください";
  if (t > maxExpiry(now)) return `有効期限は今日から${MAX_VALID_DAYS}日(6か月)以内にしてください(前払式支払手段の特例)`;
  return null;
}

/** ウォレットが期限内かどうかの SQL 条件。時刻は数値リテラルとして埋め込む(バインド数の節約) */
export const walletNotExpiredSql = (now: number, a = "w") => `(${a}.expires_at IS NULL OR ${a}.expires_at > ${Math.trunc(now)})`;
