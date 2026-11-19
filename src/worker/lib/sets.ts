import type { SetDto, SetItemDto, SetSegmentDto, SetUnavailableReason, ProductStatus } from "@shared/api";
import { cutAmount, type PriceCutRule } from "@shared/pricing";

interface SetRow {
  id: string;
  name: string;
  price: number;
  description: string | null;
  status: ProductStatus;
  manual_sold_out: number;
  discountable: number;
  sort_order: number;
}
interface SegRow {
  id: string;
  set_id: string;
  name: string;
  required: number;
  pick_count: number;
  allow_duplicate: number;
  sort_order: number;
}
interface ItemRow {
  segment_id: string;
  product_id: string;
  surcharge: number;
  name: string;
  p_status: string;
  sale_mode: string;
  manual_sold_out: number;
  track_stock: number;
  stock_qty: number | null;
}

/** セットの選択肢として選べない理由(販売停止・アーカイブ・単品専用は「対象外」、売り切れ・在庫なしは無効表示) */
function itemState(r: ItemRow): Pick<SetItemDto, "disabled" | "disabledReason"> {
  if (r.p_status !== "ACTIVE" || r.sale_mode === "SINGLE_ONLY") return { disabled: true, disabledReason: "UNAVAILABLE" };
  if (r.manual_sold_out === 1) return { disabled: true, disabledReason: "SOLD_OUT" };
  if (r.track_stock === 1 && (r.stock_qty ?? 0) <= 0) return { disabled: true, disabledReason: "STOCK" };
  return { disabled: false, disabledReason: null };
}

/**
 * 必須の内訳を、いまの在庫ですべて満たせるか。
 * 重複不可: 選べる商品が必要数以上。重複可: 選べる商品の残数の合計が必要数以上(数量未管理は無制限)。
 * (同じ商品が別の内訳にも出る場合の取り合いは、会計時の在庫チェックで最終確認する)
 */
export function segmentSatisfiable(seg: Pick<SetSegmentDto, "pickCount" | "allowDuplicate" | "items">): boolean {
  const ok = seg.items.filter((i) => !i.disabled);
  if (!seg.allowDuplicate) return ok.length >= seg.pickCount;
  let cap = 0;
  for (const i of ok) {
    if (i.stockQty === null) return ok.length > 0;
    cap += i.stockQty;
  }
  return cap >= seg.pickCount;
}

export async function loadSets(
  db: D1Database,
  shopId: string,
  opts: { cut: PriceCutRule | null; includeArchived?: boolean; posOnly?: boolean },
): Promise<SetDto[]> {
  const where = ["shop_id = ?"];
  if (!opts.includeArchived) where.push("status <> 'ARCHIVED'");
  if (opts.posOnly) where.push("status = 'ACTIVE'");
  const [{ results: sets }, { results: segs }, { results: items }] = await Promise.all([
    db
      .prepare(`SELECT id, name, price, description, status, manual_sold_out, discountable, sort_order FROM sets WHERE ${where.join(" AND ")} ORDER BY sort_order, created_at`)
      .bind(shopId)
      .all<SetRow>(),
    db
      .prepare(
        `SELECT g.id, g.set_id, g.name, g.required, g.pick_count, g.allow_duplicate, g.sort_order FROM set_segments g
           JOIN sets s ON s.id = g.set_id WHERE s.shop_id = ? ORDER BY g.sort_order, g.id`,
      )
      .bind(shopId)
      .all<SegRow>(),
    db
      .prepare(
        `SELECT i.segment_id, i.product_id, i.surcharge, p.name, p.status AS p_status, p.sale_mode, p.manual_sold_out, p.track_stock, p.stock_qty
           FROM set_segment_items i JOIN set_segments g ON g.id = i.segment_id JOIN sets s ON s.id = g.set_id JOIN products p ON p.id = i.product_id
          WHERE s.shop_id = ? ORDER BY i.sort_order, p.name`,
      )
      .bind(shopId)
      .all<ItemRow>(),
  ]);
  const itemsBy = new Map<string, SetItemDto[]>();
  for (const r of items) {
    const list = itemsBy.get(r.segment_id) ?? [];
    list.push({ productId: r.product_id, name: r.name, surcharge: r.surcharge, stockQty: r.track_stock === 1 ? r.stock_qty : null, ...itemState(r) });
    itemsBy.set(r.segment_id, list);
  }
  const segsBy = new Map<string, SetSegmentDto[]>();
  for (const g of segs) {
    const list = segsBy.get(g.set_id) ?? [];
    list.push({
      id: g.id,
      name: g.name,
      required: g.required === 1,
      pickCount: g.pick_count,
      allowDuplicate: g.allow_duplicate === 1,
      sortOrder: g.sort_order,
      items: itemsBy.get(g.id) ?? [],
    });
    segsBy.set(g.set_id, list);
  }
  return sets.map((s) => {
    const segments = segsBy.get(s.id) ?? [];
    let reason: SetUnavailableReason | null = null;
    if (s.status !== "ACTIVE") reason = "STOPPED";
    else if (s.manual_sold_out === 1) reason = "MANUAL";
    else if (segments.length === 0 || segments.some((g) => g.required && !segmentSatisfiable(g))) reason = "NO_OPTIONS";
    const down = s.discountable === 1 ? cutAmount(s.price, opts.cut) : 0;
    return {
      id: s.id,
      name: s.name,
      price: s.price,
      salePrice: s.price - down,
      cutAmount: down,
      description: s.description,
      status: s.status,
      manualSoldOut: s.manual_sold_out === 1,
      discountable: s.discountable === 1,
      sortOrder: s.sort_order,
      segments,
      available: reason === null,
      unavailableReason: reason,
    };
  });
}
