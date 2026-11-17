/** WebCrypto だけで完結するハッシュ・乱数ユーティリティ(Workers 実行環境向け) */

const enc = new TextEncoder();

// Workers の PBKDF2 は反復回数 100,000 が上限
export const PBKDF2_ITERATIONS = 100_000;

export function toBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 暗号学的乱数をBase64URLで返す(既定192ビット) */
export function randomToken(bytes = 24): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** タイミング攻撃を避ける固定時間比較 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  return timingSafeEqual(enc.encode(a), enc.encode(b));
}

async function pbkdf2(secret: Uint8Array | string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    typeof secret === "string" ? enc.encode(secret) : secret,
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    keyMaterial,
    256,
  );
  return new Uint8Array(bits);
}

/** 形式: pbkdf2$<iterations>$<salt>$<hash> */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const parts = (stored ?? "").split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") {
    // ユーザー不在でも同程度の時間を使い、存在有無をタイミングで推測されにくくする
    await pbkdf2(password, new Uint8Array(16), PBKDF2_ITERATIONS);
    return false;
  }
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > PBKDF2_ITERATIONS) return false;
  const actual = await pbkdf2(password, fromBase64Url(parts[2]), iterations);
  return timingSafeEqual(actual, fromBase64Url(parts[3]));
}

/**
 * 4桁PINのハッシュ。4桁は総当たりが容易なので、サーバー秘密値(pepper)を HMAC で混ぜる。
 * DB だけが漏れてもPINは復元できない。
 */
export async function hashPin(pin: string, pepper: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(pin)));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(mac, salt, PBKDF2_ITERATIONS);
  return `pin1$${PBKDF2_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

export async function verifyPin(pin: string, stored: string | null, pepper: string): Promise<boolean> {
  const parts = (stored ?? "").split("$");
  if (parts.length !== 4 || parts[0] !== "pin1") return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(pin)));
  const actual = await pbkdf2(mac, fromBase64Url(parts[2]), Number(parts[1]));
  return timingSafeEqual(actual, fromBase64Url(parts[3]));
}
