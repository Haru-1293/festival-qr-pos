import { z } from "zod";
import { newId } from "./ids";
import { badRequest, conflict } from "./errors";

/** メニュー画像1枚の上限(画面側で縮小してから送るので、通常は1MB未満) */
export const MENU_IMAGE_MAX_BYTES = 2_000_000;
export const MENU_IMAGE_KEY = /^[0-9A-Za-z]{26}\.(png|jpg|webp)$/;
export const menuImageKeySchema = z.string().regex(MENU_IMAGE_KEY, "画像の指定が正しくありません");
export const MENU_IMAGE_URL_PREFIX = "/api/public/menu-images/";

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
export const TYPE_BY_EXT: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };

type Env = { DB: D1Database; IMAGES?: R2Bucket };

export const menuImageUrl = (key: string | null | undefined) => (key ? `${MENU_IMAGE_URL_PREFIX}${key}` : null);

/** 先頭のバイト列が、宣言された画像の種類と合っているか */
export function matchesMagic(type: string, b: Uint8Array): boolean {
  if (type === "image/png") return b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  if (type === "image/jpeg") return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (type === "image/webp") return b.length > 12 && String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP";
  return false;
}

/** 画像を保存してキーを返す。R2があればR2、なければD1 */
export async function saveMenuImage(env: Env, type: string, bytes: Uint8Array): Promise<string> {
  const ext = EXT[type];
  if (!ext) throw badRequest("PNG・JPEG・WebPの画像を送ってください");
  if (bytes.length === 0) throw badRequest("画像が空です");
  if (bytes.length > MENU_IMAGE_MAX_BYTES) throw badRequest(`画像が大きすぎます(${MENU_IMAGE_MAX_BYTES / 1_000_000}MBまで)`, "IMAGE_TOO_LARGE");
  if (!matchesMagic(type, bytes)) throw badRequest("画像の中身が、選んだ種類(PNG・JPEG・WebP)と合っていません");
  const key = `${newId()}.${ext}`;
  if (env.IMAGES) await env.IMAGES.put(`menu/${key}`, bytes, { httpMetadata: { contentType: type } });
  else await env.DB.prepare("INSERT INTO menu_images (key, content_type, data, created_at) VALUES (?, ?, ?, ?)").bind(key, type, bytes, Date.now()).run();
  return key;
}

/** 画像の中身を読む(なければ null) */
export async function readMenuImage(env: Env, key: string): Promise<{ body: ArrayBuffer | Uint8Array | ReadableStream; type: string } | null> {
  const type = TYPE_BY_EXT[key.split(".")[1] ?? ""];
  if (!type) return null;
  if (env.IMAGES) {
    const obj = await env.IMAGES.get(`menu/${key}`);
    if (obj) return { body: obj.body, type };
  }
  // R2を使う前に保存した画像がD1に残っていることもあるので、R2になければD1も見る
  const row = await env.DB.prepare("SELECT data FROM menu_images WHERE key = ?").bind(key).first<{ data: ArrayBuffer | number[] }>();
  // D1のBLOBは数値の配列で返ることがあるので、バイト列にそろえる
  return row ? { body: Array.isArray(row.data) ? new Uint8Array(row.data) : row.data, type } : null;
}

async function exists(env: Env, key: string): Promise<boolean> {
  if (env.IMAGES && (await env.IMAGES.head(`menu/${key}`))) return true;
  return !!(await env.DB.prepare("SELECT 1 FROM menu_images WHERE key = ?").bind(key).first());
}

/** 保存・変更で指定された画像キーが、アップロード済みか */
export async function assertMenuImage(env: Env, key: string | null | undefined) {
  if (!key) return;
  if (!(await exists(env, key))) throw badRequest("アップロードした画像が見つかりません。もう一度保存してください", "IMAGE_NOT_FOUND");
}

/** どの商品・セットからも使われなくなった画像を消す(失敗しても本体の保存には影響させない) */
export async function dropMenuImageIfUnused(env: Env, key: string | null | undefined) {
  if (!key) return;
  try {
    const n =
      ((await env.DB.prepare("SELECT (SELECT COUNT(*) FROM products WHERE image_key = ?1) + (SELECT COUNT(*) FROM sets WHERE image_key = ?1) AS n").bind(key).first<{ n: number }>())?.n ?? 0);
    if (n > 0) return;
    if (env.IMAGES) await env.IMAGES.delete(`menu/${key}`);
    await env.DB.prepare("DELETE FROM menu_images WHERE key = ?").bind(key).run();
  } catch {
    /* 消せなくても、使われていない画像が残るだけ */
  }
}

export { conflict };
