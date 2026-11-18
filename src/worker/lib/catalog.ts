import type { CatalogResponse, PriceCutDto, PriceCutState, ProductDto, SaleMode, ProductStatus } from "@shared/api";
import { cutAmount, type PriceCutMethod, type PriceCutRule } from "@shared/pricing";

interface CutRow {
  id: string;
  name: string;
  method: PriceCutMethod;
  value: number;
  starts_at: number | null;
  ends_at: number | null;
  status: "ACTIVE" | "STOPPED" | "ENDED";
  created_at: number;
}

export function cutState(r: Pick<CutRow, "status" | "starts_at" | "ends_at">, now: number): PriceCutState {
  if (r.status === "STOPPED") return "STOPPED";
  if (r.status === "ENDED" || (r.ends_at !== null && r.ends_at <= now)) return "ENDED";
  if (r.starts_at !== null && r.starts_at > now) return "SCHEDULED";
  return "RUNNING";
}

export function toCutDto(r: CutRow, now: number): PriceCutDto {
  return {
    id: r.id,
    name: r.name,
    method: r.method,
    value: r.value,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    state: cutState(r, now),
    createdAt: r.created_at,
  };
}

/** いま実際に価格へ反映されている値下げ(開始済み・未終了・停止されていないもの) */
export async function loadRunningCut(db: D1Database, shopId: string, now: number): Promise<PriceCutDto | null> {
  const r = await db
    .prepare(
      `SELECT id, name, method, value, starts_at, ends_at, status, created_at FROM shop_price_cuts
        WHERE shop_id = ? AND status = 'ACTIVE' AND (starts_at IS NULL OR starts_at <= ?) AND (ends_at IS NULL OR ends_at > ?)`,
    )
    .bind(shopId, now, now)
    .first<CutRow>();
  return r ? toCutDto(r, now) : null;
}

export function catalogSignature(version: number, cut: PriceCutDto | null): string {
  return `${version}:${cut?.id ?? "-"}`;
}

export async function loadVersion(db: D1Database, shopId: string): Promise<number> {
  const r = await db.prepare("SELECT catalog_version AS v FROM shops WHERE id = ?").bind(shopId).first<{ v: number }>();
  return r?.v ?? 0;
}

/** 変更のたびに同じ batch へ入れる。POS はこの番号の変化で商品一覧を取り直す */
export function bumpCatalogStmt(db: D1Database, shopId: string): D1PreparedStatement {
  return db.prepare("UPDATE shops SET catalog_version = catalog_version + 1 WHERE id = ?").bind(shopId);
}

interface ProductRow {
  id: string;
  name: string;
  price: number | null;
  description: string | null;
  sale_mode: SaleMode;
  status: ProductStatus;
  manual_sold_out: number;
  track_stock: number;
  stock_qty: number | null;
  discountable: number;
  sort_order: number;
}

/** 商品一覧(タグ・売り切れ・値下げ後の価格つき)。値下げは「割引対象外」の商品には効かない(仮定 A12) */
export async function loadProducts(
  db: D1Database,
  shopId: string,
  opts: { cut: PriceCutRule | null; includeArchived?: boolean; posOnly?: boolean },
): Promise<ProductDto[]> {
  const where = ["shop_id = ?"];
  if (!opts.includeArchived) where.push("status <> 'ARCHIVED'");
  if (opts.posOnly) where.push("status = 'ACTIVE'", "sale_mode <> 'SET_ONLY'");
  const [{ results: rows }, { results: tagRows }] = await Promise.all([
    db
      .prepare(
        `SELECT id, name, price, description, sale_mode, status, manual_sold_out, track_stock, stock_qty, discountable, sort_order
           FROM products WHERE ${where.join(" AND ")} ORDER BY sort_order, created_at`,
      )
      .bind(shopId)
      .all<ProductRow>(),
    db
      .prepare(
        `SELECT pt.product_id, t.id, t.name, t.color FROM product_tags pt
           JOIN tags t ON t.id = pt.tag_id JOIN products p ON p.id = pt.product_id
          WHERE p.shop_id = ? AND t.active = 1 ORDER BY t.sort_order, t.name`,
      )
      .bind(shopId)
      .all<{ product_id: string; id: string; name: string; color: string | null }>(),
  ]);
  const tagsBy = new Map<string, ProductDto["tags"]>();
  for (const t of tagRows) {
    const list = tagsBy.get(t.product_id) ?? [];
    list.push({ id: t.id, name: t.name, color: t.color });
    tagsBy.set(t.product_id, list);
  }
  return rows.map((r) => {
    const cut = r.price !== null && r.discountable === 1 ? cutAmount(r.price, opts.cut) : 0;
    const stockOut = r.track_stock === 1 && r.stock_qty === 0;
    return {
      id: r.id,
      name: r.name,
      price: r.price,
      salePrice: r.price === null ? null : r.price - cut,
      cutAmount: cut,
      description: r.description,
      saleMode: r.sale_mode,
      status: r.status,
      manualSoldOut: r.manual_sold_out === 1,
      trackStock: r.track_stock === 1,
      stockQty: r.stock_qty,
      soldOut: r.manual_sold_out === 1 || stockOut,
      soldOutReason: r.manual_sold_out === 1 ? "MANUAL" : stockOut ? "STOCK" : null,
      discountable: r.discountable === 1,
      sortOrder: r.sort_order,
      tags: tagsBy.get(r.id) ?? [],
    };
  });
}

/** POS 用の商品一覧。`since` が現在の署名と同じなら中身を返さない(数秒おきの確認を軽くする) */
export async function buildPosCatalog(db: D1Database, shopId: string, since: string | undefined): Promise<CatalogResponse> {
  const now = Date.now();
  const [version, cut] = await Promise.all([loadVersion(db, shopId), loadRunningCut(db, shopId, now)]);
  const signature = catalogSignature(version, cut);
  if (since === signature) return { changed: false, signature, serverTime: now };
  const shop = await db.prepare("SELECT display_name FROM shops WHERE id = ?").bind(shopId).first<{ display_name: string }>();
  const products = await loadProducts(db, shopId, { cut, posOnly: true });
  return { changed: true, signature, serverTime: now, shopName: shop?.display_name ?? "", cut, products };
}
