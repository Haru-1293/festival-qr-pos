import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** API エラー。code は画面側の分岐用、message は人が読む文言 */
export class ApiError extends HTTPException {
  readonly code: string;
  /** 画面が使う追加情報(例: 価格が変わったときの新しい見積もり) */
  readonly details?: unknown;
  constructor(status: ContentfulStatusCode, code: string, message: string, details?: unknown) {
    super(status, { message });
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, code = "BAD_REQUEST") => new ApiError(400, code, message);
export const unauthorized = (message = "ログインが必要です", code = "UNAUTHORIZED") =>
  new ApiError(401, code, message);
export const forbidden = (message = "この操作を行う権限がありません", code = "FORBIDDEN") =>
  new ApiError(403, code, message);
export const notFound = (message = "対象が見つかりません", code = "NOT_FOUND") => new ApiError(404, code, message);
export const conflict = (message: string, code = "CONFLICT", details?: unknown) => new ApiError(409, code, message, details);
