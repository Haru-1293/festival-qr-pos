import { Hono } from "hono";
import { z } from "zod";
import type { CardDto, IssuedCard } from "@shared/api";
import type { AppEnv } from "../env";
import { auditStmt } from "../lib/audit";
import { getExpiryPolicy, maxExpiry, resolveExpiry } from "../lib/expiry";
import { openText, sealText, vaultSecret } from "../lib/vault";
import { capByGlobal } from "../lib/globalExpiry";
import { CARD_SELECT, type CardRow, cardUsableSql, newCardToken, toCardDto } from "../lib/cards";
import { hashPin, sha256Hex } from "../lib/crypto";
import { badRequest, conflict, notFound } from "../lib/errors";
import { newId } from "../lib/ids";
import { CARD_QR_PATTERN } from "../lib/qr";
import { zv } from "../lib/validate";
import { requireAuth, requireRole } from "../middleware/auth";

const id26 = z.string().length(26);
const idParam = zv("param", z.object({ id: id26 }));
const pinSchema = z.string().regex(/^[0-9]{4}$/, "PINは4桁の数字にしてください");
const reasonSchema = z.string().trim().min(1, "理由を入力してください").max(200, "理由は200文字以内にしてください");
const expirySchema = z.number().int().optional();

function pepper(env: { PIN_PEPPER?: string }): string {
  if (!env.PIN_PEPPER || env.PIN_PEPPER.length < 16) throw conflict("PIN_PEPPER が設定されていないため、PINを扱えません", "PEPPER_MISSING");
  return env.PIN_PEPPER;
}

/** 期限の指定が無ければ、管理者が設定した既定の期限にする。指定があっても6か月特例の上限は超えられない */
async function checkExpiry(db: D1Database, expiresAt: number | undefined, now: number): Promise<number> {
  let e = expiresAt;
  if (e === undefined) {
    const d = resolveExpiry(await getExpiryPolicy(db), now);
    if (d === null) throw badRequest("有効期限の設定が過去の日付になっています。管理者に設定の見直しを依頼してください", "EXPIRY_POLICY_INVALID");
    e = d;
  }
  if (e <= now) throw badRequest("有効期限は未来の日時にしてください");
  if (e > maxExpiry(now)) throw badRequest("有効期限は6か月(184日)以内にしてください(前払式支払手段の特例)");
  return capByGlobal(db, e, now);
}

const isUnique = (e: unknown) => e instanceof Error && e.message.includes("UNIQUE constraint failed");

async function loadCard(db: D1Database, id: string): Promise<CardRow> {
  const r = await db.prepare(`${CARD_SELECT} WHERE c.id = ?`).bind(id).first<CardRow>();
  if (!r) throw notFound("カードが見つかりません");
  return r;
}

/** 物理カードの管理(全体管理者だけ。発行・有効化・停止・削除・再発行・PIN再設定) */
export const cardRoutes = new Hono<AppEnv>()
  .use("*", requireRole("ADMIN"))

  // 一覧・検索(ニックネーム・カード番号・発行バッチ)。同名の利用者は番号・残高・日時で見分ける
  .get("/", zv("query", z.object({ q: z.string().trim().max(60).optional(), status: z.enum(["ISSUED", "ACTIVE", "SUSPENDED", "EXPIRED", "DELETED"]).optional(), expiring: z.coerce.number().int().min(1).max(60).optional(), limit: z.coerce.number().int().min(1).max(100).default(100), offset: z.coerce.number().int().min(0).max(100000).default(0) })), async (c) => {
    const { q, status, expiring, limit, offset } = c.req.valid("query");
    const now = Date.now();
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q) {
      const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
      where.push("(c.nickname LIKE ? ESCAPE '\\' OR c.display_no LIKE ? ESCAPE '\\' OR c.issue_batch LIKE ? ESCAPE '\\')");
      args.push(like, like, like);
    }
    if (expiring) {
      // 使えるカードのうち、あと○日以内に期限が来るもの(期限が近い順)
      where.push("c.status IN ('ACTIVE','SUSPENDED') AND c.expires_at IS NOT NULL AND c.expires_at > ? AND c.expires_at <= ?");
      args.push(now, now + expiring * 86_400_000);
    } else if (status === "EXPIRED") {
      where.push("c.status IN ('ISSUED','ACTIVE','SUSPENDED') AND c.expires_at IS NOT NULL AND c.expires_at <= ?");
      args.push(now);
    } else if (status === "DELETED") where.push("c.status = 'DELETED'");
    else if (status) {
      where.push("c.status = ? AND (c.expires_at IS NULL OR c.expires_at > ?)");
      args.push(status, now);
    } else where.push("c.status <> 'DELETED'");
    const { results } = await c.env.DB.prepare(`${CARD_SELECT} WHERE ${where.join(" AND ")} ORDER BY ${expiring ? "c.expires_at ASC," : ""} c.issued_at DESC, c.display_no DESC LIMIT ? OFFSET ?`)
      .bind(...args, limit + 1, offset)
      .all<CardRow>();
    const more = results.length > limit;
    const page = more ? results.slice(0, limit) : results;
    // 件数の集計(全件の走査)は一覧のたびには行わない。続きがあるときは next(次の offset)を返す
    return c.json({ cards: page.map((r) => toCardDto(r, now)), next: more ? offset + limit : null });
  })

  // 発行(一括)。QRトークンはここで返す1回だけ。サーバーにはハッシュしか残らないので、印刷はこのレスポンスから行う
  .post(
    "/issue",
    zv("json", z.object({ count: z.number().int().min(1, "枚数は1以上にしてください").max(100, "一度に発行できるのは100枚までです"), batch: z.string().trim().max(40).optional(), memo: z.string().trim().max(200).optional(), expiresAt: expirySchema })),
    async (c) => {
      const auth = requireAuth(c);
      const b = c.req.valid("json");
      const db = c.env.DB;
      const now = Date.now();
      const expiresAt = await checkExpiry(c.env.DB, b.expiresAt, now);
      for (let attempt = 0; attempt < 3; attempt++) {
        // カード番号は連番(認証には使わない・再利用しない)。同時発行で重なったら一意制約で弾かれるので、やり直す
        const last = await db.prepare("SELECT COALESCE(MAX(CAST(SUBSTR(display_no, 2) AS INTEGER)), 0) AS n FROM cards").first<{ n: number }>();
        const start = (last?.n ?? 0) + 1;
        const issued: IssuedCard[] = [];
        const stmts: D1PreparedStatement[] = [];
        const secret = vaultSecret(c.env);
        for (let i = 0; i < b.count; i++) {
          const { token, hash } = await newCardToken();
          const id = newId(now);
          const displayNo = `C${String(start + i).padStart(6, "0")}`;
          issued.push({ id, displayNo, token, expiresAt });
          stmts.push(
            db.prepare("INSERT INTO token_tombstones (token_hash, kind, created_at) VALUES (?, 'CARD_QR', ?)").bind(hash, now),
            db
              .prepare(`INSERT INTO cards (id, display_no, qr_token_hash, status, expires_at, issue_batch, memo, issued_at, issued_by, qr_enc) VALUES (?, ?, ?, 'ISSUED', ?, ?, ?, ?, ?, ?)`)
              .bind(id, displayNo, hash, expiresAt, b.batch || null, b.memo || null, now, auth.userId, await sealText(secret, token)),
          );
        }
        stmts.push(auditStmt(db, { actor: auth, action: "card.issue", targetType: "card", targetId: issued[0].id, after: { count: b.count, first: issued[0].displayNo, last: issued[issued.length - 1].displayNo, batch: b.batch ?? null } }));
        try {
          await db.batch(stmts);
          return c.json({ cards: issued }, 201);
        } catch (e) {
          if (!isUnique(e) || attempt === 2) throw e;
        }
      }
      throw conflict("カードを発行できませんでした。もう一度お試しください", "ISSUE_RETRY");
    },
  )

  // 実物カードのQRを読み取って、カード情報を見る(有効化の前の確認。状態は変えない)
  .post("/scan", zv("json", z.object({ token: z.string().trim().max(100) })), async (c) => {
    const { token } = c.req.valid("json");
    if (!CARD_QR_PATTERN.test(token)) throw badRequest("カードのQRではありません", "INVALID_QR");
    const hash = await sha256Hex(token);
    const r = await c.env.DB.prepare(`${CARD_SELECT} WHERE c.qr_token_hash = ?`).bind(hash).first<CardRow>();
    if (!r) throw notFound("このカードは登録されていないか、無効になっています", "CARD_NOT_FOUND");
    return c.json({ card: toCardDto(r, Date.now()) });
  })

  // 有効化: ニックネーム・PINを設定し、ウォレットを作って決済・チャージできるようにする
  .post(
    "/:id/activate",
    idParam,
    zv("json", z.object({ nickname: z.string().trim().min(1, "ニックネームを入力してください").max(30, "ニックネームは30文字以内にしてください"), pin: pinSchema, memo: z.string().trim().max(200).optional(), expiresAt: expirySchema })),
    async (c) => {
      const auth = requireAuth(c);
      const { id } = c.req.valid("param");
      const b = c.req.valid("json");
      const db = c.env.DB;
      const card = await loadCard(db, id);
      if (card.status !== "ISSUED") throw conflict("このカードはすでに有効化されているか、使えない状態です", "CARD_STATE");
      const now = Date.now();
      const expiresAt = await checkExpiry(c.env.DB, b.expiresAt ?? card.expires_at ?? undefined, now);
      const pinHash = await hashPin(b.pin, pepper(c.env));
      const walletId = newId(now);
      const res = await db.batch([
        // ウォレットはカードが未有効化のときだけ作る。同じ batch(同一トランザクション)でカードも更新する
        db
          .prepare("INSERT INTO wallets (id, owner_user_id, balance, status, expires_at, created_at) SELECT ?, NULL, 0, 'ACTIVE', ?, ? WHERE EXISTS (SELECT 1 FROM cards WHERE id = ? AND status = 'ISSUED')")
          .bind(walletId, expiresAt, now, id),
        db
          .prepare(
            `UPDATE cards SET status = 'ACTIVE', wallet_id = ?, nickname = ?, pin_hash = ?, expires_at = ?, memo = COALESCE(?, memo), activated_at = ?, activated_by = ?
              WHERE id = ? AND status = 'ISSUED' AND EXISTS (SELECT 1 FROM wallets WHERE id = ?)`,
          )
          .bind(walletId, b.nickname, pinHash, expiresAt, b.memo || null, now, auth.userId, id, walletId),
        db
          .prepare(
            `INSERT INTO audit_logs (id, actor_user_id, actor_role, action, target_type, target_id, before_json, after_json, created_at)
             SELECT ?, ?, ?, 'card.activate', 'card', ?, NULL, ?, ? WHERE EXISTS (SELECT 1 FROM cards WHERE id = ? AND status = 'ACTIVE' AND activated_at = ?)`,
          )
          .bind(newId(now), auth.userId, auth.role, id, JSON.stringify({ displayNo: card.display_no, nickname: b.nickname, walletId, expiresAt }), now, id, now),
      ]);
      if ((res[1].meta.changes ?? 0) !== 1) throw conflict("このカードはすでに有効化されています", "CARD_STATE");
      return c.json({ card: toCardDto(await loadCard(db, id), now) }, 201);
    },
  )

  // 一時停止(紛失報告など)。停止中は決済・チャージ・払戻しができない
  .post("/:id/suspend", idParam, zv("json", z.object({ reason: reasonSchema })), async (c) => {
    const auth = requireAuth(c);
    const { id } = c.req.valid("param");
    const { reason } = c.req.valid("json");
    const db = c.env.DB;
    const card = await loadCard(db, id);
    if (card.status !== "ACTIVE") throw conflict("有効なカードだけ一時停止できます", "CARD_STATE");
    const now = Date.now();
    const res = await db.batch([
      db.prepare("UPDATE cards SET status = 'SUSPENDED', suspended_at = ?, suspend_reason = ? WHERE id = ? AND status = 'ACTIVE'").bind(now, reason, id),
      db
        .prepare(
          `INSERT INTO audit_logs (id, actor_user_id, actor_role, action, target_type, target_id, before_json, after_json, reason, created_at)
           SELECT ?, ?, ?, 'card.suspend', 'card', ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM cards WHERE id = ? AND status = 'SUSPENDED' AND suspended_at = ?)`,
        )
        .bind(newId(now), auth.userId, auth.role, id, JSON.stringify({ status: "ACTIVE" }), JSON.stringify({ status: "SUSPENDED" }), reason, now, id, now),
    ]);
    if ((res[0].meta.changes ?? 0) !== 1) throw conflict("カードの状態が変わりました。更新して確認してください", "CARD_STATE");
    return c.json({ ok: true });
  })

  .post("/:id/resume", idParam, zv("json", z.object({ reason: reasonSchema })), async (c) => {
    const auth = requireAuth(c);
    const { id } = c.req.valid("param");
    const { reason } = c.req.valid("json");
    const db = c.env.DB;
    const card = await loadCard(db, id);
    if (card.status !== "SUSPENDED") throw conflict("一時停止中のカードだけ再開できます", "CARD_STATE");
    const now = Date.now();
    const res = await db.batch([
      db.prepare("UPDATE cards SET status = 'ACTIVE', suspended_at = NULL, suspend_reason = NULL WHERE id = ? AND status = 'SUSPENDED'").bind(id),
      db
        .prepare(
          `INSERT INTO audit_logs (id, actor_user_id, actor_role, action, target_type, target_id, before_json, after_json, reason, created_at)
           SELECT ?, ?, ?, 'card.resume', 'card', ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM cards WHERE id = ? AND status = 'ACTIVE')`,
        )
        .bind(newId(now), auth.userId, auth.role, id, JSON.stringify({ status: "SUSPENDED", suspendReason: card.suspend_reason }), JSON.stringify({ status: "ACTIVE" }), reason, now, id),
    ]);
    if ((res[0].meta.changes ?? 0) !== 1) throw conflict("カードの状態が変わりました。更新して確認してください", "CARD_STATE");
    return c.json({ ok: true });
  })

  // PINの再設定(忘れた・変更したい場合)。旧PINは確認しない(全体管理者が本人確認のうえ行う)
  .post("/:id/reset-pin", idParam, zv("json", z.object({ pin: pinSchema })), async (c) => {
    const auth = requireAuth(c);
    const { id } = c.req.valid("param");
    const { pin } = c.req.valid("json");
    const db = c.env.DB;
    const card = await loadCard(db, id);
    if (card.status !== "ACTIVE" && card.status !== "SUSPENDED") throw conflict("有効化済みのカードだけPINを再設定できます", "CARD_STATE");
    const pinHash = await hashPin(pin, pepper(c.env));
    const now = Date.now();
    await db.batch([
      db.prepare("UPDATE cards SET pin_hash = ? WHERE id = ? AND status IN ('ACTIVE','SUSPENDED')").bind(pinHash, id),
      auditStmt(db, { actor: auth, action: "card.reset_pin", targetType: "card", targetId: id, after: { displayNo: card.display_no } }),
    ]);
    void now;
    return c.json({ ok: true });
  })

  // カードのQRを何度でも表示する(印刷のやり直し・保存ミスのため)。複数枚まとめて取得でき、閲覧は監査ログに残る
  .post("/qr-batch", zv("json", z.object({ ids: z.array(id26).min(1).max(100) })), async (c) => {
    const auth = requireAuth(c);
    const { ids } = c.req.valid("json");
    const db = c.env.DB;
    const secret = vaultSecret(c.env);
    const { results } = await db
      .prepare(`SELECT id, display_no, qr_enc, expires_at FROM cards WHERE id IN (${ids.map(() => "?").join(",")}) AND status <> 'DELETED' ORDER BY display_no`)
      .bind(...ids)
      .all<{ id: string; display_no: string; qr_enc: string | null; expires_at: number | null }>();
    const cards: IssuedCard[] = [];
    const missing: string[] = [];
    for (const r of results) {
      const token = await openText(secret, r.qr_enc);
      if (token) cards.push({ id: r.id, displayNo: r.display_no, token, expiresAt: r.expires_at ?? 0 });
      else missing.push(r.display_no);
    }
    if (cards.length > 0) {
      await db.batch([auditStmt(db, { actor: auth, action: "card_qr.view", targetType: "card", targetId: cards[0].id, after: { count: cards.length, first: cards[0].displayNo, last: cards[cards.length - 1].displayNo } })]);
    }
    c.header("Cache-Control", "no-store");
    return c.json({ cards, missing });
  })

  // 未有効化カードの印刷物を紛失したとき等: 古いQRを永久に失効させ、新しいQRを作る(古いトークンは二度と使えない)
  .post("/:id/regenerate", idParam, async (c) => {
    const auth = requireAuth(c);
    const { id } = c.req.valid("param");
    const db = c.env.DB;
    const card = await loadCard(db, id);
    if (card.status !== "ISSUED") throw conflict("未有効化のカードだけQRを作り直せます。有効化済みのカードは再発行してください", "CARD_STATE");
    const now = Date.now();
    const old = await db.prepare("SELECT qr_token_hash FROM cards WHERE id = ?").bind(id).first<{ qr_token_hash: string | null }>();
    const { token, hash } = await newCardToken();
    const res = await db.batch([
      db.prepare("INSERT INTO token_tombstones (token_hash, kind, created_at) VALUES (?, 'CARD_QR', ?)").bind(hash, now),
      db.prepare("UPDATE token_tombstones SET retired_at = ? WHERE token_hash = ?").bind(now, old?.qr_token_hash ?? ""),
      db.prepare("UPDATE cards SET qr_token_hash = ?, qr_enc = ? WHERE id = ? AND status = 'ISSUED'").bind(hash, await sealText(vaultSecret(c.env), token), id),
      auditStmt(db, { actor: auth, action: "card.regenerate", targetType: "card", targetId: id, after: { displayNo: card.display_no } }),
    ]);
    if ((res[2].meta.changes ?? 0) !== 1) throw conflict("カードの状態が変わりました", "CARD_STATE");
    return c.json({ card: { id, displayNo: card.display_no, token, expiresAt: card.expires_at ?? 0 } satisfies IssuedCard });
  })

  // 削除(ソフト削除): QR・PINの資格を失効させる。残高と取引の履歴は残る。
  //   walletAction: KEEP=ウォレットはそのまま / SUSPEND=ウォレットを停止(既定) / TRANSFER=新しいカードへ残高ごと引き継ぐ(再発行)
  .post(
    "/:id/delete",
    idParam,
    zv(
      "json",
      z
        .object({
          reason: reasonSchema,
          walletAction: z.enum(["KEEP", "SUSPEND", "TRANSFER"]),
          newCardId: id26.optional(),
          newPin: pinSchema.optional(),
          expiresAt: expirySchema,
        })
        .refine((v) => v.walletAction !== "TRANSFER" || (v.newCardId && v.newPin), "引き継ぐ先のカードと、新しいPINを指定してください"),
    ),
    async (c) => {
      const auth = requireAuth(c);
      const { id } = c.req.valid("param");
      const b = c.req.valid("json");
      const db = c.env.DB;
      const card = await loadCard(db, id);
      if (card.status === "DELETED") throw conflict("このカードはすでに削除されています", "CARD_STATE");
      const now = Date.now();
      const stmts: D1PreparedStatement[] = [];
      let newCard: CardRow | null = null;
      if (b.walletAction === "TRANSFER") {
        if (!card.wallet_id) throw badRequest("ウォレットのないカードは引き継げません");
        if (b.newCardId === id) throw badRequest("同じカードには引き継げません");
        newCard = await loadCard(db, b.newCardId!);
        if (newCard.status !== "ISSUED") throw conflict("引き継ぎ先は未有効化のカードにしてください", "CARD_STATE");
      }
      const expiresAt = b.walletAction === "TRANSFER" ? await checkExpiry(c.env.DB, b.expiresAt ?? card.expires_at ?? undefined, now) : null;
      const newPinHash = b.walletAction === "TRANSFER" ? await hashPin(b.newPin!, pepper(c.env)) : null;
      const old = await db.prepare("SELECT qr_token_hash FROM cards WHERE id = ?").bind(id).first<{ qr_token_hash: string | null }>();

      // ① 旧カードを削除(QR・PINは失効。削除済みでないときだけ)。続く文は「①が成功したときだけ」動く
      stmts.push(
        db
          .prepare("UPDATE cards SET status = 'DELETED', deleted_at = ?, deleted_by = ?, delete_reason = ?, qr_token_hash = NULL, qr_enc = NULL, pin_hash = NULL WHERE id = ? AND status <> 'DELETED'")
          .bind(now, auth.userId, b.reason, id),
        db.prepare("UPDATE token_tombstones SET retired_at = ? WHERE token_hash = ?").bind(now, old?.qr_token_hash ?? ""),
      );
      const deletedHere = "EXISTS (SELECT 1 FROM cards WHERE id = ? AND status = 'DELETED' AND deleted_at = ?)";
      if (b.walletAction === "SUSPEND" && card.wallet_id) {
        stmts.push(db.prepare(`UPDATE wallets SET status = 'SUSPENDED' WHERE id = ? AND status = 'ACTIVE' AND ${deletedHere}`).bind(card.wallet_id, id, now));
      }
      if (b.walletAction === "TRANSFER" && newCard && card.wallet_id) {
        stmts.push(
          db
            .prepare(
              `UPDATE cards SET status = 'ACTIVE', wallet_id = ?, nickname = ?, pin_hash = ?, expires_at = ?, activated_at = ?, activated_by = ?, reissued_from_card_id = ?
                WHERE id = ? AND status = 'ISSUED' AND ${deletedHere}`,
            )
            .bind(card.wallet_id, card.nickname, newPinHash, expiresAt, now, auth.userId, id, newCard.id, id, now),
          // 引き継いだウォレットの有効期限も、新カードの期限にそろえる(6か月特例の範囲内)。停止中のウォレットは再開する
          db
            .prepare(`UPDATE wallets SET expires_at = ?, status = CASE WHEN status = 'SUSPENDED' THEN 'ACTIVE' ELSE status END WHERE id = ? AND EXISTS (SELECT 1 FROM cards WHERE id = ? AND status = 'ACTIVE' AND wallet_id = ?)`)
            .bind(expiresAt, card.wallet_id, newCard.id, card.wallet_id),
        );
      }
      stmts.push(
        db
          .prepare(
            `INSERT INTO audit_logs (id, actor_user_id, actor_role, action, target_type, target_id, before_json, after_json, reason, created_at)
             SELECT ?, ?, ?, ?, 'card', ?, ?, ?, ?, ? WHERE ${deletedHere}`,
          )
          .bind(
            newId(now), auth.userId, auth.role, b.walletAction === "TRANSFER" ? "card.reissue" : "card.delete", id,
            JSON.stringify({ status: card.status, displayNo: card.display_no, walletId: card.wallet_id, balance: card.balance }),
            JSON.stringify({ status: "DELETED", walletAction: b.walletAction, newCard: newCard?.display_no ?? null }),
            b.reason, now, id, now,
          ),
      );
      const res = await db.batch(stmts);
      if ((res[0].meta.changes ?? 0) !== 1) throw conflict("カードの状態が変わりました。更新して確認してください", "CARD_STATE");
      if (b.walletAction === "TRANSFER") {
        const ok = await db.prepare("SELECT 1 FROM cards WHERE id = ? AND status = 'ACTIVE' AND reissued_from_card_id = ?").bind(newCard!.id, id).first();
        if (!ok) throw conflict("引き継ぎ先のカードの状態が変わったため、引き継げませんでした。削除は完了しています。別のカードで再発行してください", "TRANSFER_FAILED");
      }
      return c.json({ ok: true, newCard: newCard ? toCardDto(await loadCard(db, newCard.id), now) : null });
    },
  );

void cardUsableSql;
export type { CardDto };
