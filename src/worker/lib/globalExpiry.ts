import { conflict } from "./errors";
import { endOfDayJst, MAX_VALID_DAYS } from "./expiry";
import { getSetting, SETTING_KEYS } from "./settings";

/** 全体の有効期限(全体管理者が設定)。date は日本時間のその日の23:59:59まで。未設定は null */
export interface GlobalExpiry {
  date: string | null;
}

export async function getGlobalExpiry(db: D1Database): Promise<GlobalExpiry> {
  const saved = await getSetting<Partial<GlobalExpiry>>(db, SETTING_KEYS.globalExpiry, {});
  return { date: typeof saved.date === "string" && Number.isFinite(endOfDayJst(saved.date)) ? saved.date : null };
}

/** 全体の期限を日時(ミリ秒)にする。未設定は null */
export const globalExpiryMs = (g: GlobalExpiry): number | null => (g.date ? endOfDayJst(g.date) : null);

/** 日付 YYYY-MM-DD の1か月後(31日→翌月末のように月末に丸める) */
export function addOneMonth(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); // 翌月の末日
  const t = new Date(Date.UTC(y, m, Math.min(d, last)));
  return t.toISOString().slice(0, 10);
}

/** 全データ削除ができるようになる日時。全体の期限が切れた1か月後(その日の終わり)。未設定は null */
export function resetAvailableAt(g: GlobalExpiry): number | null {
  return g.date ? endOfDayJst(addOneMonth(g.date)) : null;
}

/** 保存時の検証。今日より後で、今日から184日以内(6か月特例) */
export function validateGlobalDate(date: string, now: number): string | null {
  const t = endOfDayJst(date);
  if (!Number.isFinite(t)) return "日付の形式が正しくありません";
  if (t <= now) return "全体の有効期限は今日より後の日付にしてください";
  if (t > now + MAX_VALID_DAYS * 24 * 60 * 60 * 1000) return `全体の有効期限は今日から${MAX_VALID_DAYS}日(6か月)以内にしてください(前払式支払手段の特例)`;
  return null;
}

/**
 * 新しく発行・登録するものの期限を、全体の期限でおさえる。
 * 全体の期限をすぎていれば、新しい発行・登録はできない。
 */
export async function capByGlobal(db: D1Database, expiresAt: number, now: number): Promise<number> {
  const g = globalExpiryMs(await getGlobalExpiry(db));
  if (g === null) return expiresAt;
  if (g <= now) throw conflict("このサービスの有効期限は終了しています。新しい登録・発行はできません", "SERVICE_EXPIRED");
  return Math.min(expiresAt, g);
}
