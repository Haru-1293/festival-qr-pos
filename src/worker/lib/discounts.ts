import type { QuoteDiscount } from "@shared/api";

/** 割引の計算に必要な、見積もり行の最小の形 */
export interface DiscountLineInput {
  /** 割引対象にできる金額(値下げ後の単価 × 数量。セットの追加料金は含めない。割引対象外なら 0) */
  base: number;
}

interface RuleRow {
  id: string;
  name: string;
  method: "PERCENT" | "FIXED";
  value: number;
  min_order_amount: number | null;
  max_discount_amount: number | null;
  combinable_with_coupon: number;
}

interface CouponRow extends RuleRow {
  coupon_id: string;
  code: string;
  kind: "COMMON" | "ONE_TIME";
  total_limit: number | null;
  per_wallet_limit: number | null;
  used_count: number;
  coupon_status: string;
  discount_status: string;
  starts_at: number | null;
  ends_at: number | null;
}

export interface AppliedDiscount extends QuoteDiscount {
  /** 各行への按分額(行の並び順) */
  allocation: number[];
  /** 確定時の SQL ガードに使う、見積もり時点の設定 */
  rule: { method: "PERCENT" | "FIXED"; value: number; max: number | null; min: number | null };
  couponCode?: string;
  totalLimit?: number | null;
  perWalletLimit?: number | null;
}

export interface DiscountResult {
  discounts: AppliedDiscount[];
  /** 行ごとの割引合計 */
  perLine: number[];
  couponError: string | null;
}

/**
 * 割引額。定率は切り捨て(仮定 A14 と同じ)。最大割引額と対象額で頭打ちにする。
 */
export function discountAmount(rule: { method: "PERCENT" | "FIXED"; value: number; max: number | null }, eligible: number): number {
  if (eligible <= 0) return 0;
  let a = rule.method === "PERCENT" ? Math.floor((eligible * rule.value) / 100) : rule.value;
  if (rule.max !== null) a = Math.min(a, rule.max);
  return Math.max(0, Math.min(a, eligible));
}

/** 割引額を、残りの対象額に比例して各行へ按分する。端数は残りの大きい行から1ずつ配る */
export function allocate(amount: number, remaining: number[]): number[] {
  const sum = remaining.reduce((s, n) => s + n, 0);
  if (amount <= 0 || sum <= 0) return remaining.map(() => 0);
  const out = remaining.map((r) => Math.floor((amount * r) / sum));
  let left = amount - out.reduce((s, n) => s + n, 0);
  const order = remaining.map((_r, i) => i).sort((a, b) => remaining[b] - remaining[a] || a - b);
  for (let k = 0; left > 0 && k < order.length * 2; k++) {
    const i = order[k % order.length];
    if (out[i] < remaining[i]) {
      out[i]++;
      left--;
    }
  }
  return out;
}

const RULE_COLS = `d.id, d.name, d.method, d.value, d.min_order_amount, d.max_discount_amount, d.combinable_with_coupon`;
const inTarget = (shopId: string) =>
  `(NOT EXISTS (SELECT 1 FROM discount_targets t WHERE t.discount_id = d.id AND t.target_type = 'SHOP')
     OR EXISTS (SELECT 1 FROM discount_targets t WHERE t.discount_id = d.id AND t.target_type = 'SHOP' AND t.target_id = '${shopId.replace(/'/g, "")}'))`;

export const normalizeCode = (s: string): string => s.normalize("NFKC").trim().replace(/\s+/g, "").toUpperCase();

/**
 * 割引を計算する(全ユーザー割引 → クーポンの順。仕様 v0.2 §14.7)。
 * - 全ユーザー割引は、条件を満たすものすべてを順に自動適用する。
 * - クーポンは1注文に1つ。入力が使えないときは割引なしで couponError に理由を入れる(カートの会計は続けられる)。
 * - 割引後の金額は0未満にならない(各行の残り対象額が上限)。
 */
export async function computeDiscounts(
  db: D1Database,
  shopId: string,
  lines: DiscountLineInput[],
  subtotal: number,
  now: number,
  couponCode: string | null,
  walletId: string | null,
): Promise<DiscountResult> {
  const remaining = lines.map((l) => l.base);
  const perLine = lines.map(() => 0);
  const applied: AppliedDiscount[] = [];

  const apply = (
    kind: QuoteDiscount["kind"],
    r: RuleRow,
    extra: { couponId?: string; code?: string; totalLimit?: number | null; perWalletLimit?: number | null },
  ): { ok: true } | { ok: false; reason: string } => {
    if (r.min_order_amount !== null && subtotal < r.min_order_amount) {
      return { ok: false, reason: `${r.min_order_amount} 以上のお買い上げで使えます` };
    }
    const eligible = remaining.reduce((s, n) => s + n, 0);
    const rule = { method: r.method, value: r.value, max: r.max_discount_amount, min: r.min_order_amount };
    const amount = discountAmount(rule, eligible);
    if (amount <= 0) return { ok: false, reason: "割引の対象になる商品がありません" };
    const alloc = allocate(amount, remaining);
    alloc.forEach((a, i) => {
      remaining[i] -= a;
      perLine[i] += a;
    });
    applied.push({
      kind,
      discountId: r.id,
      couponId: extra.couponId ?? null,
      name: r.name,
      amount,
      allocation: alloc,
      rule,
      couponCode: extra.code,
      totalLimit: extra.totalLimit,
      perWalletLimit: extra.perWalletLimit,
    });
    return { ok: true };
  };

  // ① 全ユーザー対象割引
  const autos = await db
    .prepare(
      `SELECT ${RULE_COLS} FROM discounts d
        WHERE d.kind = 'AUTO' AND d.status = 'ACTIVE'
          AND (d.starts_at IS NULL OR d.starts_at <= ?) AND (d.ends_at IS NULL OR d.ends_at > ?)
          AND ${inTarget(shopId)}
        ORDER BY d.created_at, d.id`,
    )
    .bind(now, now)
    .all<RuleRow>();
  let autoBlocksCoupon = false;
  for (const r of autos.results) {
    if (apply("AUTO", r, {}).ok && r.combinable_with_coupon === 0) autoBlocksCoupon = true;
  }

  // ② クーポン
  let couponError: string | null = null;
  const code = couponCode ? normalizeCode(couponCode) : "";
  if (code) {
    const c = await db
      .prepare(
        `SELECT ${RULE_COLS}, c.id AS coupon_id, c.code, c.kind, c.total_limit, c.per_wallet_limit, c.used_count, c.status AS coupon_status,
                d.status AS discount_status, d.starts_at, d.ends_at
           FROM coupons c JOIN discounts d ON d.id = c.discount_id
          WHERE c.code = ?`,
      )
      .bind(code)
      .first<CouponRow>();
    if (!c) couponError = "このクーポンコードは見つかりません";
    else if (c.coupon_status !== "ACTIVE" || c.discount_status !== "ACTIVE") couponError = "このクーポンは使えなくなっています";
    else if (c.starts_at !== null && c.starts_at > now) couponError = "このクーポンはまだ使えません(開始前です)";
    else if (c.ends_at !== null && c.ends_at <= now) couponError = "このクーポンは有効期限が切れています";
    else if (c.total_limit !== null && c.used_count >= c.total_limit) couponError = c.kind === "ONE_TIME" ? "このクーポンはすでに使われています" : "このクーポンは利用上限に達しました";
    else {
      const shopOk = await db
        .prepare(`SELECT 1 AS ok FROM discounts d WHERE d.id = ? AND ${inTarget(shopId)}`)
        .bind(c.id)
        .first();
      if (!shopOk) couponError = "このクーポンはこのお店では使えません";
      else if (autoBlocksCoupon || (c.combinable_with_coupon === 0 && applied.length > 0)) {
        couponError = "このクーポンは、いま適用中の割引と併用できません";
      } else {
        if (walletId && c.per_wallet_limit !== null) {
          const n = await db
            .prepare("SELECT COUNT(*) AS n FROM coupon_redemptions WHERE coupon_id = ? AND wallet_id = ? AND status = 'USED'")
            .bind(c.coupon_id, walletId)
            .first<{ n: number }>();
          if ((n?.n ?? 0) >= c.per_wallet_limit) couponError = "このクーポンは、お客様の利用回数の上限に達しています";
        }
        if (!couponError) {
          const r = apply(c.kind === "COMMON" ? "COMMON_COUPON" : "ONE_TIME_COUPON", c, {
            couponId: c.coupon_id,
            code: c.code,
            totalLimit: c.total_limit,
            perWalletLimit: c.per_wallet_limit,
          });
          if (!r.ok) couponError = r.reason;
        }
      }
    }
  }
  return { discounts: applied, perLine, couponError };
}
