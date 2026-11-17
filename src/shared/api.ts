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
  receptionQrIssuedAt: number | null;
}

/** 受付ログインQRの発行結果。生トークンはこのレスポンスでしか返さない */
export interface ReceptionQrIssued {
  userId: string;
  token: string;
}
