import type { CardDto, CardStatus, IssuedCard } from "@shared/api";
import { randomToken, sha256Hex } from "./crypto";
import { CARD_QR_PREFIX } from "./qr";

/** 6か月特例の上限(日)。カード・ウォレットの有効期限はこの範囲に収める */
export const MAX_CARD_VALID_DAYS = 184;
export const DEFAULT_CARD_VALID_DAYS = 180;
const DAY = 24 * 60 * 60 * 1000;

export const defaultCardExpiry = (now: number) => now + DEFAULT_CARD_VALID_DAYS * DAY;
export const maxCardExpiry = (now: number) => now + MAX_CARD_VALID_DAYS * DAY;

/** 使えるカード(有効・期限内)かどうかの SQL 条件。引数: 現在時刻 */
export const cardUsableSql = (a = "c") => `${a}.status = 'ACTIVE' AND (${a}.expires_at IS NULL OR ${a}.expires_at > ?)`;

export async function newCardToken(): Promise<{ token: string; hash: string }> {
  const token = `${CARD_QR_PREFIX}${randomToken(24)}`;
  return { token, hash: await sha256Hex(token) };
}

export interface CardRow {
  id: string;
  display_no: string;
  status: Exclude<CardStatus, "EXPIRED">;
  nickname: string | null;
  wallet_id: string | null;
  balance: number | null;
  wallet_status: "ACTIVE" | "SUSPENDED" | "CLOSED" | null;
  expires_at: number | null;
  issue_batch: string | null;
  memo: string | null;
  issued_at: number;
  activated_at: number | null;
  suspended_at: number | null;
  suspend_reason: string | null;
  deleted_at: number | null;
  delete_reason: string | null;
  last_used_at: number | null;
  reissued_from_card_id: string | null;
}

export const CARD_SELECT = `SELECT c.id, c.display_no, c.status, c.nickname, c.wallet_id, w.balance, w.status AS wallet_status, c.expires_at, c.issue_batch, c.memo,
       c.issued_at, c.activated_at, c.suspended_at, c.suspend_reason, c.deleted_at, c.delete_reason, c.reissued_from_card_id,
       (SELECT MAX(o.paid_at) FROM orders o WHERE o.card_id = c.id) AS last_used_at
  FROM cards c LEFT JOIN wallets w ON w.id = c.wallet_id`;

export function toCardDto(r: CardRow, now: number): CardDto {
  const expired = (r.status === "ACTIVE" || r.status === "SUSPENDED" || r.status === "ISSUED") && r.expires_at !== null && r.expires_at <= now;
  return {
    id: r.id,
    displayNo: r.display_no,
    status: expired ? "EXPIRED" : r.status,
    nickname: r.nickname,
    balance: r.balance,
    walletStatus: r.wallet_status,
    expiresAt: r.expires_at,
    issueBatch: r.issue_batch,
    memo: r.memo,
    issuedAt: r.issued_at,
    activatedAt: r.activated_at,
    suspendedAt: r.suspended_at,
    suspendReason: r.suspend_reason,
    deletedAt: r.deleted_at,
    deleteReason: r.delete_reason,
    lastUsedAt: r.last_used_at,
    reissuedFrom: r.reissued_from_card_id,
  };
}

export type { IssuedCard };
