import { fromBase64Url, toBase64Url } from "./crypto";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** 暗号化に使う秘密値(PIN_PEPPER)。短すぎる・未設定のときは null(その場合、QRは再表示できない) */
export function vaultSecret(env: { PIN_PEPPER?: string }): string | null {
  return env.PIN_PEPPER && env.PIN_PEPPER.length >= 16 ? env.PIN_PEPPER : null;
}

async function key(secret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(`qr-vault:v1:${secret}`));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** 文字列を暗号化して `iv.暗号文` のBase64URLにする。秘密値がなければ null */
export async function sealText(secret: string | null, text: string): Promise<string | null> {
  if (!secret) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(secret), enc.encode(text)));
  return `${toBase64Url(iv)}.${toBase64Url(ct)}`;
}

/** 復号。秘密値が変わった・壊れているときは null */
export async function openText(secret: string | null, sealed: string | null): Promise<string | null> {
  if (!secret || !sealed) return null;
  const [iv, ct] = sealed.split(".");
  if (!iv || !ct) return null;
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(iv) }, await key(secret), fromBase64Url(ct));
    return dec.decode(pt);
  } catch {
    return null;
  }
}
