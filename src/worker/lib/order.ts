import type { PayResult, Quote, QuoteDiscount, QuoteLine, QuoteProblem, CartItemInput } from "@shared/api";
import { cutAmount } from "@shared/pricing";
import { catalogSignature, loadRunningCut, loadVersion } from "./catalog";
import { computeDiscounts, type AppliedDiscount } from "./discounts";

/** 取引番号(画面表示用)。注文IDの末尾8文字 */
export const orderNo = (orderId: string): string => orderId.slice(-8);

/** セットで選ばれた内訳(同じ内訳・同じ商品はまとめた数) */
export interface PickRow {
  segmentId: string;
  segmentName: string;
  productId: string;
  name: string;
  surcharge: number;
  /** 1セットあたりの選択数 */
  count: number;
}

/** 見積もりの1行。確定時の整合チェック(SQL のガード)に使う値も持つ */
export interface RawLine extends QuoteLine {
  discountable: boolean;
  /** セットのとき: 選ばれた内訳 */
  pickRows?: PickRow[];
  /** この行へ按分された割引(全ユーザー割引・クーポンの合計) */
  discountAllocated: number;
}

/** 商品ごとの在庫の必要数(単品販売ぶん/セット内ぶん)。同じ注文の単品とセット内は合算して在庫を確かめる */
export interface ProductNeed {
  productId: string;
  name: string;
  trackStock: boolean;
  single: number;
  inSet: number;
}

export interface CartQuote extends Quote {
  raw: RawLine[];
  needs: ProductNeed[];
  /** 確定時の SQL ガードと記録に使う、適用された割引の詳細 */
  applied: AppliedDiscount[];
}

interface ProductRow {
  id: string;
  name: string;
  price: number | null;
  sale_mode: string;
  status: string;
  manual_sold_out: number;
  track_stock: number;
  stock_qty: number | null;
  discountable: number;
}
interface SetRow {
  id: string;
  name: string;
  price: number;
  status: string;
  manual_sold_out: number;
  discountable: number;
}
interface SegRow {
  id: string;
  set_id: string;
  name: string;
  required: number;
  pick_count: number;
  allow_duplicate: number;
}

const pickKey = (picks: Record<string, string[]> | undefined) =>
  Object.keys(picks ?? {})
    .sort()
    .map((k) => `${k}=${[...(picks![k] ?? [])].sort().join(",")}`)
    .join(";");

/**
 * カートを、いまの価格・値下げ・在庫で見積もる。価格は必ずサーバーで計算し、画面の価格は信用しない。
 * 買えない商品・セット(停止・売り切れ・在庫不足・内訳の選び方が不正など)は problems に入れる。
 * セットの価格は「セット価格(値下げ対象なら値下げ後) + 選んだ内訳の追加料金」。追加料金は値下げしない(仮定 A18)。
 */
export async function quoteCart(
  db: D1Database,
  shopId: string,
  items: CartItemInput[],
  now: number,
  couponCode: string | null = null,
  walletId: string | null = null,
): Promise<CartQuote> {
  // 同じ商品・同じ選び方のセットが複数行に分かれていても1行にまとめる
  const merged = new Map<string, CartItemInput & { quantity: number }>();
  for (const i of items) {
    const key = i.setId ? `s:${i.setId}:${pickKey(i.picks)}` : `p:${i.productId}`;
    const m = merged.get(key);
    if (m) m.quantity += i.quantity;
    else merged.set(key, { ...i, picks: i.picks ? Object.fromEntries(Object.entries(i.picks).map(([k, v]) => [k, [...v]])) : undefined });
  }
  const list = [...merged.values()];
  const setIds = [...new Set(list.filter((i) => i.setId).map((i) => i.setId!))];
  const pickedIds = list.flatMap((i) => Object.values(i.picks ?? {}).flat());
  const productIds = [...new Set([...list.filter((i) => i.productId).map((i) => i.productId!), ...pickedIds])];
  const qs = (n: number) => Array(Math.max(n, 1)).fill("?").join(",");

  const [prodRes, setRes, segRes, itemRes, cut, version] = await Promise.all([
    productIds.length
      ? db
          .prepare(
            `SELECT id, name, price, sale_mode, status, manual_sold_out, track_stock, stock_qty, discountable
               FROM products WHERE shop_id = ? AND id IN (${qs(productIds.length)})`,
          )
          .bind(shopId, ...productIds)
          .all<ProductRow>()
      : Promise.resolve({ results: [] as ProductRow[] }),
    setIds.length
      ? db
          .prepare(`SELECT id, name, price, status, manual_sold_out, discountable FROM sets WHERE shop_id = ? AND id IN (${qs(setIds.length)})`)
          .bind(shopId, ...setIds)
          .all<SetRow>()
      : Promise.resolve({ results: [] as SetRow[] }),
    setIds.length
      ? db
          .prepare(`SELECT id, set_id, name, required, pick_count, allow_duplicate FROM set_segments WHERE set_id IN (${qs(setIds.length)}) ORDER BY sort_order`)
          .bind(...setIds)
          .all<SegRow>()
      : Promise.resolve({ results: [] as SegRow[] }),
    setIds.length
      ? db
          .prepare(
            `SELECT i.segment_id, i.product_id, i.surcharge FROM set_segment_items i JOIN set_segments g ON g.id = i.segment_id
              WHERE g.set_id IN (${qs(setIds.length)})`,
          )
          .bind(...setIds)
          .all<{ segment_id: string; product_id: string; surcharge: number }>()
      : Promise.resolve({ results: [] as { segment_id: string; product_id: string; surcharge: number }[] }),
    loadRunningCut(db, shopId, now),
    loadVersion(db, shopId),
  ]);
  const prodById = new Map(prodRes.results.map((r) => [r.id, r]));
  const setById = new Map(setRes.results.map((r) => [r.id, r]));
  const segsBySet = new Map<string, SegRow[]>();
  for (const g of segRes.results) segsBySet.set(g.set_id, [...(segsBySet.get(g.set_id) ?? []), g]);
  const surchargeOf = new Map(itemRes.results.map((r) => [`${r.segment_id}|${r.product_id}`, r.surcharge]));

  const raw: RawLine[] = [];
  const problems: QuoteProblem[] = [];
  const needMap = new Map<string, ProductNeed>();
  const addNeed = (p: ProductRow, kind: "single" | "inSet", qty: number) => {
    const n = needMap.get(p.id) ?? { productId: p.id, name: p.name, trackStock: p.track_stock === 1, single: 0, inSet: 0 };
    n[kind] += qty;
    needMap.set(p.id, n);
  };
  // 売り切れ・停止などの共通チェック(在庫の数は合算してあとで確かめる)
  const soldOutProblem = (p: ProductRow): string | null =>
    p.manual_sold_out === 1 || (p.track_stock === 1 && p.stock_qty === 0) ? `${p.name} は売り切れです` : null;

  for (const it of list) {
    if (it.setId) {
      const st = setById.get(it.setId);
      const bad = (message: string, code: QuoteProblem["code"] = "INVALID_PICKS") => problems.push({ productId: it.setId!, name: st?.name ?? null, code, message });
      if (!st) {
        bad("セットが見つかりません", "NOT_FOUND");
        continue;
      }
      if (st.status !== "ACTIVE") {
        bad(`${st.name} は現在販売していません`, "UNAVAILABLE");
        continue;
      }
      if (st.manual_sold_out === 1) {
        bad(`${st.name} は売り切れです`, "SOLD_OUT");
        continue;
      }
      const segs = segsBySet.get(st.id) ?? [];
      const picks = it.picks ?? {};
      const segIds = new Set(segs.map((g) => g.id));
      if (Object.keys(picks).some((k) => !segIds.has(k))) {
        bad(`${st.name} の内訳が変更されました。選び直してください`);
        continue;
      }
      const pickRows: PickRow[] = [];
      let ok = true;
      for (const g of segs) {
        const arr = picks[g.id] ?? [];
        const needCount = g.pick_count;
        if (arr.length !== needCount && !(g.required === 0 && arr.length === 0)) {
          bad(`${st.name}「${g.name}」を${needCount}つ選んでください`);
          ok = false;
          break;
        }
        const counts = new Map<string, number>();
        for (const pid of arr) {
          const sur = surchargeOf.get(`${g.id}|${pid}`);
          const p = prodById.get(pid);
          if (sur === undefined || !p) {
            bad(`${st.name}「${g.name}」に選べない商品が含まれています。選び直してください`);
            ok = false;
            break;
          }
          if (p.status !== "ACTIVE" || p.sale_mode === "SINGLE_ONLY") {
            bad(`${p.name} は現在セットに入れられません`, "UNAVAILABLE");
            ok = false;
            break;
          }
          const so = soldOutProblem(p);
          if (so) {
            bad(so, "SOLD_OUT");
            ok = false;
            break;
          }
          counts.set(pid, (counts.get(pid) ?? 0) + 1);
        }
        if (!ok) break;
        if (g.allow_duplicate === 0 && [...counts.values()].some((n) => n > 1)) {
          bad(`${st.name}「${g.name}」は同じ商品を重ねて選べません`);
          ok = false;
          break;
        }
        for (const [pid, count] of counts) {
          const p = prodById.get(pid)!;
          pickRows.push({ segmentId: g.id, segmentName: g.name, productId: pid, name: p.name, surcharge: surchargeOf.get(`${g.id}|${pid}`)!, count });
        }
      }
      if (!ok) continue;
      if (pickRows.length === 0) {
        bad(`${st.name} の内訳を選んでください`);
        continue;
      }
      for (const r of pickRows) addNeed(prodById.get(r.productId)!, "inSet", r.count * it.quantity);
      const down = st.discountable === 1 ? cutAmount(st.price, cut) : 0;
      const unit = st.price - down;
      const perUnitSurcharge = pickRows.reduce((a, r) => a + r.surcharge * r.count, 0);
      raw.push({
        kind: "SET",
        productId: st.id,
        name: st.name,
        quantity: it.quantity,
        listUnitPrice: st.price,
        unitPrice: unit,
        surchargeTotal: perUnitSurcharge * it.quantity,
        lineTotal: unit * it.quantity + perUnitSurcharge * it.quantity,
        discountable: st.discountable === 1,
        discountAllocated: 0,
        pickRows,
        components: pickRows.flatMap((r) =>
          Array.from({ length: r.count }, () => ({ segmentName: r.segmentName, productId: r.productId, name: r.name, surcharge: r.surcharge })),
        ),
      });
      continue;
    }

    const productId = it.productId!;
    const p = prodById.get(productId);
    if (!p) {
      problems.push({ productId, name: null, code: "NOT_FOUND", message: "商品が見つかりません" });
      continue;
    }
    if (p.status !== "ACTIVE" || p.sale_mode === "SET_ONLY") {
      problems.push({ productId, name: p.name, code: "UNAVAILABLE", message: `${p.name} は現在販売していません` });
      continue;
    }
    if (p.price === null) {
      problems.push({ productId, name: p.name, code: "NO_PRICE", message: `${p.name} は価格が設定されていません` });
      continue;
    }
    const so = soldOutProblem(p);
    if (so) {
      problems.push({ productId, name: p.name, code: "SOLD_OUT", message: so });
      continue;
    }
    addNeed(p, "single", it.quantity);
    const down = p.discountable === 1 ? cutAmount(p.price, cut) : 0;
    const unit = p.price - down;
    raw.push({
      kind: "PRODUCT",
      productId,
      name: p.name,
      quantity: it.quantity,
      listUnitPrice: p.price,
      unitPrice: unit,
      surchargeTotal: 0,
      lineTotal: unit * it.quantity,
      discountable: p.discountable === 1,
      discountAllocated: 0,
    });
  }

  // 在庫は、単品とセット内の同じ商品を合算して確かめる
  const needs = [...needMap.values()];
  for (const n of needs) {
    const p = prodById.get(n.productId)!;
    const total = n.single + n.inSet;
    if (n.trackStock && p.stock_qty !== null && p.stock_qty < total) {
      problems.push({ productId: n.productId, name: n.name, code: "INSUFFICIENT_STOCK", message: `${n.name} は残り${p.stock_qty}個です`, available: p.stock_qty });
    }
  }
  // 割引(全ユーザー割引 → クーポン)。割引の対象は、割引対象の商品の値下げ後の価格(セットの追加料金は対象外)
  const subtotal = raw.reduce((a, l) => a + l.lineTotal, 0);
  const dres =
    problems.length === 0 || couponCode
      ? await computeDiscounts(
          db,
          shopId,
          raw.map((l) => ({ base: l.discountable ? l.unitPrice * l.quantity : 0 })),
          subtotal,
          now,
          couponCode,
          walletId,
        )
      : { discounts: [], perLine: raw.map(() => 0), couponError: null };
  raw.forEach((l, i) => (l.discountAllocated = dres.perLine[i]));
  const discountTotal = dres.perLine.reduce((a, n) => a + n, 0);
  const lines: QuoteLine[] = raw.map(({ discountable: _d, pickRows: _p, discountAllocated: _a, ...l }) => l);
  return {
    lines,
    raw,
    needs,
    applied: dres.discounts,
    subtotal,
    discounts: dres.discounts.map(({ kind, discountId, couponId, name, amount }) => ({ kind, discountId, couponId, name, amount })),
    discountTotal,
    couponError: dres.couponError,
    total: subtotal - discountTotal,
    cut: cut ? { id: cut.id, name: cut.name } : null,
    problems,
    signature: catalogSignature(version, cut),
  };
}

/** 確定済みの注文の結果(再送・結果照会で同じ内容を返すために使う) */
export async function loadPayResult(db: D1Database, orderId: string): Promise<PayResult | null> {
  const o = await db
    .prepare(
      `SELECT o.id, o.total_paid, o.subtotal, o.paid_at, l.balance_after FROM orders o LEFT JOIN wallet_ledger l ON l.id = o.ledger_id WHERE o.id = ?`,
    )
    .bind(orderId)
    .first<{ id: string; total_paid: number; subtotal: number; paid_at: number; balance_after: number | null }>();
  if (!o) return null;
  const [{ results }, { results: comps }, { results: discs }] = await Promise.all([
    db
      .prepare(
        `SELECT id, kind, product_id, set_id, name_snapshot, quantity, list_unit_price, unit_price, surcharge_total, line_subtotal
           FROM order_lines WHERE order_id = ? ORDER BY line_no`,
      )
      .bind(orderId)
      .all<{
        id: string;
        kind: "PRODUCT" | "SET";
        product_id: string | null;
        set_id: string | null;
        name_snapshot: string;
        quantity: number;
        list_unit_price: number | null;
        unit_price: number;
        surcharge_total: number;
        line_subtotal: number;
      }>(),
    db
      .prepare(
        `SELECT c.order_line_id, c.segment_name_snapshot, c.product_id, c.name_snapshot, c.quantity, c.surcharge
           FROM order_line_components c JOIN order_lines l ON l.id = c.order_line_id WHERE l.order_id = ? ORDER BY c.rowid`,
      )
      .bind(orderId)
      .all<{ order_line_id: string; segment_name_snapshot: string; product_id: string; name_snapshot: string; quantity: number; surcharge: number }>(),
    db
      .prepare(`SELECT kind, discount_id, coupon_id, name_snapshot, amount FROM order_discounts WHERE order_id = ? ORDER BY apply_seq`)
      .bind(orderId)
      .all<{ kind: QuoteDiscount["kind"]; discount_id: string | null; coupon_id: string | null; name_snapshot: string; amount: number }>(),
  ]);
  return {
    orderId: o.id,
    orderNo: orderNo(o.id),
    subtotal: o.subtotal,
    discounts: discs.map((d) => ({ kind: d.kind, discountId: d.discount_id ?? "", couponId: d.coupon_id, name: d.name_snapshot, amount: d.amount })),
    total: o.total_paid,
    balanceAfter: o.balance_after ?? 0,
    paidAt: o.paid_at,
    lines: results.map((r) => ({
      kind: r.kind,
      productId: (r.kind === "SET" ? r.set_id : r.product_id) ?? "",
      name: r.name_snapshot,
      quantity: r.quantity,
      listUnitPrice: r.list_unit_price ?? r.unit_price,
      unitPrice: r.unit_price,
      surchargeTotal: r.surcharge_total,
      lineTotal: r.line_subtotal,
      components:
        r.kind === "SET"
          ? comps
              .filter((c) => c.order_line_id === r.id)
              .flatMap((c) =>
                // 保存は「数量ぶんの合計」。1セットあたりの個数に戻して並べる
                Array.from({ length: c.quantity / r.quantity }, () => ({
                  segmentName: c.segment_name_snapshot,
                  productId: c.product_id,
                  name: c.name_snapshot,
                  surcharge: c.surcharge,
                })),
              )
          : undefined,
    })),
  };
}
