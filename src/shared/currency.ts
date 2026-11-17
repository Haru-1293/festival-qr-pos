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

export function formatMoney(amount: number, c: CurrencySettings = DEFAULT_CURRENCY): string {
  const digits = c.allowDecimals ? 2 : 0;
  const n = amount.toLocaleString("ja-JP", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return c.symbolPosition === "before" ? `${c.shortName}${n}` : `${n}${c.shortName}`;
}
