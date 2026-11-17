import type { ApiErrorBody } from "@shared/api";

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

interface Options {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  headers?: Record<string, string>;
}

/** /api への薄いラッパー。エラーはサーバーの統一形式を ApiRequestError にして投げる */
export async function api<T>(path: string, opts: Options = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
      credentials: "same-origin",
      headers: {
        ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
        ...opts.headers,
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch {
    throw new ApiRequestError(0, "NETWORK", "通信できませんでした。電波の状態を確認してください");
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const e = (json as ApiErrorBody | null)?.error;
    throw new ApiRequestError(res.status, e?.code ?? "HTTP_ERROR", e?.message ?? `エラーが発生しました (${res.status})`);
  }
  return json as T;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : "エラーが発生しました";
}
