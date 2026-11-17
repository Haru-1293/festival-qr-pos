/**
 * 通貨表示設定(仕様 §2)。
 * 残高・取引金額の内部の数値は変えない。名称・表示位置・説明だけが変わる。
 */
export interface CurrencySettings {
  name: string; // 正式名称(例: 学祭ポイント)
  shortName: string; // 短縮名称(例: pt)
  symbolPosition: "before" | "after"; // 数値の前/後
  allowDecimals: boolean;
  yenPerUnit: number; // 1単位あたりの円(表示・受付向け。既存残高は自動換算しない)
  description: string; // 利用者・受付向けの説明文
}

export const DEFAULT_CURRENCY: CurrencySettings = {
  name: "ポイント",
  shortName: "pt",
  symbolPosition: "after",
  allowDecimals: false,
  yenPerUnit: 1,
  description: "1ポイント=1円相当です。",
};

/**
 * 受け取った現金(円)をポイントへ換算する。割り切れない場合は null(端数は作らない)。
 * yenPerUnit は「1ポイントあたり何円か」。
 */
export function cashToUnits(cashYen: number, yenPerUnit: number): number | null {
  if (!Number.isFinite(cashYen) || !(yenPerUnit > 0)) return null;
  const units = cashYen / yenPerUnit;
  const rounded = Math.round(units);
  return Math.abs(units - rounded) > 1e-9 ? null : rounded;
}

/** ポイントを現金(円)へ換算する(払戻し用)。円が整数にならない場合は null */
export function unitsToCash(units: number, yenPerUnit: number): number | null {
  if (!Number.isFinite(units) || !(yenPerUnit > 0)) return null;
  const cash = units * yenPerUnit;
  const rounded = Math.round(cash);
  return Math.abs(cash - rounded) > 1e-9 ? null : rounded;
}

export function formatMoney(amount: number, c: CurrencySettings = DEFAULT_CURRENCY): string {
  const digits = c.allowDecimals ? 2 : 0;
  const n = amount.toLocaleString("ja-JP", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return c.symbolPosition === "before" ? `${c.shortName}${n}` : `${n}${c.shortName}`;
}
