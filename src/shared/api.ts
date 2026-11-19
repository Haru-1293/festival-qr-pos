import type { Role, ShopStatus, UserStatus } from "./roles";

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export interface SessionUser {
  id: string;
  role: Role;
  nickname: string;
  loginId: string | null;
  shopId: string | null;
  shopName: string | null;
}

export interface WalletSummary {
  id: string;
  balance: number;
  status: "ACTIVE" | "SUSPENDED" | "CLOSED";
  expiresAt: number | null;
}

export interface MeResponse {
  user: SessionUser;
  wallet: WalletSummary | null;
}

export interface ShopDto {
  id: string;
  name: string;
  displayName: string;
  status: ShopStatus;
  sortOrder: number;
}

export interface UserDto {
  id: string;
  role: Role;
  loginId: string | null;
  nickname: string;
  shopId: string | null;
  shopName: string | null;
  status: UserStatus;
  createdAt: number;
  /** 受付担当者のみ: 有効なログインQRの発行日時(無ければ null) */
  loginQrIssuedAt: number | null;
}

/** 受付ログインQRの発行結果。生トークンはこのレスポンスでしか返さない */
export interface ReceptionQrIssued {
  userId: string;
  token: string;
}

// ---------- 顧客のQR / 受付 ----------

export interface WalletQrResponse {
  token: string;
  expiresAt: number;
  ttlSeconds: number;
}

export interface LookupResponse {
  lookupId: string;
  expiresAt: number;
  wallet: { id: string; nickname: string | null; balance: number; status: "ACTIVE" | "SUSPENDED" | "CLOSED" };
  yenPerUnit: number;
}

/** チャージ・払戻し・訂正の結果。replayed=true は同じリクエストの再送で、元の結果をそのまま返したもの */
export interface CashOpResult {
  ledgerId: string;
  txNo: string;
  balanceAfter: number;
  /** ポイントの変動量(絶対値) */
  units: number;
  /** 現金の受け渡し額(円) */
  cashAmount: number;
  replayed: boolean;
}

export type CashEventKind = "CHARGE" | "PAYOUT" | "DROP" | "CORRECTION";

/** 現金の集計(単位は円)。expected = charge - payout - drop + correction */
export interface CashTotals {
  charge: number;
  payout: number;
  drop: number;
  correction: number;
  expected: number;
  eventCount: number;
}

export interface CashEventDto {
  id: string;
  kind: CashEventKind;
  /** 円。CORRECTION のみ符号付き */
  amount: number;
  reason: string | null;
  createdAt: number;
  closed: boolean;
  ledgerId: string | null;
  customerNickname: string | null;
  receptionNickname: string | null;
  /** CHARGE のとき: 訂正を反映した後の受領額(円) */
  effectiveCash: number | null;
}

export type ClosingMode = "DAY" | "SHIFT" | "MANUAL";

export interface ReceptionSummary {
  totals: CashTotals;
  recent: CashEventDto[];
  closingMode: ClosingMode;
  canCloseSelf: boolean;
  yenPerUnit: number;
}

export interface AdminCashSummary {
  total: CashTotals;
  users: { userId: string; nickname: string; totals: CashTotals }[];
  closingMode: ClosingMode;
}

export interface ClosingDto {
  id: string;
  scopeKind: "DAY" | "SHIFT" | "MANUAL";
  scopeUserNickname: string | null;
  periodStart: number;
  periodEnd: number;
  expectedAmount: number;
  countedAmount: number | null;
  difference: number | null;
  note: string | null;
  closedByNickname: string | null;
  closedAt: number;
}

export interface OperationSettings {
  closingMode: ClosingMode;
  qrTtlSeconds: number;
  /** 決済セッション(QR読み取りから確定までの猶予)の秒数。既定300秒(5分) */
  paymentSessionSeconds: number;
}

// ---------- 商品・値下げ(店舗) ----------
import type { PriceCutMethod } from "./pricing";

export type SaleMode = "BOTH" | "SINGLE_ONLY" | "SET_ONLY";
export type ProductStatus = "ACTIVE" | "STOPPED" | "ARCHIVED";

export interface TagDto {
  id: string;
  name: string;
  color: string | null;
  active: boolean;
}

export interface ProductDto {
  id: string;
  name: string;
  /** 定価。セット限定の非売品は null */
  price: number | null;
  /** 値下げ後の価格(値下げがなければ定価と同じ)。定価が null なら null */
  salePrice: number | null;
  cutAmount: number;
  description: string | null;
  saleMode: SaleMode;
  status: ProductStatus;
  manualSoldOut: boolean;
  trackStock: boolean;
  stockQty: number | null;
  soldOut: boolean;
  soldOutReason: "MANUAL" | "STOCK" | null;
  discountable: boolean;
  sortOrder: number;
  tags: { id: string; name: string; color: string | null }[];
}

export type PriceCutState = "RUNNING" | "SCHEDULED" | "ENDED" | "STOPPED";

export interface PriceCutDto {
  id: string;
  name: string;
  method: PriceCutMethod;
  value: number;
  startsAt: number | null;
  endsAt: number | null;
  state: PriceCutState;
  createdAt: number;
}

export type CatalogResponse =
  | { changed: false; signature: string; serverTime: number }
  | {
      changed: true;
      signature: string;
      serverTime: number;
      shopName: string;
      /** いま適用中の値下げ。なければ null */
      cut: PriceCutDto | null;
      products: ProductDto[];
      /** 販売中のセット(選択肢つき) */
      sets: SetDto[];
    };

// ---------- セット商品 ----------
export type SetUnavailableReason = "STOPPED" | "MANUAL" | "NO_OPTIONS";

export interface SetItemDto {
  productId: string;
  name: string;
  /** この選択肢を選んだときの追加料金(1セットあたり) */
  surcharge: number;
  /** 選べない(売り切れ・販売停止など)。画面では無効な選択肢として表示する */
  disabled: boolean;
  disabledReason: "SOLD_OUT" | "STOCK" | "UNAVAILABLE" | null;
  stockQty: number | null;
}

export interface SetSegmentDto {
  id: string;
  name: string;
  required: boolean;
  pickCount: number;
  allowDuplicate: boolean;
  sortOrder: number;
  items: SetItemDto[];
}

export interface SetDto {
  id: string;
  name: string;
  /** セット定価(追加料金を含まない) */
  price: number;
  /** 値下げ後のセット価格(追加料金を含まない) */
  salePrice: number;
  cutAmount: number;
  description: string | null;
  status: ProductStatus;
  manualSoldOut: boolean;
  discountable: boolean;
  sortOrder: number;
  segments: SetSegmentDto[];
  /** いまこのセットを売れる(必須の内訳をすべて満たせる) */
  available: boolean;
  unavailableReason: SetUnavailableReason | null;
}

/** 店舗責任者がセットを登録・更新するときの内容 */
export interface SetInput {
  name: string;
  price: number;
  description?: string | null;
  discountable: boolean;
  sortOrder: number;
  segments: {
    name: string;
    required: boolean;
    pickCount: number;
    allowDuplicate: boolean;
    items: { productId: string; surcharge: number }[];
  }[];
}

// ---------- 決済(店舗のレジ) ----------
/** 単品は productId、セットは setId と picks(内訳セグメントID → 選んだ商品ID。複数選択は並べる) */
export interface CartItemInput {
  productId?: string;
  setId?: string;
  picks?: Record<string, string[]>;
  quantity: number;
}

export interface QuoteComponent {
  segmentName: string;
  productId: string;
  name: string;
  /** 1セットあたりの追加料金 */
  surcharge: number;
}

export interface QuoteLine {
  kind: "PRODUCT" | "SET";
  /** 単品なら商品ID、セットならセットID */
  productId: string;
  /** セットのとき: 内訳(選んだ商品) */
  components?: QuoteComponent[];
  /** セットのとき: 追加料金の合計(数量ぶん) */
  surchargeTotal: number;
  name: string;
  quantity: number;
  /** 値下げ前の定価(1点) */
  listUnitPrice: number;
  /** 値下げ後の単価(1点) */
  unitPrice: number;
  lineTotal: number;
}

export type QuoteProblemCode = "INVALID_PICKS" | "NOT_FOUND" | "UNAVAILABLE" | "SOLD_OUT" | "INSUFFICIENT_STOCK" | "NO_PRICE";

export interface QuoteProblem {
  productId: string;
  name: string | null;
  code: QuoteProblemCode;
  message: string;
  /** 在庫不足のとき、いま用意できる数 */
  available?: number;
}

export interface Quote {
  lines: QuoteLine[];
  total: number;
  cut: { id: string; name: string } | null;
  problems: QuoteProblem[];
  signature: string;
}

export interface PaySession {
  sessionId: string;
  expiresAt: number;
  customer: { nickname: string | null; balance: number };
  quote: Quote;
  /** 残高が足りないとき、不足額。足りているなら 0 */
  shortfall: number;
}

export interface PayResult {
  orderId: string;
  orderNo: string;
  total: number;
  balanceAfter: number;
  paidAt: number;
  lines: QuoteLine[];
  replayed?: boolean;
}

export type PaySessionStatus = "OPEN" | "COMMITTED" | "CANCELLED" | "EXPIRED";

export interface PayStatus {
  status: PaySessionStatus;
  expiresAt: number;
  result: PayResult | null;
}

// ---------- 返金・履歴 ----------
export type OrderStatus = "PAID" | "PARTIALLY_REFUNDED" | "REFUNDED";
export type RefundKind = "FULL" | "PARTIAL" | "ARBITRARY";

export interface OrderSummary {
  id: string;
  orderNo: string;
  paidAt: number;
  customerNickname: string | null;
  total: number;
  refundedTotal: number;
  status: OrderStatus;
}

export interface OrderLineDto {
  id: string;
  kind: "PRODUCT" | "SET";
  productId: string | null;
  /** セットのとき: 1セットあたりの内訳 */
  components?: { segmentName: string; name: string; quantity: number; surcharge: number }[];
  name: string;
  quantity: number;
  unitPrice: number;
  listUnitPrice: number | null;
  priceCutName: string | null;
  linePaid: number;
  refundedQuantity: number;
  refundedAmount: number;
}

export interface RefundDto {
  id: string;
  kind: RefundKind;
  amount: number;
  reason: string;
  operatorNickname: string | null;
  createdAt: number;
  lines: { name: string; quantity: number; amount: number; restoreStock: boolean }[];
}

export interface OrderDetail extends OrderSummary {
  shopId: string;
  shopName: string;
  clerkNickname: string | null;
  /** 返金できる残りの金額(実支払額 − 返金済みの合計) */
  refundable: number;
  lines: OrderLineDto[];
  refunds: RefundDto[];
}

export interface RefundResult {
  refundId: string;
  kind: RefundKind;
  amount: number;
  refundedTotal: number;
  refundable: number;
  balanceAfter: number;
  status: OrderStatus;
  replayed?: boolean;
}

export interface HistoryItem {
  id: string;
  kind: "CHARGE" | "CHARGE_CORRECTION" | "PAYMENT" | "REFUND" | "PAYOUT" | "ADJUSTMENT";
  amount: number;
  balanceAfter: number;
  createdAt: number;
  /** 決済・返金のときの店舗名 */
  shopName: string | null;
  /** 決済・返金のときの取引番号 */
  orderNo: string | null;
}
