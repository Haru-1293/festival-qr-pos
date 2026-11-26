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

export interface ShopNameHistoryItem {
  displayName: string;
  /** この名前になった時刻(最初の名前は 0) */
  validFrom: number;
  changedBy: string | null;
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
  wallet: { id: string; nickname: string | null; balance: number; status: "ACTIVE" | "SUSPENDED" | "CLOSED"; /** 有効期限が切れている(チャージ・支払いはできない。払戻しだけできる) */ expired: boolean };
  /** 物理カードを読み取ったとき。払戻しにはPINが必要 */
  card?: { displayNo: string };
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

/** カード・ウォレットの有効期限ポリシー(管理者が設定)。DAYS=発行から日数、DATE=固定日(日本時間の23:59:59まで) */
export interface ExpiryPolicy {
  mode: "DAYS" | "DATE";
  /** mode=DAYS のときの日数(1〜184) */
  days: number;
  /** mode=DATE のときの日付 YYYY-MM-DD */
  date: string | null;
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
  /** 原価(任意)。店舗責任者・全体管理者向けの一覧にだけ入る。未入力は null */
  cost?: number | null;
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
      /** 注文ステータス(呼び出し)の設定。tagMode のとき、レジで番号札の番号を入力する */
      fulfillment: { tracking: boolean; tagMode: boolean };
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

/** 見積もり・注文に適用された割引(計算順に並ぶ: 全ユーザー割引 → クーポン) */
export interface QuoteDiscount {
  kind: "AUTO" | "COMMON_COUPON" | "ONE_TIME_COUPON";
  discountId: string;
  couponId: string | null;
  name: string;
  amount: number;
}

export interface Quote {
  lines: QuoteLine[];
  /** 割引前の小計 */
  subtotal: number;
  discounts: QuoteDiscount[];
  discountTotal: number;
  /** 入力されたクーポンが使えない理由(使えるなら null)。使えなくてもカートの会計は続けられる */
  couponError: string | null;
  /** 割引後の支払い額 */
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
  /** 物理カードでの支払い。確定にはPIN(4桁)が必要 */
  card?: { displayNo: string };
}

export interface PayResult {
  orderId: string;
  orderNo: string;
  total: number;
  balanceAfter: number;
  paidAt: number;
  /** 呼び出し番号(店舗が注文ステータスのオプションを使っているときだけ) */
  callNo: string | null;
  lines: QuoteLine[];
  subtotal: number;
  discounts: QuoteDiscount[];
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
  /** 商品の要約(一覧の検索結果用) */
  items?: string | null;
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
  couponRestored: boolean;
  /** 店員の「注文取消し」による全額返金 */
  cancel: boolean;
  lines: { name: string; quantity: number; amount: number; restoreStock: boolean; percent: number | null }[];
}

export interface OrderDetail extends OrderSummary {
  shopId: string;
  shopName: string;
  clerkNickname: string | null;
  /** 返金できる残りの金額(実支払額 − 返金済みの合計) */
  refundable: number;
  subtotal: number;
  /** 適用された割引(計算順) */
  discounts: QuoteDiscount[];
  /** 使ったクーポンがまだ「使用済み」のままか(全額取消で戻せる) */
  couponUsed: boolean;
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

// ---------- 物理カード ----------
export type CardStatus = "ISSUED" | "ACTIVE" | "SUSPENDED" | "EXPIRED" | "DELETED";

export interface CardDto {
  id: string;
  displayNo: string;
  /** 期限切れは表示上 EXPIRED にする(保存されている状態は ACTIVE のまま) */
  status: CardStatus;
  nickname: string | null;
  balance: number | null;
  walletStatus: "ACTIVE" | "SUSPENDED" | "CLOSED" | null;
  expiresAt: number | null;
  issueBatch: string | null;
  memo: string | null;
  issuedAt: number;
  activatedAt: number | null;
  suspendedAt: number | null;
  suspendReason: string | null;
  deletedAt: number | null;
  deleteReason: string | null;
  lastUsedAt: number | null;
  reissuedFrom: string | null;
}

/** 発行・再生成の直後だけ返す、印刷用のQR内容(サーバーにはハッシュしか残らない) */
export interface IssuedCard {
  id: string;
  displayNo: string;
  token: string;
  expiresAt: number;
}

// ---------- 割引・クーポン(全体管理者) ----------
export type DiscountMethod = "PERCENT" | "FIXED";
export type DiscountStatus = "ACTIVE" | "STOPPED" | "ENDED";

/** 割引の対象を絞る指定(商品・タグ・セット)。指定が無ければ、割引対象の全商品 */
export interface ItemTarget {
  type: "PRODUCT" | "TAG" | "SET";
  id: string;
}
export interface ItemTargetDto extends ItemTarget {
  name: string;
}

/** 割引の発動条件: この商品(タグ・セット)を minQty 個以上買ったとき */
export interface DiscountCondition extends ItemTarget {
  minQty: number;
}
export interface DiscountConditionDto extends DiscountCondition {
  name: string;
}
/** 割引をかける範囲。DEFAULT=対象を指定していればその商品、なければ全体 / ORDER=会計全体 / CONDITION=条件にあたった商品だけ */
export type ApplyScope = "DEFAULT" | "ORDER" | "CONDITION";
/** 条件が複数あるとき、すべて満たす(ALL)か、どれか1つ(ANY)か */
export type ConditionMode = "ALL" | "ANY";

export interface DiscountRuleInput {
  name: string;
  method: DiscountMethod;
  value: number;
  minOrderAmount: number | null;
  maxDiscountAmount: number | null;
  startsAt: number | null;
  endsAt: number | null;
  /** 空なら全店舗 */
  shopIds: string[];
  /** 商品・タグ・セットで対象を絞る(空なら絞らない) */
  items?: ItemTarget[];
  /** 発動条件(商品の個数)。会計金額の条件は minOrderAmount。空なら、金額の条件だけ */
  conditions?: DiscountCondition[];
  conditionMode?: ConditionMode;
  applyScope?: ApplyScope;
}

export interface AutoDiscountInput extends DiscountRuleInput {
  /** false のとき、クーポンとは併用できない(クーポン入力があると断る) */
  combinableWithCoupon: boolean;
}

export interface CouponInput extends DiscountRuleInput {
  kind: "COMMON" | "ONE_TIME";
  /** 空のとき ONE_TIME は自動で作る。COMMON は必須 */
  code?: string;
  /** ONE_TIME のときこの枚数ぶん、コードを自動で作る(code が空のとき) */
  count?: number;
  totalLimit: number | null;
  perWalletLimit: number | null;
  /** 先着N人(totalLimit が人数、1人1回)。共通コードのみ */
  firstCome?: boolean;
  /** 全ユーザー割引と併用できるか */
  combinableWithAuto: boolean;
  note: string | null;
}

export interface AutoDiscountDto {
  id: string;
  name: string;
  method: DiscountMethod;
  value: number;
  minOrderAmount: number | null;
  maxDiscountAmount: number | null;
  startsAt: number | null;
  endsAt: number | null;
  combinableWithCoupon: boolean;
  status: DiscountStatus;
  shopIds: string[];
  items: ItemTargetDto[];
  conditions: DiscountConditionDto[];
  conditionMode: ConditionMode;
  applyScope: ApplyScope;
  /** 今の時刻で適用される状態か */
  state: "RUNNING" | "SCHEDULED" | "ENDED" | "STOPPED";
  usedCount: number;
  usedAmount: number;
}

export interface CouponDto {
  id: string;
  code: string;
  kind: "COMMON" | "ONE_TIME";
  /** 先着N人のクーポンか(totalLimit が人数) */
  firstCome: boolean;
  name: string;
  method: DiscountMethod;
  value: number;
  minOrderAmount: number | null;
  maxDiscountAmount: number | null;
  startsAt: number | null;
  endsAt: number | null;
  combinableWithAuto: boolean;
  totalLimit: number | null;
  perWalletLimit: number | null;
  usedCount: number;
  status: DiscountStatus;
  state: "RUNNING" | "SCHEDULED" | "ENDED" | "STOPPED" | "USED_UP";
  shopIds: string[];
  items: ItemTargetDto[];
  conditions: DiscountConditionDto[];
  conditionMode: ConditionMode;
  applyScope: ApplyScope;
  note: string | null;
  createdAt: number;
}

// ---------- 売上・精算・監査ログ・緊急停止 ----------
export interface SalesRow {
  shopId: string;
  name: string;
  orders: number;
  subtotal: number;
  discountTotal: number;
  paidTotal: number;
  refundedTotal: number;
  /** 精算対象額 = 支払額 - 返金額 */
  netSales: number;
  /** 粗利(原価が入力された商品だけ)。原価の入力が1つもなければ null */
  gross?: GrossProfit | null;
}
/**
 * 粗利。原価が入力されている商品の行だけで計算する(未入力の商品は含めない)。
 *  売上 = 支払額 - 返金額 / 原価 = 売れた数の原価(在庫へ戻した分と注文取消しの分は引く) / 粗利 = 売上 - 原価
 */
export interface GrossProfit {
  /** 原価が入力されている商品の売上(返金を引いたあと) */
  sales: number;
  cost: number;
  profit: number;
  /** 粗利率(%)。売上が0なら null */
  margin: number | null;
  /** 純売上のうち原価が入力されている商品の割合(%)。低いと粗利は参考値 */
  coverage: number | null;
}
export interface SalesReport {
  from: number;
  to: number;
  shops: SalesRow[];
  totals: Omit<SalesRow, "shopId" | "name">;
  discounts: { kind: "AUTO" | "COMMON_COUPON" | "ONE_TIME_COUPON"; name: string; count: number; amount: number }[];
}
/** 店舗別の売上サマリ(期間内) */
export interface ShopSalesSummary {
  from: number;
  to: number;
  shop: SalesRow & { status: ShopStatus };
  discounts: SalesReport["discounts"];
  /** カード/スマホQRそれぞれの件数と支払額 */
  bySource: { source: "CARD" | "PHONE"; orders: number; paid: number }[];
}
/** 店舗の取引履歴の1行 */
export interface ShopOrderRow {
  id: string;
  orderNo: string;
  paidAt: number;
  source: "CARD" | "PHONE";
  subtotal: number;
  discountTotal: number;
  totalPaid: number;
  refundedTotal: number;
  status: string;
  items: string | null;
  clerkNickname: string | null;
}
export interface ProductSalesRow {
  name: string;
  kind: "PRODUCT" | "SET";
  quantity: number;
  gross: number;
  discount: number;
  paid: number;
  /** 原価が入力されている分の売上(返金後)・原価。原価が未入力の商品は null */
  costSales?: number | null;
  cost?: number | null;
}
/** 監査ログの「種類」の絞り込み。prefixes は操作名の先頭一致(操作名は `refund.full` のように 分類.内容) */
export const AUDIT_CATEGORIES = [
  { key: "payment", label: "決済", prefixes: ["payment."] },
  { key: "refund", label: "返金・注文取消し", prefixes: ["refund.", "order.cancel"] },
  { key: "order", label: "注文の受け渡し状態", prefixes: ["order.preparing", "order.ready", "order.done"] },
  { key: "catalog", label: "商品・在庫・セット・値下げ", prefixes: ["product.", "stock.", "tag.", "set.", "price_cut."] },
  { key: "discount", label: "割引・クーポン", prefixes: ["discount.", "coupon."] },
  { key: "cash", label: "受付・現金・カード", prefixes: ["cash.", "wallet.", "card.", "reception_qr.", "clerk_qr."] },
  { key: "account", label: "ログイン・アカウント", prefixes: ["auth.", "account.", "user.", "setup."] },
  { key: "settings", label: "設定・店舗", prefixes: ["settings.", "shop.", "emergency."] },
] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number]["key"];

export interface AuditEntryDto {
  id: string;
  /** 操作者または対象の店舗(わかるもののみ) */
  shopName?: string | null;
  /** 店舗名が変更されていて、ログ当時の名前と今の名前が違うときの、今の名前 */
  currentShopName?: string | null;
  createdAt: number;
  actorNickname: string | null;
  actorRole: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  reason: string | null;
  before: string | null;
  after: string | null;
}
export interface EmergencyState {
  on: boolean;
  message: string;
}

// ---------- 注文ステータス・呼び出しボード ----------
export type FulfillmentStatus = "PREPARING" | "READY" | "DONE";

/** 呼び出しの方式。AUTO = 自動の番号 / TAG = レジで店員が番号札の番号を入力 */
export type CallMode = "AUTO" | "TAG";
export interface ShopOptions {
  orderTracking: boolean;
  callBoard: boolean;
  callMode: CallMode;
}

/** お客様の「受け取り待ち」の注文(スマホで呼び出し番号を見る用。受け渡しが済むまで) */
export interface ActiveOrderDto {
  orderId: string;
  orderNo: string;
  shopName: string;
  callNo: string;
  /** PREPARING = 調理中・調理待ち / READY = 呼び出し中(受け取りに来てください) */
  status: "PREPARING" | "READY";
  paidAt: number;
  items: string | null;
}

export interface TrackedOrderDto {
  orderId: string;
  callNo: string;
  status: FulfillmentStatus;
  createdAt: number;
  updatedAt: number;
  items: { name: string; quantity: number }[];
}

export interface CallBoardDto {
  shopName: string;
  preparing: string[];
  ready: string[];
  serverTime: number;
}

export interface PublicShopDto {
  id: string;
  name: string;
  callBoard: boolean;
}

export interface PublicMenuItem {
  name: string;
  price: number | null;
  description: string | null;
  soldOut: boolean;
  kind: "PRODUCT" | "SET";
}

export interface TimeSeriesPoint {
  /** 区切りの開始時刻(ミリ秒) */
  t: number;
  orders: number;
  netSales: number;
}

/** 全体の有効期限(全体管理者が設定)と、全データ削除ができる日 */
export interface GlobalExpiryInfo {
  date: string | null;
  expiresAt: number | null;
  /** 全データ削除ができる日時(期限が切れた1か月後の終わり) */
  resetAvailableAt: number | null;
  expired: boolean;
  canReset: boolean;
  now: number;
}

export type LegalKind = "TERMS" | "PRIVACY";
export const LEGAL_LABEL: Record<LegalKind, string> = { TERMS: "利用規約", PRIVACY: "プライバシーポリシー" };

export interface LegalDocumentDto {
  kind: LegalKind;
  version: number;
  bodyMd: string;
  createdAt: number;
}
export interface LegalVersionItem {
  version: number;
  createdAt: number;
  chars: number;
}

/** 残高照会の結果(店員・店舗責任者・全体管理者が、カードのQRから残高を確認する) */
export interface BalanceInquiry {
  displayNo: string;
  nickname: string | null;
  status: CardStatus;
  /** カードの状態に関わらず、ウォレットの残高(未有効のカードは0) */
  balance: number;
  expiresAt: number | null;
  expired: boolean;
  lastUsedAt: number | null;
}
