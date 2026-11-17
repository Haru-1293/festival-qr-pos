import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function yen(n: number): string {
  return `¥${n.toLocaleString("ja-JP")}`;
}

export function signedYen(n: number): string {
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${yen(Math.abs(n))}`;
}

/** 二重送信防止用のリクエストID(同じ操作の再送には同じIDを使う) */
export function newRequestId(): string {
  const c = globalThis.crypto;
  // randomUUID は https / localhost でのみ使える。使えない環境では乱数から同じ長さのIDを作る
  if (typeof c.randomUUID === "function") return c.randomUUID().replace(/-/g, "");
  return Array.from(c.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}
