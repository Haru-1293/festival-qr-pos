import type { ProductDto, SetDto } from "@shared/api";
import type { CartLine } from "./useCart";

export interface CartLineView {
  name: string;
  /** 1点あたりの金額(セットは追加料金を含む)。見つからないときは 0 */
  unit: number;
  /** 値下げ前の1点あたり金額(値下げがないときは unit と同じ) */
  listUnit: number;
  /** セットの内訳。「フード: 焼きそば(+50)」の形 */
  details: string[];
  /** 買えない理由(画面上の目安。確定時はサーバーが最終判断する) */
  problem: string | null;
}

/** 画面に出す1行ぶんの情報。いまの商品一覧・セット一覧から計算する(価格はカートに保存していない) */
export function viewCartLine(l: CartLine, products: ProductDto[], sets: SetDto[]): CartLineView {
  if (l.setId) {
    const s = sets.find((x) => x.id === l.setId);
    if (!s) return { name: "(販売終了のセット)", unit: 0, listUnit: 0, details: [], problem: "このセットは販売されていません" };
    const details: string[] = [];
    let sur = 0;
    let problem: string | null = s.available ? null : "このセットは現在売り切れです";
    for (const g of s.segments) {
      const picked = l.picks?.[g.id] ?? [];
      for (const pid of picked) {
        const it = g.items.find((i) => i.productId === pid);
        if (!it) {
          problem ??= "内訳が変更されました。選び直してください";
          continue;
        }
        sur += it.surcharge;
        if (it.disabled) problem ??= `${it.name} は選べません`;
        details.push(`${g.name}: ${it.name}${it.surcharge > 0 ? `(+${it.surcharge})` : ""}`);
      }
    }
    return { name: s.name, unit: s.salePrice + sur, listUnit: s.price + sur, details, problem };
  }
  const p = products.find((x) => x.id === l.productId);
  if (!p || p.salePrice === null) return { name: "(販売終了)", unit: 0, listUnit: 0, details: [], problem: "この商品は販売されていません" };
  const problem = p.soldOut ? "売り切れです" : p.trackStock && p.stockQty !== null && p.stockQty < l.quantity ? `残り${p.stockQty}個です` : null;
  return { name: p.name, unit: p.salePrice, listUnit: p.price ?? p.salePrice, details: [], problem };
}
