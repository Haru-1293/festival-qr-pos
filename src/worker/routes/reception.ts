import { walletNotExpiredSql } from "../lib/expiry";
import { Hono } from "hono";
import { z } from "zod";
import type { CashOpResult, LookupResponse, ReceptionSummary } from "@shared/api";
import { cashToUnits, unitsToCash } from "@shared/currency";
import type { AppEnv } from "../env";
import { auditStmt, auditStmtIfExists } from "../lib/audit";
import { loadLedgerResult, loadOpenTotals, loadRecentEvents } from "../lib/cash";
import { cardUsableSql } from "../lib/cards";
import { sha256Hex, verifyPin } from "../lib/crypto";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors";
import { newId } from "../lib/ids";
import { CARD_QR_PATTERN, WALLET_QR_PATTERN } from "../lib/qr";
import { getCurrency, getOperations } from "../lib/settings";
import { zv } from "../lib/validate";
import { requireAuth, requireRole } from "../middleware/auth";

/** 読み取り(lookup)の有効時間。QR自体は読み取り時点で消費済みなので、操作はこの時間内に済ませる */
const LOOKUP_TTL_MS = 5 * 60 * 1000;
const MAX_CHARGE_YEN = 1_000_000;

const requestIdSchema = z
  .string()
  .min(16, "リクエストIDが短すぎます")
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "リクエストIDの形式が正しくありません");
const idSchema = z.string().length(26);

function isUnique(e: unknown): boolean {
  return e instanceof Error && e.message.includes("UNIQUE constraint failed");
}

interface LookupRow {
  id: string;
  wallet_id: string;
  card_id: string | null;
  expires_at: number;
}

async function getLookupRow(db: D1Database, lookupId: string, userId: string): Promise<LookupRow> {
  const row = await db
    .prepare("SELECT id, wallet_id, card_id, expires_at FROM wallet_lookups WHERE id = ? AND reception_user_id = ?")
    .bind(lookupId, userId)
    .first<LookupRow>();
  if (!row) throw badRequest("読み取り情報が見つかりません。QRをもう一度読み取ってください", "LOOKUP_NOT_FOUND");
  return row;
}

function assertLookupFresh(row: LookupRow): void {
  if (row.expires_at <= Date.now()) {
    throw badRequest("読み取りの有効時間が切れました。QRをもう一度読み取ってください", "LOOKUP_EXPIRED");
  }
}

/**
 * 同じ requestId の再送なら、新しい操作を作らず元の結果を返す(通信タイムアウト後の再送・連打対策)。
 * 同じ requestId が別の担当者・別の種類・別のウォレットで使われていたら 409。
 */
async function tryReplay(
  db: D1Database,
  requestId: string,
  userId: string,
  kind: "CHARGE" | "PAYOUT" | "CHARGE_CORRECTION",
  match: { walletId?: string; correctsLedgerId?: string; cashAmount?: number; units?: number },
): Promise<CashOpResult | null> {
  const existing = await db
    .prepare("SELECT id, wallet_id, kind, operator_user_id, corrects_ledger_id FROM wallet_ledger WHERE idempotency_key = ?")
    .bind(requestId)
    .first<{ id: string; wallet_id: string; kind: string; operator_user_id: string | null; corrects_ledger_id: string | null }>();
  if (!existing) return null;
  const same =
    existing.kind === kind &&
    existing.operator_user_id === userId &&
    (match.walletId === undefined || existing.wallet_id === match.walletId) &&
    (match.correctsLedgerId === undefined || existing.corrects_ledger_id === match.correctsLedgerId);
  if (!same) throw conflict("このリクエストIDはすでに別の操作で使われています", "REQUEST_ID_REUSED");
  const res = await loadLedgerResult(db, existing.id);
  if (!res) return null;
  // 同じIDで金額だけ違う要求は、元の結果を黙って返さずエラーにする(入力ミス・バグの検知)
  if (
    (match.cashAmount !== undefined && res.result.cashAmount !== match.cashAmount) ||
    (match.units !== undefined && res.result.units !== match.units)
  ) {
    throw conflict("このリクエストIDは別の金額ですでに使われています", "REQUEST_ID_REUSED");
  }
  return { ...res.result, replayed: true };
}

const WALLET_ACTIVE_SQL = `w.status = 'ACTIVE'
   AND (w.owner_user_id IS NULL OR EXISTS (SELECT 1 FROM users u WHERE u.id = w.owner_user_id AND u.status = 'ACTIVE'))`;

/** チャージできるウォレット(有効・持ち主が有効・期限内)。払戻しは期限切れでも受け付けるので WALLET_ACTIVE_SQL を使う */
const walletChargeableSql = (now: number) => `${WALLET_ACTIVE_SQL} AND ${walletNotExpiredSql(now)}`;

const LEDGER_EXISTS_SQL = "SELECT 1 FROM wallet_ledger WHERE id = ?";

/** 読み取りがカードのとき、操作の瞬間もカードが使えること(読み取り後に停止・削除されていないこと)を確かめる条件 */
const cardLookupGuard = `(? IS NULL OR EXISTS (SELECT 1 FROM cards c WHERE c.id = ? AND ${cardUsableSql("c")}))`;
const cardGuardArgs = (l: LookupRow, now: number): (string | number | null)[] => [l.card_id, l.card_id, now];
/** 払戻しは、さらにPINを確認したときのハッシュと一致するカードに限る */
/** (払戻しは、期限切れのカードでも残高を返せる。停止・削除されたカードは不可) */
const cardPinGuard = `(? IS NULL OR EXISTS (SELECT 1 FROM cards c WHERE c.id = ? AND c.pin_hash = ? AND c.status = 'ACTIVE'))`;

export const receptionRoutes = new Hono<AppEnv>()
  .use("*", requireRole("RECEPTION"))

  // 自分の未締めの現金集計と、直近の記録
  .get("/summary", async (c) => {
    const auth = requireAuth(c);
    const [{ total }, recent, ops, currency] = await Promise.all([
      loadOpenTotals(c.env.DB, auth.userId),
      loadRecentEvents(c.env.DB, auth.userId),
      getOperations(c.env.DB),
      getCurrency(c.env.DB),
    ]);
    return c.json({
      totals: total,
      recent,
      closingMode: ops.closingMode,
      canCloseSelf: ops.closingMode === "SHIFT",
      yenPerUnit: currency.yenPerUnit,
    } satisfies ReceptionSummary);
  })

  // 顧客のQRを読み取る。QRはここで消費される(読み取り=消費)。以降の操作は返した lookupId に対して行う
  .post("/lookup", zv("json", z.object({ token: z.string().trim().max(100) })), async (c) => {
    const auth = requireAuth(c);
    const { token } = c.req.valid("json");
    const isCard = CARD_QR_PATTERN.test(token);
    if (!isCard && !WALLET_QR_PATTERN.test(token)) throw badRequest("お客様のQRではありません", "INVALID_QR");
    const db = c.env.DB;
    const hash = await sha256Hex(token);
    const now = Date.now();
    const lookupId = newId(now);
    const expiresAt = now + LOOKUP_TTL_MS;

    // 物理カード: QRは固定で消費しない。使えるカードのときだけ読み取り(lookup)を作る。払戻しにはPINが必要
    if (isCard) {
      const card = await db
        .prepare("SELECT c.id, c.status, c.expires_at, c.display_no, c.nickname, c.wallet_id, w.status AS wstatus, w.balance, w.expires_at AS wexpires FROM cards c LEFT JOIN wallets w ON w.id = c.wallet_id WHERE c.qr_token_hash = ?")
        .bind(hash)
        .first<{ id: string; status: string; expires_at: number | null; display_no: string; nickname: string | null; wallet_id: string | null; wstatus: LookupResponse["wallet"]["status"] | null; balance: number | null; wexpires: number | null }>();
      if (!card) throw badRequest("このカードは登録されていないか、無効になっています", "INVALID_QR");
      if (card.status === "ISSUED") throw forbidden("このカードはまだ有効化されていません。全体管理者に有効化を依頼してください", "CARD_INACTIVE");
      if (card.status === "SUSPENDED") throw forbidden("このカードは一時停止中です", "CARD_INACTIVE");
      if (card.status !== "ACTIVE") throw forbidden("このカードは使えません", "CARD_INACTIVE");
      // 期限切れのカードも読み取れる(残高の払戻しだけできる。チャージ・支払いはできない)
      const cardExpired = card.expires_at !== null && card.expires_at <= now;
      if (!card.wallet_id) throw forbidden("このカードにはウォレットがありません", "CARD_INACTIVE");
      const ins = await db.batch([
        db
          .prepare(
            `INSERT INTO wallet_lookups (id, wallet_id, card_id, reception_user_id, created_at, expires_at)
             SELECT ?, c.wallet_id, c.id, ?, ?, ? FROM cards c WHERE c.id = ? AND c.status = 'ACTIVE'`,
          )
          .bind(lookupId, auth.userId, now, expiresAt, card.id),
      ]);
      if ((ins[0].meta.changes ?? 0) !== 1) throw forbidden("このカードは使えません。もう一度読み取ってください", "CARD_INACTIVE");
      await db.batch([auditStmt(db, { actor: auth, action: "wallet.lookup", targetType: "wallet", targetId: card.wallet_id, after: { lookupId, card: card.display_no } })]);
      const currency = await getCurrency(db);
      return c.json({
        lookupId,
        expiresAt,
        wallet: { id: card.wallet_id, nickname: card.nickname, balance: card.balance ?? 0, status: card.wstatus ?? "ACTIVE", expired: cardExpired || (card.wexpires !== null && card.wexpires <= now) },
        card: { displayNo: card.display_no },
        yenPerUnit: currency.yenPerUnit,
      } satisfies LookupResponse);
    }

    const res = await db.batch([
      db
        .prepare(
          `UPDATE pay_qr_tokens SET consumed_at = ?, consumed_by_user_id = ?
            WHERE token_hash = ? AND consumed_at IS NULL AND invalidated_at IS NULL AND expires_at > ?`,
        )
        .bind(now, auth.userId, hash, now),
      // 消費に成功した場合だけ lookup を作る(同じ batch = 同じトランザクション)
      db
        .prepare(
          `INSERT INTO wallet_lookups (id, wallet_id, reception_user_id, created_at, expires_at)
           SELECT ?, t.wallet_id, ?, ?, ? FROM pay_qr_tokens t
            WHERE t.token_hash = ? AND t.consumed_at = ? AND t.consumed_by_user_id = ?`,
        )
        .bind(lookupId, auth.userId, now, expiresAt, hash, now, auth.userId),
    ]);

    if ((res[1].meta.changes ?? 0) !== 1) {
      const t = await db
        .prepare("SELECT consumed_at, invalidated_at, expires_at FROM pay_qr_tokens WHERE token_hash = ?")
        .bind(hash)
        .first<{ consumed_at: number | null; invalidated_at: number | null; expires_at: number }>();
      if (!t) throw badRequest("このQRは無効です", "INVALID_QR");
      if (t.consumed_at !== null) throw badRequest("このQRはすでに読み取られています。新しいQRを表示してもらってください", "QR_USED");
      if (t.invalidated_at !== null) throw badRequest("新しいQRが作られたため、このQRは使えません", "QR_REPLACED");
      throw badRequest("QRの有効期限が切れています。新しいQRを表示してもらってください", "QR_EXPIRED");
    }

    const w = await db
      .prepare(
        // 持ち主のアカウントが停止中のときも「停止中」として見せる(チャージ・払戻しはサーバー側でも拒否される)
        `SELECT w.id, w.balance,
                CASE WHEN u.status IS NOT NULL AND u.status <> 'ACTIVE' THEN 'SUSPENDED' ELSE w.status END AS status,
                w.expires_at, u.nickname
           FROM wallet_lookups l
           JOIN wallets w ON w.id = l.wallet_id LEFT JOIN users u ON u.id = w.owner_user_id
          WHERE l.id = ?`,
      )
      .bind(lookupId)
      .first<{ id: string; balance: number; status: LookupResponse["wallet"]["status"]; expires_at: number | null; nickname: string | null }>();
    if (!w) throw notFound("ウォレットが見つかりません");
    await db.batch([
      auditStmt(db, { actor: auth, action: "wallet.lookup", targetType: "wallet", targetId: w.id, after: { lookupId } }),
    ]);
    const currency = await getCurrency(db);
    return c.json({
      lookupId,
      expiresAt,
      wallet: { id: w.id, nickname: w.nickname, balance: w.balance, status: w.status, expired: w.expires_at !== null && w.expires_at <= Date.now() },
      yenPerUnit: currency.yenPerUnit,
    } satisfies LookupResponse);
  })

  // 現金チャージ: 受け取った現金(円)をポイントに換算して残高へ加算し、現金台帳に記録する
  .post(
    "/charge",
    zv(
      "json",
      z.object({
        lookupId: idSchema,
        requestId: requestIdSchema,
        cashAmount: z.number().int().min(1, "金額を入力してください").max(MAX_CHARGE_YEN, `1回のチャージは${MAX_CHARGE_YEN.toLocaleString()}円までです`),
      }),
    ),
    async (c) => {
      const auth = requireAuth(c);
      const b = c.req.valid("json");
      const db = c.env.DB;
      const lookup = await getLookupRow(db, b.lookupId, auth.userId);
      const replay = await tryReplay(db, b.requestId, auth.userId, "CHARGE", { walletId: lookup.wallet_id, cashAmount: b.cashAmount });
      if (replay) return c.json(replay);
      assertLookupFresh(lookup);

      const currency = await getCurrency(db);
      const units = cashToUnits(b.cashAmount, currency.yenPerUnit);
      if (units === null || units <= 0) {
        throw badRequest(`${b.cashAmount.toLocaleString()}円は換算できません(1${currency.shortName}=${currency.yenPerUnit}円)`, "BAD_AMOUNT");
      }
      const ledgerId = newId();
      const eventId = newId();
      const now = Date.now();
      try {
        await db.batch([
          // ① 台帳(ウォレットが有効なときだけ作られる)。残高変動の唯一の記録
          db
            .prepare(
              `INSERT INTO wallet_ledger (id, wallet_id, kind, amount, balance_after, ref_type, ref_id, operator_user_id, idempotency_key, created_at)
               SELECT ?, w.id, 'CHARGE', ?, w.balance + ?, 'CASH_EVENT', ?, ?, ?, ?
                 FROM wallets w WHERE w.id = ? AND ${walletChargeableSql(Date.now())} AND ${cardLookupGuard}`,
            )
            .bind(ledgerId, units, units, eventId, auth.userId, b.requestId, now, lookup.wallet_id, ...cardGuardArgs(lookup, Date.now())),
          // ② 残高(①ができたときだけ更新)
          db
            .prepare(
              `UPDATE wallets SET balance = (SELECT balance_after FROM wallet_ledger WHERE id = ?)
                WHERE id = ? AND EXISTS (${LEDGER_EXISTS_SQL})`,
            )
            .bind(ledgerId, lookup.wallet_id, ledgerId),
          // ③ 現金台帳(円)
          db
            .prepare(
              `INSERT INTO cash_events (id, reception_user_id, kind, amount, ledger_id, created_at, request_id)
               SELECT ?, ?, 'CHARGE', ?, ?, ?, ? WHERE EXISTS (${LEDGER_EXISTS_SQL})`,
            )
            .bind(eventId, auth.userId, b.cashAmount, ledgerId, now, b.requestId, ledgerId),
          auditStmtIfExists(
            db,
            { actor: auth, action: "cash.charge", targetType: "wallet", targetId: lookup.wallet_id, after: { ledgerId, units, cashYen: b.cashAmount } },
            LEDGER_EXISTS_SQL,
            [ledgerId],
          ),
        ]);
      } catch (e) {
        if (isUnique(e)) {
          const again = await tryReplay(db, b.requestId, auth.userId, "CHARGE", { walletId: lookup.wallet_id, cashAmount: b.cashAmount });
          if (again) return c.json(again);
          throw conflict("このリクエストIDはすでに使われています", "REQUEST_ID_REUSED");
        }
        throw e;
      }
      const res = await loadLedgerResult(db, ledgerId);
      if (!res) throw conflict("このウォレットは現在ご利用できません(停止中・有効期限切れなど)。チャージされていません", "WALLET_INACTIVE");
      return c.json({ ...res.result, replayed: false } satisfies CashOpResult, 201);
    },
  )

  // 払戻し: 学園祭期間内に、残高の全額を現金で渡す。画面で確認した残高(expectedBalance)と一致するときだけ実行する
  .post(
    "/payout",
    zv(
      "json",
      z.object({
        lookupId: idSchema,
        requestId: requestIdSchema,
        expectedBalance: z.number().int().min(1, "払い戻せる残高がありません"),
        /** 物理カードの払戻しはPIN(4桁)が必要 */
        pin: z.string().regex(/^[0-9]{4}$/, "PINは4桁の数字です").optional(),
      }),
    ),
    async (c) => {
      const auth = requireAuth(c);
      const b = c.req.valid("json");
      const db = c.env.DB;
      const lookup = await getLookupRow(db, b.lookupId, auth.userId);
      const replay = await tryReplay(db, b.requestId, auth.userId, "PAYOUT", { walletId: lookup.wallet_id, units: b.expectedBalance });
      if (replay) return c.json(replay);
      assertLookupFresh(lookup);

      // 物理カード: 現金が出るので、PINを必ず確認する(違えば実行しない)
      let pinHash = "-";
      if (lookup.card_id) {
        if (!b.pin) throw badRequest("カードのPINを入力してください", "PIN_REQUIRED");
        const card = await db
          .prepare("SELECT status, expires_at, pin_hash FROM cards WHERE id = ?")
          .bind(lookup.card_id)
          .first<{ status: string; expires_at: number | null; pin_hash: string | null }>();
        if (!card || card.status !== "ACTIVE") {
          throw forbidden("このカードは使えなくなりました", "CARD_INACTIVE");
        }
        if (!c.env.PIN_PEPPER) throw conflict("PIN_PEPPER が設定されていないため、カードを使えません", "PEPPER_MISSING");
        if (!(await verifyPin(b.pin, card.pin_hash, c.env.PIN_PEPPER))) {
          await db.batch([auditStmt(db, { actor: auth, action: "cash.payout_pin_failed", targetType: "wallet", targetId: lookup.wallet_id })]);
          throw forbidden("PINが違います", "PIN_INVALID");
        }
        pinHash = card.pin_hash!;
      }

      const currency = await getCurrency(db);
      const cash = unitsToCash(b.expectedBalance, currency.yenPerUnit);
      if (cash === null || cash <= 0) {
        throw badRequest("現金(円)に換算できないため払い戻せません。運営にご相談ください", "BAD_AMOUNT");
      }
      const ledgerId = newId();
      const eventId = newId();
      const now = Date.now();
      try {
        await db.batch([
          db
            .prepare(
              `INSERT INTO wallet_ledger (id, wallet_id, kind, amount, balance_after, ref_type, ref_id, operator_user_id, idempotency_key, created_at)
               SELECT ?, w.id, 'PAYOUT', -w.balance, 0, 'CASH_EVENT', ?, ?, ?, ?
                 FROM wallets w WHERE w.id = ? AND ${WALLET_ACTIVE_SQL} AND w.balance = ? AND w.balance > 0 AND ${cardPinGuard}`,
            )
            .bind(ledgerId, eventId, auth.userId, b.requestId, now, lookup.wallet_id, b.expectedBalance, lookup.card_id, lookup.card_id, pinHash),
          db
            .prepare(
              `UPDATE wallets SET balance = (SELECT balance_after FROM wallet_ledger WHERE id = ?)
                WHERE id = ? AND EXISTS (${LEDGER_EXISTS_SQL})`,
            )
            .bind(ledgerId, lookup.wallet_id, ledgerId),
          db
            .prepare(
              `INSERT INTO cash_events (id, reception_user_id, kind, amount, ledger_id, created_at, request_id)
               SELECT ?, ?, 'PAYOUT', ?, ?, ?, ? WHERE EXISTS (${LEDGER_EXISTS_SQL})`,
            )
            .bind(eventId, auth.userId, cash, ledgerId, now, b.requestId, ledgerId),
          auditStmtIfExists(
            db,
            { actor: auth, action: "cash.payout", targetType: "wallet", targetId: lookup.wallet_id, after: { ledgerId, units: b.expectedBalance, cashYen: cash } },
            LEDGER_EXISTS_SQL,
            [ledgerId],
          ),
        ]);
      } catch (e) {
        if (isUnique(e)) {
          const again = await tryReplay(db, b.requestId, auth.userId, "PAYOUT", { walletId: lookup.wallet_id, units: b.expectedBalance });
          if (again) return c.json(again);
          throw conflict("このリクエストIDはすでに使われています", "REQUEST_ID_REUSED");
        }
        throw e;
      }
      const res = await loadLedgerResult(db, ledgerId);
      if (!res) {
        const w = await db
          .prepare(
            `SELECT w.balance, w.status, u.status AS user_status FROM wallets w LEFT JOIN users u ON u.id = w.owner_user_id WHERE w.id = ?`,
          )
          .bind(lookup.wallet_id)
          .first<{ balance: number; status: string; user_status: string | null }>();
        if (!w || w.status !== "ACTIVE" || (w.user_status !== null && w.user_status !== "ACTIVE")) {
          throw conflict("このウォレットは現在ご利用できません(停止中など)。払い戻していません", "WALLET_INACTIVE");
        }
        throw conflict(`残高が変わっています(現在 ${w.balance})。QRをもう一度読み取ってください。払い戻していません`, "BALANCE_CHANGED");
      }
      return c.json({ ...res.result, replayed: false } satisfies CashOpResult, 201);
    },
  )

  // チャージの訂正(入力誤り)。元の記録は残し、差額を訂正として台帳・現金台帳へ追加する
  .post(
    "/charge/:ledgerId/correct",
    zv("param", z.object({ ledgerId: idSchema })),
    zv(
      "json",
      z.object({
        requestId: requestIdSchema,
        newCashAmount: z.number().int().min(0).max(MAX_CHARGE_YEN),
        reason: z.string().trim().min(1, "訂正の理由を入力してください").max(200),
      }),
    ),
    async (c) => {
      const auth = requireAuth(c);
      const { ledgerId: origId } = c.req.valid("param");
      const b = c.req.valid("json");
      const db = c.env.DB;
      const replay = await tryReplay(db, b.requestId, auth.userId, "CHARGE_CORRECTION", { correctsLedgerId: origId });
      if (replay) return c.json(replay);

      const orig = await db
        .prepare("SELECT id, wallet_id FROM wallet_ledger WHERE id = ? AND kind = 'CHARGE'")
        .bind(origId)
        .first<{ id: string; wallet_id: string }>();
      if (!orig) throw notFound("訂正できるチャージが見つかりません");

      const loadEffective = async () => {
        const u = await db
          .prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM wallet_ledger WHERE id = ? OR corrects_ledger_id = ?")
          .bind(origId, origId)
          .first<{ s: number }>();
        const cash = await db
          .prepare(
            `SELECT COALESCE(SUM(e.amount), 0) AS s FROM cash_events e JOIN wallet_ledger l ON l.id = e.ledger_id
              WHERE l.id = ? OR l.corrects_ledger_id = ?`,
          )
          .bind(origId, origId)
          .first<{ s: number }>();
        return { units: u?.s ?? 0, cash: cash?.s ?? 0 };
      };
      const eff = await loadEffective();

      const currency = await getCurrency(db);
      const newUnits = cashToUnits(b.newCashAmount, currency.yenPerUnit);
      if (newUnits === null) throw badRequest(`${b.newCashAmount.toLocaleString()}円は換算できません`, "BAD_AMOUNT");
      const deltaUnits = newUnits - eff.units;
      const deltaCash = b.newCashAmount - eff.cash;
      if (deltaUnits === 0) throw badRequest("訂正前と同じ金額です", "NO_CHANGE");

      const ledgerId = newId();
      const eventId = newId();
      const now = Date.now();
      try {
        await db.batch([
          db
            .prepare(
              `INSERT INTO wallet_ledger (id, wallet_id, kind, amount, balance_after, ref_type, ref_id, corrects_ledger_id, operator_user_id, reason, idempotency_key, created_at)
               SELECT ?, w.id, 'CHARGE_CORRECTION', ?, w.balance + ?, 'CASH_EVENT', ?, ?, ?, ?, ?, ?
                 FROM wallets w
                WHERE w.id = ? AND w.status IN ('ACTIVE', 'SUSPENDED') AND w.balance + ? >= 0
                  AND (SELECT COALESCE(SUM(amount), 0) FROM wallet_ledger WHERE id = ? OR corrects_ledger_id = ?) = ?`,
            )
            .bind(ledgerId, deltaUnits, deltaUnits, eventId, origId, auth.userId, b.reason, b.requestId, now, orig.wallet_id, deltaUnits, origId, origId, eff.units),
          db
            .prepare(
              `UPDATE wallets SET balance = (SELECT balance_after FROM wallet_ledger WHERE id = ?)
                WHERE id = ? AND EXISTS (${LEDGER_EXISTS_SQL})`,
            )
            .bind(ledgerId, orig.wallet_id, ledgerId),
          db
            .prepare(
              `INSERT INTO cash_events (id, reception_user_id, kind, amount, ledger_id, reason, created_at, request_id)
               SELECT ?, ?, 'CORRECTION', ?, ?, ?, ?, ? WHERE EXISTS (${LEDGER_EXISTS_SQL})`,
            )
            .bind(eventId, auth.userId, deltaCash, ledgerId, b.reason, now, b.requestId, ledgerId),
          auditStmtIfExists(
            db,
            {
              actor: auth,
              action: "cash.charge_correction",
              targetType: "wallet_ledger",
              targetId: origId,
              before: { units: eff.units, cashYen: eff.cash },
              after: { units: newUnits, cashYen: b.newCashAmount, correctionLedgerId: ledgerId },
              reason: b.reason,
            },
            LEDGER_EXISTS_SQL,
            [ledgerId],
          ),
        ]);
      } catch (e) {
        if (isUnique(e)) {
          const again = await tryReplay(db, b.requestId, auth.userId, "CHARGE_CORRECTION", { correctsLedgerId: origId });
          if (again) return c.json(again);
          throw conflict("このリクエストIDはすでに使われています", "REQUEST_ID_REUSED");
        }
        throw e;
      }
      const res = await loadLedgerResult(db, ledgerId);
      if (!res) {
        const now2 = await loadEffective();
        if (now2.units !== eff.units) throw conflict("ほかの操作で内容が変わりました。画面を更新してやり直してください", "CHANGED");
        throw conflict("残高が足りないため訂正できません(すでに使われています)", "INSUFFICIENT_FOR_CORRECTION");
      }
      return c.json({ ...res.result, replayed: false } satisfies CashOpResult, 201);
    },
  )

  // 途中回収: 受付に溜まった現金を金庫などへ移した額の記録
  .post(
    "/cash/drop",
    zv(
      "json",
      z.object({
        requestId: requestIdSchema,
        amount: z.number().int().min(1, "金額を入力してください").max(10_000_000),
        note: z.string().trim().max(200).optional(),
      }),
    ),
    async (c) => {
      const auth = requireAuth(c);
      const b = c.req.valid("json");
      const db = c.env.DB;
      const eventId = newId();
      try {
        await db.batch([
          db
            .prepare(
              `INSERT INTO cash_events (id, reception_user_id, kind, amount, reason, created_at, request_id)
               VALUES (?, ?, 'DROP', ?, ?, ?, ?)`,
            )
            .bind(eventId, auth.userId, b.amount, b.note ?? null, Date.now(), b.requestId),
          auditStmt(db, { actor: auth, action: "cash.drop", targetType: "cash_event", targetId: eventId, after: { cashYen: b.amount }, reason: b.note }),
        ]);
      } catch (e) {
        if (isUnique(e)) {
          const ex = await db
            .prepare("SELECT id, kind, reception_user_id FROM cash_events WHERE request_id = ?")
            .bind(b.requestId)
            .first<{ id: string; kind: string; reception_user_id: string }>();
          if (ex && ex.kind === "DROP" && ex.reception_user_id === auth.userId) return c.json({ eventId: ex.id, replayed: true });
          throw conflict("このリクエストIDはすでに別の操作で使われています", "REQUEST_ID_REUSED");
        }
        throw e;
      }
      return c.json({ eventId, replayed: false }, 201);
    },
  );
