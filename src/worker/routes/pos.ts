import { Hono } from "hono";
import { z } from "zod";
import type { PaySession, PayStatus, Quote } from "@shared/api";
import type { AppEnv } from "../env";
import { auditStmt, auditStmtIfExists } from "../lib/audit";
import { bumpCatalogStmt, buildPosCatalog } from "../lib/catalog";
import { cardUsableSql } from "../lib/cards";
import { sha256Hex, verifyPin } from "../lib/crypto";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors";
import { newId } from "../lib/ids";
import { loadPayResult, orderNo, quoteCart, type CartQuote } from "../lib/order";
import { CARD_QR_PATTERN, WALLET_QR_PATTERN } from "../lib/qr";
import { getOperations } from "../lib/settings";
import { zv as zValidator } from "../lib/validate";
import { assertShopAccess, requireAuth, requireRole } from "../middleware/auth";

const shopParam = zValidator("param", z.object({ shopId: z.string().length(26) }));
const sessionParam = zValidator("param", z.object({ shopId: z.string().length(26), sessionId: z.string().length(26) }));
const requestIdSchema = z
  .string()
  .min(16, "リクエストIDが短すぎます")
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "リクエストIDの形式が正しくありません");
const cartSchema = z
  .array(
    z
      .object({
        productId: z.string().length(26).optional(),
        setId: z.string().length(26).optional(),
        picks: z.record(z.string().length(26), z.array(z.string().length(26)).max(10)).optional(),
        quantity: z.number().int().min(1, "数量は1以上にしてください").max(99, "1商品あたり99個までです"),
      })
      .refine((i) => (i.productId ? !i.setId && !i.picks : !!i.setId), "商品かセットのどちらか一方を指定してください"),
  )
  .min(1, "カートが空です")
  .max(30, "一度に会計できるのは30種類までです");

/** セットの売り切れ手動切り替えなどに使うパラメータ */
const setParam = zValidator("param", z.object({ shopId: z.string().length(26), setId: z.string().length(26) }));

/** 見積もりを画面へ返す形にする(確定時の照合用の内部値は含めない) */
const publicQuote = ({ raw: _raw, needs: _needs, applied: _applied, ...q }: CartQuote): Quote => q;

const couponSchema = z.string().trim().max(40).optional();

const productParam = zValidator("param", z.object({ shopId: z.string().length(26), productId: z.string().length(26) }));

/** 店員・店舗責任者向けの POS API(会計画面が使う)。自店舗のものだけ操作できる */
export const posRoutes = new Hono<AppEnv>()
  .use("*", requireRole("CLERK", "SHOP_MANAGER", "ADMIN"))

  // 商品一覧(値下げ後の価格つき)。`sig` に前回の署名を付けると、変わっていなければ changed:false だけ返す
  .get("/:shopId/catalog", shopParam, zValidator("query", z.object({ sig: z.string().max(60).optional() })), async (c) => {
    const auth = requireAuth(c);
    const { shopId } = c.req.valid("param");
    assertShopAccess(auth, shopId);
    c.header("Cache-Control", "no-store");
    return c.json(await buildPosCatalog(c.env.DB, shopId, c.req.valid("query").sig));
  })

  // 手動の売り切れ/販売再開。店員も行える(仕様 v0.2 §11.2)
  .post(
    "/:shopId/products/:productId/sold-out",
    productParam,
    zValidator("json", z.object({ soldOut: z.boolean() })),
    async (c) => {
      const auth = requireAuth(c);
      const { shopId, productId } = c.req.valid("param");
      assertShopAccess(auth, shopId);
      const { soldOut } = c.req.valid("json");
      const db = c.env.DB;
      const p = await db
        .prepare("SELECT manual_sold_out FROM products WHERE id = ? AND shop_id = ? AND status <> 'ARCHIVED'")
        .bind(productId, shopId)
        .first<{ manual_sold_out: number }>();
      if (!p) throw notFound("商品が見つかりません");
      await db.batch([
        db
          .prepare("UPDATE products SET manual_sold_out = ?, updated_at = ? WHERE id = ? AND shop_id = ?")
          .bind(soldOut ? 1 : 0, Date.now(), productId, shopId),
        bumpCatalogStmt(db, shopId),
        auditStmtIfExists(
          db,
          {
            actor: auth,
            action: soldOut ? "product.sold_out" : "product.resume_sale",
            targetType: "product",
            targetId: productId,
            before: { manualSoldOut: p.manual_sold_out === 1 },
            after: { manualSoldOut: soldOut },
          },
          "SELECT 1 FROM products WHERE id = ? AND manual_sold_out = ?",
          [productId, soldOut ? 1 : 0],
        ),
      ]);
      return c.json({ ok: true });
    },
  )

  // セットの手動売り切れ/販売再開(店員も行える)
  .post("/:shopId/sets/:setId/sold-out", setParam, zValidator("json", z.object({ soldOut: z.boolean() })), async (c) => {
    const auth = requireAuth(c);
    const { shopId, setId } = c.req.valid("param");
    assertShopAccess(auth, shopId);
    const { soldOut } = c.req.valid("json");
    const db = c.env.DB;
    const cur = await db
      .prepare("SELECT manual_sold_out FROM sets WHERE id = ? AND shop_id = ? AND status <> 'ARCHIVED'")
      .bind(setId, shopId)
      .first<{ manual_sold_out: number }>();
    if (!cur) throw notFound("セットが見つかりません");
    await db.batch([
      db.prepare("UPDATE sets SET manual_sold_out = ?, updated_at = ? WHERE id = ? AND shop_id = ?").bind(soldOut ? 1 : 0, Date.now(), setId, shopId),
      bumpCatalogStmt(db, shopId),
      auditStmtIfExists(
        db,
        {
          actor: auth,
          action: soldOut ? "set.sold_out" : "set.resume_sale",
          targetType: "set",
          targetId: setId,
          before: { manualSoldOut: cur.manual_sold_out === 1 },
          after: { manualSoldOut: soldOut },
        },
        "SELECT 1 FROM sets WHERE id = ? AND manual_sold_out = ?",
        [setId, soldOut ? 1 : 0],
      ),
    ]);
    return c.json({ ok: true });
  })

  // ---------- 決済 ----------
  // 会計前の見積もり(割引・クーポンの確認用)。QRは読み取らない。お客様ごとの利用回数の上限は、読み取り時に確認する
  .post("/:shopId/pay/quote", shopParam, zValidator("json", z.object({ items: cartSchema, couponCode: couponSchema })), async (c) => {
    const auth = requireAuth(c);
    const { shopId } = c.req.valid("param");
    assertShopAccess(auth, shopId);
    const { items, couponCode } = c.req.valid("json");
    c.header("Cache-Control", "no-store");
    return c.json(publicQuote(await quoteCart(c.env.DB, shopId, items, Date.now(), couponCode || null)));
  })

  // お客様のQRを読み取る。QRはここで消費され、決済セッション(猶予は設定値、既定5分)ができる。
  // カートに買えない商品があるときは、QRを消費する前にエラーにする(お客様のQRを無駄にしない)
  .post(
    "/:shopId/pay/scan",
    shopParam,
    zValidator("json", z.object({ token: z.string().trim().max(100), items: cartSchema, couponCode: couponSchema })),
    async (c) => {
      const auth = requireAuth(c);
      const { shopId } = c.req.valid("param");
      assertShopAccess(auth, shopId);
      const { token, items, couponCode: rawCoupon } = c.req.valid("json");
      const couponCode = rawCoupon || null;
      const isCard = CARD_QR_PATTERN.test(token);
      if (!isCard && !WALLET_QR_PATTERN.test(token)) throw badRequest("お客様のQRではありません", "INVALID_QR");
      const db = c.env.DB;
      const now = Date.now();
      const shop = await db.prepare("SELECT status FROM shops WHERE id = ?").bind(shopId).first<{ status: string }>();
      if (!shop) throw notFound("店舗が見つかりません");
      if (shop.status !== "ACTIVE") throw forbidden("この店舗は現在会計できません", "SHOP_INACTIVE");

      let quote = await quoteCart(db, shopId, items, now, couponCode);
      if (quote.problems.length > 0) throw conflict(quote.problems[0].message, "CART_UNAVAILABLE", { quote: publicQuote(quote) });
      /** お客様(ウォレット)が分かった時点で、クーポンを本人の利用回数も含めて確かめ直す。QRを消費する前に断る */
      const recheck = async (walletId: string) => {
        if (couponCode) quote = await quoteCart(db, shopId, items, now, couponCode, walletId);
        if (quote.couponError) throw conflict(quote.couponError, "COUPON_INVALID", { quote: publicQuote(quote) });
        if (quote.total <= 0) throw badRequest("割引後の合計が0のため、決済は不要です", "ZERO_TOTAL");
      };
      if (quote.couponError) throw conflict(quote.couponError, "COUPON_INVALID", { quote: publicQuote(quote) });
      if (quote.total <= 0) throw badRequest("合計が0のため、決済は不要です", "ZERO_TOTAL");

      const hash = await sha256Hex(token);
      const sessionId = newId(now);
      const { paymentSessionSeconds } = await getOperations(db);
      const expiresAt = now + paymentSessionSeconds * 1000;
      const cart = JSON.stringify(items);

      // 物理カード: QRは固定で消費しない。カードが使えるときだけ決済セッションを作り、確定時にPIN(4桁)を確認する
      if (isCard) {
        const card = await db
          .prepare(
            `SELECT c.id, c.status, c.expires_at, c.nickname, c.display_no, c.wallet_id, w.status AS wstatus, w.balance
               FROM cards c LEFT JOIN wallets w ON w.id = c.wallet_id WHERE c.qr_token_hash = ?`,
          )
          .bind(hash)
          .first<{ id: string; status: string; expires_at: number | null; nickname: string | null; display_no: string; wallet_id: string | null; wstatus: string | null; balance: number | null }>();
        if (!card) throw badRequest("このカードは登録されていないか、無効になっています", "INVALID_QR");
        if (card.status === "ISSUED") throw forbidden("このカードはまだ有効化されていません。受付にお問い合わせください", "CARD_INACTIVE");
        if (card.status === "SUSPENDED") throw forbidden("このカードは一時停止中です。受付にお問い合わせください", "CARD_INACTIVE");
        if (card.status !== "ACTIVE") throw forbidden("このカードは使えません", "CARD_INACTIVE");
        if (card.expires_at !== null && card.expires_at <= now) throw forbidden("このカードは有効期限が切れています", "CARD_EXPIRED");
        if (card.wstatus !== "ACTIVE") throw forbidden("このカードのウォレットは現在ご利用できません", "WALLET_INACTIVE");
        await recheck(card.wallet_id!);
        const res = await db.batch([
          db
            .prepare(
              `INSERT INTO payment_sessions (id, shop_id, clerk_user_id, wallet_id, pay_source, card_id, cart_json, coupon_code, status, created_at, expires_at)
               SELECT ?, ?, ?, c.wallet_id, 'CARD', c.id, ?, ?, 'OPEN', ?, ? FROM cards c
                WHERE c.qr_token_hash = ? AND ${cardUsableSql("c")}`,
            )
            .bind(sessionId, shopId, auth.userId, cart, couponCode ? quote.applied.find((a) => a.couponCode)?.couponCode ?? null : null, now, expiresAt, hash, now),
        ]);
        if ((res[0].meta.changes ?? 0) !== 1) throw forbidden("このカードは使えません。もう一度読み取ってください", "CARD_INACTIVE");
        await db.batch([
          auditStmt(db, { actor: auth, action: "payment.scan", targetType: "payment_session", targetId: sessionId, after: { shopId, total: quote.total, card: card.display_no } }),
        ]);
        return c.json({
          sessionId,
          expiresAt,
          customer: { nickname: card.nickname, balance: card.balance ?? 0 },
          quote: publicQuote(quote),
          shortfall: Math.max(0, quote.total - (card.balance ?? 0)),
          card: { displayNo: card.display_no },
        } satisfies PaySession);
      }

      // 持ち主のアカウントが停止中なら、QRを消費せずに断る
      const owner = await db
        .prepare(
          `SELECT w.id AS wallet_id, w.status AS wstatus, u.status AS ustatus FROM pay_qr_tokens t JOIN wallets w ON w.id = t.wallet_id
             LEFT JOIN users u ON u.id = w.owner_user_id WHERE t.token_hash = ?`,
        )
        .bind(hash)
        .first<{ wallet_id: string; wstatus: string; ustatus: string | null }>();
      if (owner && (owner.wstatus !== "ACTIVE" || (owner.ustatus !== null && owner.ustatus !== "ACTIVE"))) {
        throw forbidden("お客様のご利用が停止されています。受付にお問い合わせください", "WALLET_INACTIVE");
      }
      if (owner) await recheck(owner.wallet_id);

      const res = await db.batch([
        db
          .prepare(
            `UPDATE pay_qr_tokens SET consumed_at = ?, consumed_by_user_id = ?
              WHERE token_hash = ? AND consumed_at IS NULL AND invalidated_at IS NULL AND expires_at > ?`,
          )
          .bind(now, auth.userId, hash, now),
        db
          .prepare(
            `INSERT INTO payment_sessions (id, shop_id, clerk_user_id, wallet_id, pay_source, cart_json, coupon_code, status, created_at, expires_at)
             SELECT ?, ?, ?, t.wallet_id, 'PHONE_QR', ?, ?, 'OPEN', ?, ? FROM pay_qr_tokens t
              WHERE t.token_hash = ? AND t.consumed_at = ? AND t.consumed_by_user_id = ?`,
          )
          .bind(sessionId, shopId, auth.userId, cart, quote.applied.find((a) => a.couponCode)?.couponCode ?? null, now, expiresAt, hash, now, auth.userId),
      ]);
      if ((res[1].meta.changes ?? 0) !== 1) {
        const t = await db
          .prepare("SELECT consumed_at, invalidated_at FROM pay_qr_tokens WHERE token_hash = ?")
          .bind(hash)
          .first<{ consumed_at: number | null; invalidated_at: number | null }>();
        if (!t) throw badRequest("このQRは無効です", "INVALID_QR");
        if (t.consumed_at !== null) throw badRequest("このQRはすでに読み取られています。新しいQRを表示してもらってください", "QR_USED");
        if (t.invalidated_at !== null) throw badRequest("新しいQRが作られたため、このQRは使えません", "QR_REPLACED");
        throw badRequest("QRの有効期限が切れています。新しいQRを表示してもらってください", "QR_EXPIRED");
      }

      const w = await db
        .prepare("SELECT w.balance, u.nickname FROM payment_sessions s JOIN wallets w ON w.id = s.wallet_id LEFT JOIN users u ON u.id = w.owner_user_id WHERE s.id = ?")
        .bind(sessionId)
        .first<{ balance: number; nickname: string | null }>();
      await db.batch([
        auditStmt(db, { actor: auth, action: "payment.scan", targetType: "payment_session", targetId: sessionId, after: { shopId, total: quote.total } }),
      ]);
      return c.json({
        sessionId,
        expiresAt,
        customer: { nickname: w?.nickname ?? null, balance: w?.balance ?? 0 },
        quote: publicQuote(quote),
        shortfall: Math.max(0, quote.total - (w?.balance ?? 0)),
      } satisfies PaySession);
    },
  )

  // 決済セッションの状態(結果が分からなくなったときの照会。確定済みなら注文の結果も返す)
  .get("/:shopId/pay/:sessionId", sessionParam, async (c) => {
    const auth = requireAuth(c);
    const { shopId, sessionId } = c.req.valid("param");
    assertShopAccess(auth, shopId);
    c.header("Cache-Control", "no-store");
    const s = await c.env.DB
      .prepare("SELECT status, expires_at, order_id FROM payment_sessions WHERE id = ? AND shop_id = ?")
      .bind(sessionId, shopId)
      .first<{ status: PayStatus["status"]; expires_at: number; order_id: string | null }>();
    if (!s) throw notFound("決済が見つかりません");
    const expired = s.status === "OPEN" && s.expires_at < Date.now();
    return c.json({
      status: expired ? "EXPIRED" : s.status,
      expiresAt: s.expires_at,
      result: s.order_id ? await loadPayResult(c.env.DB, s.order_id) : null,
    } satisfies PayStatus);
  })

  // 支払いの確定。サーバーが価格を再計算し、画面で確認した合計(expectedTotal)と違えば確定せず新しい見積もりを返す。
  // 残高・在庫・セッションの確定・注文・台帳はすべて1つのトランザクション。同じ requestId の再送は元の結果を返す
  .post(
    "/:shopId/pay/:sessionId/commit",
    sessionParam,
    zValidator("json", z.object({ requestId: requestIdSchema, expectedTotal: z.number().int().min(1), pin: z.string().regex(/^[0-9]{4}$/, "PINは4桁の数字です").optional() })),
    async (c) => {
      const auth = requireAuth(c);
      const { shopId, sessionId } = c.req.valid("param");
      assertShopAccess(auth, shopId);
      const { requestId, expectedTotal, pin } = c.req.valid("json");
      const db = c.env.DB;

      // 同じ requestId の再送 → 元の結果(新しい決済は作らない)
      const prior = await db
        .prepare("SELECT id FROM orders WHERE idempotency_key = ?")
        .bind(requestId)
        .first<{ id: string }>();
      if (prior) {
        const linked = await db
          .prepare("SELECT 1 FROM payment_sessions WHERE id = ? AND shop_id = ? AND order_id = ?")
          .bind(sessionId, shopId, prior.id)
          .first();
        if (!linked) throw conflict("このリクエストIDは別の決済で使われています", "REQUEST_ID_REUSED");
        return c.json({ ...(await loadPayResult(db, prior.id))!, replayed: true });
      }

      const s = await db
        .prepare("SELECT wallet_id, card_id, cart_json, coupon_code, status, expires_at, order_id FROM payment_sessions WHERE id = ? AND shop_id = ?")
        .bind(sessionId, shopId)
        .first<{ wallet_id: string; card_id: string | null; cart_json: string; coupon_code: string | null; status: string; expires_at: number; order_id: string | null }>();
      if (!s) throw notFound("決済が見つかりません", "SESSION_NOT_FOUND");
      if (s.status === "COMMITTED") throw conflict("この決済はすでに確定しています", "SESSION_DONE");
      if (s.status === "CANCELLED") throw conflict("この決済は取り消されています。QRを読み取り直してください", "SESSION_CANCELLED");
      const now = Date.now();
      if (s.status === "EXPIRED" || s.expires_at < now) {
        throw conflict("決済の有効時間が切れました。お客様のQRを読み取り直してください", "SESSION_EXPIRED");
      }

      // 物理カードの支払いはPINが必要。PINが違えば確定せず、セッションはそのまま(画面側で3回まで入力できる)
      let pinHash = "-";
      if (s.card_id) {
        if (!pin) throw badRequest("PINを入力してください", "PIN_REQUIRED");
        const card = await db
          .prepare("SELECT status, expires_at, pin_hash FROM cards WHERE id = ?")
          .bind(s.card_id)
          .first<{ status: string; expires_at: number | null; pin_hash: string | null }>();
        if (!card || card.status !== "ACTIVE" || (card.expires_at !== null && card.expires_at <= now)) {
          throw forbidden("このカードは使えなくなりました。受付にお問い合わせください", "CARD_INACTIVE");
        }
        if (!c.env.PIN_PEPPER) throw conflict("PIN_PEPPER が設定されていないため、カードを使えません", "PEPPER_MISSING");
        if (!(await verifyPin(pin, card.pin_hash, c.env.PIN_PEPPER))) {
          await db.batch([auditStmt(db, { actor: auth, action: "payment.pin_failed", targetType: "payment_session", targetId: sessionId })]);
          throw forbidden("PINが違います", "PIN_INVALID");
        }
        pinHash = card.pin_hash!;
      }

      // 確定の瞬間の価格・値下げ・在庫で見積もり直す
      const quote = await quoteCart(db, shopId, JSON.parse(s.cart_json), now, s.coupon_code, s.wallet_id);
      if (quote.problems.length > 0) throw conflict(quote.problems[0].message, "CART_UNAVAILABLE", { quote: publicQuote(quote) });
      if (quote.couponError) throw conflict(quote.couponError, "COUPON_INVALID", { quote: publicQuote(quote) });
      if (quote.total !== expectedTotal) {
        throw conflict("価格が変わりました。新しい合計を確認してください", "PRICE_CHANGED", { quote: publicQuote(quote) });
      }
      const bal = await db.prepare("SELECT balance FROM wallets WHERE id = ?").bind(s.wallet_id).first<{ balance: number }>();
      if ((bal?.balance ?? 0) < quote.total) {
        throw conflict(`残高が足りません(不足 ${quote.total - (bal?.balance ?? 0)})`, "INSUFFICIENT_BALANCE", {
          shortfall: quote.total - (bal?.balance ?? 0),
        });
      }

      const orderId = newId(now);
      const ledgerId = newId(now);
      const orderExists = "EXISTS (SELECT 1 FROM orders WHERE id = ?)";
      const cutGuard = `COALESCE((SELECT id FROM shop_price_cuts WHERE shop_id = ? AND status = 'ACTIVE'
          AND (starts_at IS NULL OR starts_at <= ?) AND (ends_at IS NULL OR ends_at > ?)), '-') = ?`;

      // 見積もり時点から商品・セット・値下げ・顧客・店舗が変わっていないことの確認(SQL のガード)。
      // D1 は1文あたりの束縛値が100個までなので、ガードは小分けにして並べる。
      // 先頭の文が決済セッションを COMMITTED にし、続く文は条件を満たさないとき OPEN へ戻す。注文の作成は COMMITTED が前提
      const guards: { sql: string; args: (string | number)[] }[] = [];
      const needBy = new Map(quote.needs.map((n) => [n.productId, n]));
      for (const l of quote.raw) {
        if (l.kind === "PRODUCT") {
          guards.push({
            sql: `EXISTS (SELECT 1 FROM products p WHERE p.id = ? AND p.shop_id = ? AND p.price = ? AND p.discountable = ?)`,
            args: [l.productId, shopId, l.listUnitPrice, l.discountable ? 1 : 0],
          });
        } else {
          guards.push({
            sql: `EXISTS (SELECT 1 FROM sets s WHERE s.id = ? AND s.shop_id = ? AND s.status = 'ACTIVE' AND s.manual_sold_out = 0 AND s.price = ? AND s.discountable = ?)`,
            args: [l.productId, shopId, l.listUnitPrice, l.discountable ? 1 : 0],
          });
          for (const r of l.pickRows ?? []) {
            guards.push({
              sql: `EXISTS (SELECT 1 FROM set_segment_items i JOIN set_segments g ON g.id = i.segment_id
                     WHERE g.set_id = ? AND i.segment_id = ? AND i.product_id = ? AND i.surcharge = ?)`,
              args: [l.productId, r.segmentId, r.productId, r.surcharge],
            });
          }
        }
      }
      for (const n of quote.needs) {
        const modeOk = [n.single > 0 ? "p.sale_mode <> 'SET_ONLY'" : "", n.inSet > 0 ? "p.sale_mode <> 'SINGLE_ONLY'" : ""].filter(Boolean).join(" AND ");
        guards.push({
          sql: `EXISTS (SELECT 1 FROM products p WHERE p.id = ? AND p.shop_id = ? AND p.status = 'ACTIVE' AND ${modeOk}
                 AND p.manual_sold_out = 0 AND (p.track_stock = 0 OR p.stock_qty >= ?))`,
          args: [n.productId, shopId, n.single + n.inSet],
        });
      }
      // 適用した割引・クーポンが、見積もり時点のまま有効であること(停止・上限到達・設定変更があれば確定しない)
      for (const a of quote.applied) {
        guards.push({
          sql: `EXISTS (SELECT 1 FROM discounts d WHERE d.id = ? AND d.status = 'ACTIVE' AND d.method = ? AND d.value = ?
                 AND COALESCE(d.max_discount_amount, -1) = ? AND COALESCE(d.min_order_amount, -1) = ?
                 AND (d.starts_at IS NULL OR d.starts_at <= ?) AND (d.ends_at IS NULL OR d.ends_at > ?))`,
          args: [a.discountId, a.rule.method, a.rule.value, a.rule.max ?? -1, a.rule.min ?? -1, now, now],
        });
        if (a.couponId) {
          guards.push({
            sql: `EXISTS (SELECT 1 FROM coupons cp WHERE cp.id = ? AND cp.status = 'ACTIVE' AND (cp.total_limit IS NULL OR cp.used_count < cp.total_limit)
                   AND (cp.per_wallet_limit IS NULL OR (SELECT COUNT(*) FROM coupon_redemptions r WHERE r.coupon_id = cp.id AND r.wallet_id = ? AND r.status = 'USED') < cp.per_wallet_limit))`,
            args: [a.couponId, s.wallet_id],
          });
        }
      }
      const chunks: { sql: string[]; args: (string | number)[] }[] = [];
      for (const g of guards) {
        let cur = chunks[chunks.length - 1];
        if (!cur || cur.args.length + g.args.length > 80) chunks.push((cur = { sql: [], args: [] }));
        cur.sql.push(g.sql);
        cur.args.push(...g.args);
      }

      const stmts: D1PreparedStatement[] = [
        db
          .prepare(
            `UPDATE payment_sessions SET status = 'COMMITTED'
              WHERE id = ? AND shop_id = ? AND status = 'OPEN' AND expires_at >= ?
                AND EXISTS (SELECT 1 FROM shops WHERE id = ? AND status = 'ACTIVE')
                AND EXISTS (SELECT 1 FROM wallets w WHERE w.id = payment_sessions.wallet_id AND w.status = 'ACTIVE'
                      AND (w.owner_user_id IS NULL OR EXISTS (SELECT 1 FROM users u WHERE u.id = w.owner_user_id AND u.status = 'ACTIVE')))
                AND ${cutGuard}
                AND (payment_sessions.card_id IS NULL OR EXISTS (SELECT 1 FROM cards cd WHERE cd.id = payment_sessions.card_id AND cd.pin_hash = ? AND ${cardUsableSql("cd")}))`,
          )
          .bind(sessionId, shopId, now, shopId, shopId, now, now, quote.cut?.id ?? "-", pinHash, now),
        ...chunks.map((ch) =>
          db
            .prepare(
              `UPDATE payment_sessions SET status = 'OPEN' WHERE id = ? AND status = 'COMMITTED' AND order_id IS NULL AND NOT (${ch.sql.join(" AND ")})`,
            )
            .bind(sessionId, ...ch.args),
        ),
      ];
      const orderIdx = stmts.length;
      stmts.push(
        db
          .prepare(
            `INSERT INTO orders (id, order_no, shop_id, clerk_user_id, wallet_id, pay_source, subtotal, discount_total, total_paid, status, idempotency_key, paid_at, card_id)
             SELECT ?, ?, ?, ?, s.wallet_id, s.pay_source, ?, ?, ?, 'PAID', ?, ?, s.card_id FROM payment_sessions s
              WHERE s.id = ? AND s.status = 'COMMITTED' AND s.order_id IS NULL`,
          )
          .bind(orderId, orderNo(orderId), shopId, auth.userId, quote.subtotal, quote.discountTotal, quote.total, requestId, now, sessionId),
        // 残高の減算。足りなければ CHECK 制約が全体を巻き戻す
        db
          .prepare(`UPDATE wallets SET balance = balance - ? WHERE id = ? AND ${orderExists}`)
          .bind(quote.total, s.wallet_id, orderId),
        db
          .prepare(
            `INSERT INTO wallet_ledger (id, wallet_id, kind, amount, balance_after, ref_type, ref_id, operator_user_id, idempotency_key, created_at)
             SELECT ?, w.id, 'PAYMENT', ?, w.balance, 'ORDER', ?, ?, ?, ? FROM wallets w WHERE w.id = ? AND ${orderExists}`,
          )
          .bind(ledgerId, -quote.total, orderId, auth.userId, `pay:${requestId}`, now, s.wallet_id, orderId),
        db.prepare(`UPDATE orders SET ledger_id = ? WHERE id = ? AND ${orderExists}`).bind(ledgerId, orderId, orderId),
        db
          .prepare(`UPDATE payment_sessions SET order_id = ? WHERE id = ? AND ${orderExists}`)
          .bind(orderId, sessionId, orderId),
      );
      quote.raw.forEach((l, i) => {
        const lineId = newId(now);
        const discounted = l.unitPrice < l.listUnitPrice;
        stmts.push(
          db
            .prepare(
              `INSERT INTO order_lines (id, order_id, line_no, kind, product_id, set_id, name_snapshot, unit_price, quantity, surcharge_total, line_subtotal, discount_allocated, line_paid,
                                        list_unit_price, price_cut_id, price_cut_name)
               SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${orderExists}`,
            )
            .bind(
              lineId, orderId, i + 1, l.kind,
              l.kind === "PRODUCT" ? l.productId : null,
              l.kind === "SET" ? l.productId : null,
              l.name, l.unitPrice, l.quantity, l.surchargeTotal, l.lineTotal, l.discountAllocated, l.lineTotal - l.discountAllocated, l.listUnitPrice,
              discounted ? (quote.cut?.id ?? null) : null,
              discounted ? (quote.cut?.name ?? null) : null,
              orderId,
            ),
        );
        // セットの内訳(数量はセット数ぶんの合計。追加料金は1セットあたり)
        for (const r of l.pickRows ?? []) {
          stmts.push(
            db
              .prepare(
                `INSERT INTO order_line_components (id, order_line_id, segment_name_snapshot, product_id, name_snapshot, quantity, surcharge)
                 SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${orderExists}`,
              )
              .bind(newId(now), lineId, r.segmentName, r.productId, r.name, r.count * l.quantity, r.surcharge, orderId),
          );
        }
      });
      // 適用した割引の記録(計算順)と、クーポンの使用済み記録
      quote.applied.forEach((a, i) => {
        stmts.push(
          db
            .prepare(
              `INSERT INTO order_discounts (id, order_id, apply_seq, kind, discount_id, coupon_id, name_snapshot, amount) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${orderExists}`,
            )
            .bind(newId(now), orderId, i + 1, a.kind, a.discountId, a.couponId, a.name, a.amount, orderId),
        );
        if (a.couponId) {
          stmts.push(
            db
              .prepare(`INSERT INTO coupon_redemptions (id, coupon_id, order_id, wallet_id, amount, status, created_at) SELECT ?, ?, ?, ?, ?, 'USED', ? WHERE ${orderExists}`)
              .bind(newId(now), a.couponId, orderId, s.wallet_id, a.amount, now, orderId),
            db.prepare(`UPDATE coupons SET used_count = used_count + 1 WHERE id = ? AND ${orderExists}`).bind(a.couponId, orderId),
          );
        }
      });
      // 在庫の減算(単品ぶんは SALE、セット内ぶんは SET_SALE として記録)。足りなければ CHECK 制約が全体を巻き戻す(売り越しを DB が拒否)
      for (const n of quote.needs) {
        if (!needBy.get(n.productId)?.trackStock) continue;
        for (const [qty, reason] of [[n.single, "SALE"], [n.inSet, "SET_SALE"]] as const) {
          if (qty <= 0) continue;
          stmts.push(
            db.prepare(`UPDATE products SET stock_qty = stock_qty - ?, updated_at = ? WHERE id = ? AND track_stock = 1 AND ${orderExists}`).bind(qty, now, n.productId, orderId),
            db
              .prepare(
                `INSERT INTO stock_movements (id, product_id, delta, qty_after, reason, ref_type, ref_id, operator_user_id, created_at)
                 SELECT ?, p.id, ?, p.stock_qty, ?, 'ORDER', ?, ?, ? FROM products p WHERE p.id = ? AND p.track_stock = 1 AND ${orderExists}`,
              )
              .bind(newId(now), -qty, reason, orderId, auth.userId, now, n.productId, orderId),
          );
        }
      }
      stmts.push(
        bumpCatalogStmt(db, shopId),
        auditStmtIfExists(
          db,
          { actor: auth, action: "payment.commit", targetType: "order", targetId: orderId, after: { sessionId, total: quote.total, discountTotal: quote.discountTotal, walletId: s.wallet_id } },
          "SELECT 1 FROM orders WHERE id = ?",
          [orderId],
        ),
      );

      let results: D1Result[];
      try {
        results = await db.batch(stmts);
      } catch (e) {
        const msg = String(e);
        // 同時に別の端末が同じ requestId で確定した場合など
        if (msg.includes("idempotency_key")) {
          const again = await db.prepare("SELECT id FROM orders WHERE idempotency_key = ?").bind(requestId).first<{ id: string }>();
          if (again) return c.json({ ...(await loadPayResult(db, again.id))!, replayed: true });
        }
        if (msg.includes("balance")) throw conflict("残高が足りません。もう一度確認してください", "INSUFFICIENT_BALANCE");
        if (msg.includes("stock_qty")) throw conflict("在庫が足りなくなりました。もう一度確認してください", "OUT_OF_STOCK");
        throw e;
      }

      if ((results[orderIdx].meta.changes ?? 0) === 0) {
        // 確定できなかった(誰かが先に確定・取り消した、期限切れ、見積もりのあとに価格や売り切れが変わった)
        const now2 = Date.now();
        const cur = await db.prepare("SELECT status, order_id FROM payment_sessions WHERE id = ?").bind(sessionId).first<{ status: string; order_id: string | null }>();
        if (cur?.status === "COMMITTED" && cur.order_id) return c.json({ ...(await loadPayResult(db, cur.order_id))!, replayed: true });
        if (cur?.status !== "OPEN") throw conflict("この決済は確定できません。状態を確認してください", "SESSION_DONE");
        if (s.card_id) {
          const still = await db
            .prepare(`SELECT 1 FROM cards c WHERE c.id = ? AND c.pin_hash = ? AND ${cardUsableSql("c")}`)
            .bind(s.card_id, pinHash, now2)
            .first();
          if (!still) throw forbidden("このカードは使えなくなりました。受付にお問い合わせください", "CARD_INACTIVE");
        }
        const fresh = await quoteCart(db, shopId, JSON.parse(s.cart_json), now2, s.coupon_code, s.wallet_id);
        throw conflict("価格や在庫が変わりました。もう一度確認してください", "PRICE_CHANGED", { quote: publicQuote(fresh) });
      }
      return c.json(await loadPayResult(db, orderId));
    },
  )

  // 取り消し(お客様の都合・合計の間違いなど)。QRは消費済みなので、お客様は新しいQRを表示し直す
  .post("/:shopId/pay/:sessionId/cancel", sessionParam, async (c) => {
    const auth = requireAuth(c);
    const { shopId, sessionId } = c.req.valid("param");
    assertShopAccess(auth, shopId);
    const db = c.env.DB;
    const now = Date.now();
    await db.batch([
      db.prepare("UPDATE payment_sessions SET status = 'CANCELLED' WHERE id = ? AND shop_id = ? AND status = 'OPEN'").bind(sessionId, shopId),
      auditStmtIfExists(db, { actor: auth, action: "payment.cancel", targetType: "payment_session", targetId: sessionId }, "SELECT 1 FROM payment_sessions WHERE id = ? AND status = 'CANCELLED'", [sessionId]),
    ]);
    void now;
    const s = await db.prepare("SELECT status FROM payment_sessions WHERE id = ? AND shop_id = ?").bind(sessionId, shopId).first<{ status: string }>();
    if (!s) throw notFound("決済が見つかりません");
    if (s.status === "COMMITTED") throw conflict("すでに支払いが確定しています", "SESSION_DONE");
    return c.json({ ok: true });
  });
