import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { auditStmt } from "../lib/audit";
import { verifyPassword } from "../lib/crypto";
import { badRequest, conflict, notFound, unauthorized } from "../lib/errors";
import { getGlobalExpiry, globalExpiryMs, resetAvailableAt, validateGlobalDate } from "../lib/globalExpiry";
import { LEGAL_KINDS, LEGAL_MAX_CHARS, loadLegal, type LegalKind } from "../lib/legal";
import { SETTING_KEYS, setSettingStmt } from "../lib/settings";
import { zv as zValidator } from "../lib/validate";
import { requireAuth, requireRole } from "../middleware/auth";
import { endOfDayJst } from "../lib/expiry";

/** 全データ削除の確認文言(画面でも同じ文字を入力させる) */
export const RESET_PHRASE = "全データを削除";

/** 全データ削除で残すもの: 設定・規約、全体管理者のアカウント(とそのログイン)。ほかは監査ログも含めてすべて消す */
const KEEP_TABLES = new Set(["settings", "legal_documents", "print_templates", "users", "sessions", "d1_migrations"]);

const kindSchema = z.object({ kind: z.enum(["TERMS", "PRIVACY"]) });

async function globalExpiryInfo(db: D1Database, now = Date.now()) {
  const g = await getGlobalExpiry(db);
  const at = resetAvailableAt(g);
  return { date: g.date, expiresAt: globalExpiryMs(g), resetAvailableAt: at, expired: g.date ? endOfDayJst(g.date) <= now : false, canReset: at !== null && at <= now, now };
}

/** 全体管理者だけ: 全体の有効期限・全データ削除・利用規約とプライバシーポリシー */
export const systemRoutes = new Hono<AppEnv>()
  .use("*", requireRole("ADMIN"))
  .get("/global-expiry", async (c) => c.json({ globalExpiry: await globalExpiryInfo(c.env.DB) }))
  // 全体の有効期限。設定すると、期限内のウォレット・カードの期限をその日に揃え、以後の発行・登録も超えられない。null で解除
  .put("/global-expiry", zValidator("json", z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日付の形式が正しくありません").nullable() })), async (c) => {
    const auth = requireAuth(c);
    const { date } = c.req.valid("json");
    const db = c.env.DB;
    const now = Date.now();
    const before = await getGlobalExpiry(db);
    if (date !== null) {
      const problem = validateGlobalDate(date, now);
      if (problem) throw badRequest(problem);
    }
    const ts = date === null ? null : endOfDayJst(date);
    const stmts = [
      setSettingStmt(db, SETTING_KEYS.globalExpiry, { date }, auth.userId),
      ...(ts === null
        ? []
        : [
            db.prepare("UPDATE wallets SET expires_at = ? WHERE status IN ('ACTIVE','SUSPENDED') AND (expires_at IS NULL OR expires_at > ?)").bind(ts, now),
            db.prepare("UPDATE cards SET expires_at = ? WHERE status IN ('ISSUED','ACTIVE','SUSPENDED') AND (expires_at IS NULL OR expires_at > ?)").bind(ts, now),
          ]),
    ];
    const res = await db.batch([...stmts, auditStmt(db, { actor: auth, action: "settings.global_expiry", targetType: "settings", targetId: SETTING_KEYS.globalExpiry, before, after: { date } })]);
    const wallets = ts === null ? 0 : (res[1]?.meta.changes ?? 0);
    const cards = ts === null ? 0 : (res[2]?.meta.changes ?? 0);
    return c.json({ globalExpiry: await globalExpiryInfo(db), updated: { wallets, cards } });
  })
  // 全データ削除。全体の期限が切れて1か月たってから。監査ログ・取引・店舗・商品・利用者(全体管理者以外)・カードをすべて消す
  .post(
    "/reset",
    zValidator("json", z.object({ phrase: z.string(), password: z.string().min(1).max(200) })),
    async (c) => {
      const auth = requireAuth(c);
      const db = c.env.DB;
      const { phrase, password } = c.req.valid("json");
      if (phrase !== RESET_PHRASE) throw badRequest(`確認のため「${RESET_PHRASE}」と入力してください`, "PHRASE_MISMATCH");
      const me = await db.prepare("SELECT password_hash FROM users WHERE id = ?").bind(auth.userId).first<{ password_hash: string | null }>();
      if (!me?.password_hash || !(await verifyPassword(password, me.password_hash))) throw unauthorized("パスワードが違います", "INVALID_CREDENTIALS");
      const info = await globalExpiryInfo(db);
      if (!info.canReset) {
        throw conflict(
          info.date === null ? "全体の有効期限が設定されていないため、全データ削除はできません" : `全データ削除は、全体の有効期限が切れた1か月後(${new Date(info.resetAvailableAt!).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" })}以降)にできます`,
          "RESET_NOT_ALLOWED",
        );
      }
      // 消す対象のテーブルと、いったん外す「履歴は消せない」トリガを、実際のスキーマから取る(将来テーブルが増えても取りこぼさない)
      const { results: tables } = await db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'")
        .all<{ name: string }>();
      const { results: triggers } = await db.prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' AND sql IS NOT NULL").all<{ name: string; tbl_name: string; sql: string }>();
      const wipe = tables.map((t) => t.name).filter((n) => !KEEP_TABLES.has(n));
      const wipeSet = new Set(wipe);
      const dropTriggers = triggers.filter((t) => wipeSet.has(t.tbl_name) && /RAISE\s*\(\s*ABORT/i.test(t.sql));
      const counts = await Promise.all(wipe.map(async (n) => [n, (await db.prepare(`SELECT COUNT(*) AS n FROM "${n}"`).first<{ n: number }>())?.n ?? 0] as const));
      const removed = Object.fromEntries(counts.filter(([, n]) => n > 0));
      const now = Date.now();
      await db.batch([
        db.prepare("PRAGMA defer_foreign_keys = on"),
        ...dropTriggers.map((t) => db.prepare(`DROP TRIGGER IF EXISTS "${t.name}"`)),
        ...wipe.map((n) => db.prepare(`DELETE FROM "${n}"`)),
        db.prepare("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE role <> 'ADMIN')"),
        db.prepare("DELETE FROM users WHERE role <> 'ADMIN'"),
        // 全体の有効期限は終わったものとして外す(次の運用の準備)。ほかの設定・規約は残す
        db.prepare("DELETE FROM settings WHERE key = ?").bind(SETTING_KEYS.globalExpiry),
        ...dropTriggers.map((t) => db.prepare(t.sql)),
        auditStmt(db, { actor: auth, action: "system.reset", targetType: "system", targetId: "all", before: { removed, resetAt: now }, reason: "全体の有効期限から1か月以上たったため、全データを削除" }),
      ]);
      return c.json({ ok: true, removed });
    },
  )
  // 利用規約・プライバシーポリシー: 現行版と版の一覧
  .get("/legal/:kind", zValidator("param", kindSchema), async (c) => {
    const { kind } = c.req.valid("param");
    const doc = await loadLegal(c.env.DB, kind);
    const { results } = await c.env.DB.prepare("SELECT version, created_at, length(body_md) AS chars FROM legal_documents WHERE kind = ? ORDER BY version DESC LIMIT 50").bind(kind).all<{ version: number; created_at: number; chars: number }>();
    return c.json({ document: doc, versions: results.map((r) => ({ version: r.version, createdAt: r.created_at, chars: r.chars })) });
  })
  .get("/legal/:kind/:version", zValidator("param", z.object({ kind: z.enum(["TERMS", "PRIVACY"]), version: z.coerce.number().int().min(1) })), async (c) => {
    const { kind, version } = c.req.valid("param");
    const doc = await loadLegal(c.env.DB, kind, version);
    if (!doc) throw notFound("その版は見つかりません");
    return c.json({ document: doc });
  })
  // 保存すると新しい版になる(古い版は消さない)。同意済みの利用者がどの版に同意したかは版番号で残る
  .put("/legal/:kind", zValidator("param", kindSchema), zValidator("json", z.object({ bodyMd: z.string().trim().min(1, "本文を入力してください").max(LEGAL_MAX_CHARS, `本文は${LEGAL_MAX_CHARS}文字以内にしてください`) })), async (c) => {
    const auth = requireAuth(c);
    const { kind } = c.req.valid("param");
    const { bodyMd } = c.req.valid("json");
    const db = c.env.DB;
    const now = Date.now();
    const cur = await loadLegal(db, kind);
    if (cur && cur.bodyMd === bodyMd) throw conflict("内容が現在の版と同じです", "NO_CHANGE");
    const next = (cur?.version ?? 0) + 1;
    try {
      await db.batch([
        db.prepare("INSERT INTO legal_documents (kind, version, body_md, created_at, created_by) VALUES (?, ?, ?, ?, ?)").bind(kind, next, bodyMd, now, auth.userId),
        auditStmt(db, { actor: auth, action: "legal.update", targetType: "legal", targetId: kind, before: { version: cur?.version ?? null }, after: { version: next, chars: bodyMd.length } }),
      ]);
    } catch (e) {
      if (e instanceof Error && e.message.includes("UNIQUE")) throw conflict("ほかの操作と重なりました。もう一度お試しください", "CONFLICT");
      throw e;
    }
    return c.json({ document: await loadLegal(db, kind) });
  });

export { LEGAL_KINDS };
export type { LegalKind };
