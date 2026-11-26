import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { auditStmt } from "../lib/audit";
import { conflict, notFound } from "../lib/errors";
import { newId } from "../lib/ids";
import { zv as zValidator } from "../lib/validate";
import { requireAuth, requireRole } from "../middleware/auth";
import { templateBodySchema, type PrintKind } from "../../shared/printDesign";

const MAX_PER_KIND = 20;
const idParam = zValidator("param", z.object({ id: z.string().length(26) }));

interface Row {
  id: string;
  kind: PrintKind;
  name: string;
  layout: string;
  image?: string | null;
  has_image: number;
  updated_at: number;
}
const summary = (r: Row) => ({ id: r.id, kind: r.kind, name: r.name, layout: JSON.parse(r.layout) as unknown, hasImage: r.has_image === 1, updatedAt: r.updated_at });

/** 印刷デザイン。見る・使うのは全体管理者と店舗責任者(店員のログインQRを印刷するため)、作る・直す・消すのは全体管理者だけ */
export const printTemplateRoutes = new Hono<AppEnv>()
  .get("/", requireRole("ADMIN", "SHOP_MANAGER"), zValidator("query", z.object({ kind: z.enum(["LOGIN", "CARD"]) })), async (c) => {
    const { kind } = c.req.valid("query");
    const { results } = await c.env.DB.prepare("SELECT id, kind, name, layout, image IS NOT NULL AS has_image, updated_at FROM print_templates WHERE kind = ? ORDER BY updated_at DESC").bind(kind).all<Row>();
    return c.json({ templates: results.map(summary) });
  })
  .get("/:id", requireRole("ADMIN", "SHOP_MANAGER"), idParam, async (c) => {
    const { id } = c.req.valid("param");
    const r = await c.env.DB.prepare("SELECT id, kind, name, layout, image, image IS NOT NULL AS has_image, updated_at FROM print_templates WHERE id = ?").bind(id).first<Row>();
    if (!r) throw notFound("デザインが見つかりません");
    return c.json({ template: { ...summary(r), image: r.image ?? null } });
  })
  .post("/", requireRole("ADMIN"), zValidator("json", templateBodySchema), async (c) => {
    const auth = requireAuth(c);
    const b = c.req.valid("json");
    const db = c.env.DB;
    const n = (await db.prepare("SELECT COUNT(*) AS n FROM print_templates WHERE kind = ?").bind(b.kind).first<{ n: number }>())?.n ?? 0;
    if (n >= MAX_PER_KIND) throw conflict(`デザインは${MAX_PER_KIND}件までです。使わないものを消してください`, "TEMPLATE_LIMIT");
    const id = newId();
    const now = Date.now();
    await db.batch([
      db.prepare("INSERT INTO print_templates (id, kind, name, layout, image, created_at, created_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(id, b.kind, b.name, JSON.stringify(b.layout), b.image, now, auth.userId, now),
      auditStmt(db, { actor: auth, action: "print_template.create", targetType: "print_template", targetId: id, after: { kind: b.kind, name: b.name } }),
    ]);
    return c.json({ id }, 201);
  })
  .put("/:id", requireRole("ADMIN"), idParam, zValidator("json", templateBodySchema.omit({ kind: true })), async (c) => {
    const auth = requireAuth(c);
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    const db = c.env.DB;
    const now = Date.now();
    const res = await db.batch([
      db.prepare("UPDATE print_templates SET name = ?, layout = ?, image = ?, updated_at = ? WHERE id = ?").bind(b.name, JSON.stringify(b.layout), b.image, now, id),
      auditStmt(db, { actor: auth, action: "print_template.update", targetType: "print_template", targetId: id, after: { name: b.name } }),
    ]);
    if ((res[0].meta.changes ?? 0) !== 1) throw notFound("デザインが見つかりません");
    return c.json({ ok: true });
  })
  .delete("/:id", requireRole("ADMIN"), idParam, async (c) => {
    const auth = requireAuth(c);
    const { id } = c.req.valid("param");
    const db = c.env.DB;
    const res = await db.batch([db.prepare("DELETE FROM print_templates WHERE id = ?").bind(id), auditStmt(db, { actor: auth, action: "print_template.delete", targetType: "print_template", targetId: id })]);
    if ((res[0].meta.changes ?? 0) !== 1) throw notFound("デザインが見つかりません");
    return c.json({ ok: true });
  });
