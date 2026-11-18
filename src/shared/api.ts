import type { Role, ShopStatus, UserStatus } from "./roles";

export interface ApiErrorBody {
  error: { code: string; message: string };
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
    };
