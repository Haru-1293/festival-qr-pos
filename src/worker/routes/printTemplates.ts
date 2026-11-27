import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { auditStmt } from "../lib/audit";
import { conflict, notFound } from "../lib/errors";
import { newId } from "../lib/ids";
import { zv as zValidator } from "../lib/validate";
import { requireAuth, requireRole } from "../middleware/auth";
import { badRequest } from "../lib/errors";
import { IMAGE_KEY_PATTERN, IMAGE_R2_MAX_BYTES, IMAGE_DATA_URL_MAX, IMAGE_URL_PREFIX, templateBodySchema, templateUpdateSchema, type ImageStorageInfo, type PrintKind } from "../../shared/printDesign";

const MAX_PER_KIND = 20;
const idParam = zValidator("param", z.object({ id: z.string().length(26) }));

interface Row {
  id: string;
  kind: PrintKind;
  name: string;
  layout: string;
  image?: string | null;
  image_key?: string | null;
  has_image: number;
  updated_at: number;
}
const HAS_IMAGE = "(image IS NOT NULL OR image_key IS NOT NULL)";
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const TYPE: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };

/** 先頭のバイト列が、宣言された画像の種類と合っているか(PNG・JPEG・WebP) */
function matchesMagic(type: string, b: Uint8Array): boolean {
  if (type === "image/png") return b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  if (type === "image/jpeg") return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (type === "image/webp") return b.length > 12 && String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP";
  return false;
}

const storageInfo = (env: { IMAGES?: R2Bucket }): ImageStorageInfo => (env.IMAGES ? { mode: "r2", maxBytes: IMAGE_R2_MAX_BYTES } : { mode: "inline", maxBytes: IMAGE_DATA_URL_MAX });

/** 参照されなくなった画像をR2から消す(失敗しても本体の保存には影響させない) */
async function dropIfUnused(env: { DB: D1Database; IMAGES?: R2Bucket }, key: string | null | undefined) {
  if (!key || !env.IMAGES) return;
  const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM print_templates WHERE image_key = ?").bind(key).first<{ n: number }>())?.n ?? 0;
  if (n === 0) await env.IMAGES.delete(`design/${key}`).catch(() => undefined);
}

/** 指定された画像キーが、R2に実在するか */
async function assertImageKey(env: { IMAGES?: R2Bucket }, key: string | null) {
  if (!key) return;
  if (!env.IMAGES) throw conflict("画像の保存先(R2)が設定されていません", "R2_NOT_CONFIGURED");
  if (!(await env.IMAGES.head(`design/${key}`))) throw badRequest("アップロードした画像が見つかりません。もう一度保存してください", "IMAGE_NOT_FOUND");
}

const summary = (r: Row) => ({ id: r.id, kind: r.kind, name: r.name, layout: JSON.parse(r.layout) as unknown, hasImage: r.has_image === 1, updatedAt: r.updated_at });

/** 印刷デザイン。見る・使うのは全体管理者と店舗責任者(店員のログインQRを印刷するため)、作る・直す・消すのは全体管理者だけ */
export const printTemplateRoutes = new Hono<AppEnv>()
  .get("/", requireRole("ADMIN", "SHOP_MANAGER"), zValidator("query", z.object({ kind: z.enum(["LOGIN", "CARD"]) })), async (c) => {
    const { kind } = c.req.valid("query");
    const { results } = await c.env.DB.prepare(`SELECT id, kind, name, layout, ${HAS_IMAGE} AS has_image, updated_at FROM print_templates WHERE kind = ? ORDER BY updated_at DESC`).bind(kind).all<Row>();
    return c.json({ templates: results.map(summary) });
  })
  .get("/storage", requireRole("ADMIN", "SHOP_MANAGER"), (c) => c.json(storageInfo(c.env)))
  // 背景画像のアップロード(R2): 本文は画像そのもの。XMLの読み込みも、保存ボタンを押したときにここへ送る
  .post("/images", requireRole("ADMIN"), async (c) => {
    if (!c.env.IMAGES) throw conflict("画像の保存先(R2)が設定されていません", "R2_NOT_CONFIGURED");
    const type = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const ext = EXT[type];
    if (!ext) throw badRequest("PNG・JPEG・WebPの画像を送ってください");
    const declared = Number(c.req.header("content-length") ?? "0");
    if (declared > IMAGE_R2_MAX_BYTES * 4) throw badRequest(`画像が大きすぎます(${Math.floor(IMAGE_R2_MAX_BYTES / 1_000_000)}MBまで)`, "IMAGE_TOO_LARGE");
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.length === 0) throw badRequest("画像が空です");
    if (bytes.length > IMAGE_R2_MAX_BYTES) throw badRequest(`画像が大きすぎます(${Math.floor(IMAGE_R2_MAX_BYTES / 1_000_000)}MBまで)`, "IMAGE_TOO_LARGE");
    if (!matchesMagic(type, bytes)) throw badRequest("画像の中身が、選んだ種類(PNG・JPEG・WebP)と合っていません");
    const key = `${newId()}.${ext}`;
    await c.env.IMAGES.put(`design/${key}`, bytes, { httpMetadata: { contentType: type } });
    return c.json({ key, url: `${IMAGE_URL_PREFIX}${key}` }, 201);
  })
  .get("/images/:key", requireRole("ADMIN", "SHOP_MANAGER"), zValidator("param", z.object({ key: z.string().regex(IMAGE_KEY_PATTERN) })), async (c) => {
    if (!c.env.IMAGES) throw notFound("画像が見つかりません");
    const { key } = c.req.valid("param");
    const obj = await c.env.IMAGES.get(`design/${key}`);
    if (!obj) throw notFound("画像が見つかりません");
    return new Response(obj.body, {
      headers: {
        "content-type": TYPE[key.split(".")[1]!] ?? "application/octet-stream",
        "cache-control": "private, max-age=86400, immutable", // キーは中身ごとに別なので、変わらない
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'",
      },
    });
  })
  .get("/:id", requireRole("ADMIN", "SHOP_MANAGER"), idParam, async (c) => {
    const { id } = c.req.valid("param");
    const r = await c.env.DB.prepare(`SELECT id, kind, name, layout, image, image_key, ${HAS_IMAGE} AS has_image, updated_at FROM print_templates WHERE id = ?`).bind(id).first<Row>();
    if (!r) throw notFound("デザインが見つかりません");
    return c.json({ template: { ...summary(r), image: r.image ?? (r.image_key ? `${IMAGE_URL_PREFIX}${r.image_key}` : null) } });
  })
  .post("/", requireRole("ADMIN"), zValidator("json", templateBodySchema), async (c) => {
    const auth = requireAuth(c);
    const b = c.req.valid("json");
    const db = c.env.DB;
    const n = (await db.prepare("SELECT COUNT(*) AS n FROM print_templates WHERE kind = ?").bind(b.kind).first<{ n: number }>())?.n ?? 0;
    if (n >= MAX_PER_KIND) throw conflict(`デザインは${MAX_PER_KIND}件までです。使わないものを消してください`, "TEMPLATE_LIMIT");
    await assertImageKey(c.env, b.imageKey);
    const id = newId();
    const now = Date.now();
    await db.batch([
      db.prepare("INSERT INTO print_templates (id, kind, name, layout, image, image_key, created_at, created_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, b.kind, b.name, JSON.stringify(b.layout), b.image, b.imageKey, now, auth.userId, now),
      auditStmt(db, { actor: auth, action: "print_template.create", targetType: "print_template", targetId: id, after: { kind: b.kind, name: b.name } }),
    ]);
    return c.json({ id }, 201);
  })
  .put("/:id", requireRole("ADMIN"), idParam, zValidator("json", templateUpdateSchema), async (c) => {
    const auth = requireAuth(c);
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    const db = c.env.DB;
    await assertImageKey(c.env, b.imageKey);
    const before = await db.prepare("SELECT image_key FROM print_templates WHERE id = ?").bind(id).first<{ image_key: string | null }>();
    const now = Date.now();
    const res = await db.batch([
      db.prepare("UPDATE print_templates SET name = ?, layout = ?, image = ?, image_key = ?, updated_at = ? WHERE id = ?").bind(b.name, JSON.stringify(b.layout), b.image, b.imageKey, now, id),
      auditStmt(db, { actor: auth, action: "print_template.update", targetType: "print_template", targetId: id, after: { name: b.name } }),
    ]);
    if ((res[0].meta.changes ?? 0) !== 1) throw notFound("デザインが見つかりません");
    if (before?.image_key && before.image_key !== b.imageKey) c.executionCtx.waitUntil(dropIfUnused(c.env, before.image_key));
    return c.json({ ok: true });
  })
  .delete("/:id", requireRole("ADMIN"), idParam, async (c) => {
    const auth = requireAuth(c);
    const { id } = c.req.valid("param");
    const db = c.env.DB;
    const before = await db.prepare("SELECT image_key FROM print_templates WHERE id = ?").bind(id).first<{ image_key: string | null }>();
    const res = await db.batch([db.prepare("DELETE FROM print_templates WHERE id = ?").bind(id), auditStmt(db, { actor: auth, action: "print_template.delete", targetType: "print_template", targetId: id })]);
    if ((res[0].meta.changes ?? 0) !== 1) throw notFound("デザインが見つかりません");
    if (before?.image_key) c.executionCtx.waitUntil(dropIfUnused(c.env, before.image_key));
    return c.json({ ok: true });
  });
