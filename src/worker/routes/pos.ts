import { Hono } from "hono";
import { z } from "zod";
import type { PaySession, PayStatus, Quote } from "@shared/api";
import type { AppEnv } from "../env";
import { auditStmt, auditStmtIfExists } from "../lib/audit";
import { bumpCatalogStmt, buildPosCatalog } from "../lib/catalog";
import { sha256Hex } from "../lib/crypto";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors";
import { newId } from "../lib/ids";
import { loadPayResult, orderNo, quoteCart, type CartQuote } from "../lib/order";
import { WALLET_QR_PATTERN } from "../lib/qr";
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
  .array(z.object({ productId: z.string().length(26), quantity: z.number().int().min(1, "数量は1以上にしてください").max(99, "1商品あたり99個までです") }))
  .min(1, "カートが空です")
  .max(30, "一度に会計できるのは30種類までです");

/** 見積もりを画面へ返す形にする(確定時の照合用の内部値は含めない) */
const publicQuote = ({ raw: _raw, ...q }: CartQuote): Quote => q;

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

  // ---------- 決済 ----------
  // お客様のQRを読み取る。QRはここで消費され、決済セッション(猶予は設定値、既定5分)ができる。
  // カートに買えない商品があるときは、QRを消費する前にエラーにする(お客様のQRを無駄にしない)
  .post(
    "/:shopId/pay/scan",
    shopParam,
    zValidator("json", z.object({ token: z.string().trim().max(100), items: cartSchema })),
    async (c) => {
      const auth = requireAuth(c);
      const { shopId } = c.req.valid("param");
      assertShopAccess(auth, shopId);
      const { token, items } = c.req.valid("json");
      if (!WALLET_QR_PATTERN.test(token)) throw badRequest("お客様のQRではありません", "INVALID_QR");
      const db = c.env.DB;
      const now = Date.now();
      const shop = await db.prepare("SELECT status FROM shops WHERE id = ?").bind(shopId).first<{ status: string }>();
      if (!shop) throw notFound("店舗が見つかりません");
      if (shop.status !== "ACTIVE") throw forbidden("この店舗は現在会計できません", "SHOP_INACTIVE");

      const quote = await quoteCart(db, shopId, items, now);
      if (quote.problems.length > 0) throw conflict(quote.problems[0].message, "CART_UNAVAILABLE", { quote: publicQuote(quote) });
      if (quote.total <= 0) throw badRequest("合計が0のため、決済は不要です", "ZERO_TOTAL");

      const hash = await sha256Hex(token);
      const sessionId = newId(now);
      const { paymentSessionSeconds } = await getOperations(db);
      const expiresAt = now + paymentSessionSeconds * 1000;
      const cart = JSON.stringify(quote.lines.map((l) => ({ productId: l.productId, quantity: l.quantity })));

      // 持ち主のアカウントが停止中なら、QRを消費せずに断る
      const owner = await db
        .prepare(
          `SELECT w.status AS wstatus, u.status AS ustatus FROM pay_qr_tokens t JOIN wallets w ON w.id = t.wallet_id
             LEFT JOIN users u ON u.id = w.owner_user_id WHERE t.token_hash = ?`,
        )
        .bind(hash)
        .first<{ wstatus: string; ustatus: string | null }>();
      if (owner && (owner.wstatus !== "ACTIVE" || (owner.ustatus !== null && owner.ustatus !== "ACTIVE"))) {
        throw forbidden("お客様のご利用が停止されています。受付にお問い合わせください", "WALLET_INACTIVE");
      }

      const res = await db.batch([
        db
          .prepare(
            `UPDATE pay_qr_tokens SET consumed_at = ?, consumed_by_user_id = ?
              WHERE token_hash = ? AND consumed_at IS NULL AND invalidated_at IS NULL AND expires_at > ?`,
          )
          .bind(now, auth.userId, hash, now),
        db
          .prepare(
            `INSERT INTO payment_sessions (id, shop_id, clerk_user_id, wallet_id, pay_source, cart_json, status, created_at, expires_at)
             SELECT ?, ?, ?, t.wallet_id, 'PHONE_QR', ?, 'OPEN', ?, ? FROM pay_qr_tokens t
              WHERE t.token_hash = ? AND t.consumed_at = ? AND t.consumed_by_user_id = ?`,
          )
          .bind(sessionId, shopId, auth.userId, cart, now, expiresAt, hash, now, auth.userId),
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
    zValidator("json", z.object({ requestId: requestIdSchema, expectedTotal: z.number().int().min(1) })),
    async (c) => {
      const auth = requireAuth(c);
      const { shopId, sessionId } = c.req.valid("param");
      assertShopAccess(auth, shopId);
      const { requestId, expectedTotal } = c.req.valid("json");
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
        .prepare("SELECT wallet_id, cart_json, status, expires_at, order_id FROM payment_sessions WHERE id = ? AND shop_id = ?")
        .bind(sessionId, shopId)
        .first<{ wallet_id: string; cart_json: string; status: string; expires_at: number; order_id: string | null }>();
      if (!s) throw notFound("決済が見つかりません", "SESSION_NOT_FOUND");
      if (s.status === "COMMITTED") throw conflict("この決済はすでに確定しています", "SESSION_DONE");
      if (s.status === "CANCELLED") throw conflict("この決済は取り消されています。QRを読み取り直してください", "SESSION_CANCELLED");
      const now = Date.now();
      if (s.status === "EXPIRED" || s.expires_at < now) {
        throw conflict("決済の有効時間が切れました。お客様のQRを読み取り直してください", "SESSION_EXPIRED");
      }

      // 確定の瞬間の価格・値下げ・在庫で見積もり直す
      const quote = await quoteCart(db, shopId, JSON.parse(s.cart_json), now);
      if (quote.problems.length > 0) throw conflict(quote.problems[0].message, "CART_UNAVAILABLE", { quote: publicQuote(quote) });
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
      // 見積もり時点から商品・値下げ・顧客・店舗が変わっていたら、最初の更新が 0 行になり何も起きない
      const guards = quote.raw.map(
        () =>
          `EXISTS (SELECT 1 FROM products p WHERE p.id = ? AND p.shop_id = ? AND p.status = 'ACTIVE' AND p.sale_mode <> 'SET_ONLY'
             AND p.manual_sold_out = 0 AND p.price = ? AND p.discountable = ? AND (p.track_stock = 0 OR p.stock_qty >= ?))`,
      );
      const guardArgs = quote.raw.flatMap((l) => [l.productId, shopId, l.listUnitPrice, l.discountable ? 1 : 0, l.quantity]);
      const cutGuard = `COALESCE((SELECT id FROM shop_price_cuts WHERE shop_id = ? AND status = 'ACTIVE'
          AND (starts_at IS NULL OR starts_at <= ?) AND (ends_at IS NULL OR ends_at > ?)), '-') = ?`;

      const stmts: D1PreparedStatement[] = [
        db
          .prepare(
            `UPDATE payment_sessions SET status = 'COMMITTED'
              WHERE id = ? AND shop_id = ? AND status = 'OPEN' AND expires_at >= ?
                AND EXISTS (SELECT 1 FROM shops WHERE id = ? AND status = 'ACTIVE')
                AND EXISTS (SELECT 1 FROM wallets w WHERE w.id = payment_sessions.wallet_id AND w.status = 'ACTIVE'
                      AND (w.owner_user_id IS NULL OR EXISTS (SELECT 1 FROM users u WHERE u.id = w.owner_user_id AND u.status = 'ACTIVE')))
                AND ${cutGuard}
                ${guards.map((g) => `AND ${g}`).join("\n")}`,
          )
          .bind(sessionId, shopId, now, shopId, shopId, now, now, quote.cut?.id ?? "-", ...guardArgs),
        db
          .prepare(
            `INSERT INTO orders (id, order_no, shop_id, clerk_user_id, wallet_id, pay_source, subtotal, discount_total, total_paid, status, idempotency_key, paid_at)
             SELECT ?, ?, ?, ?, s.wallet_id, 'PHONE_QR', ?, 0, ?, 'PAID', ?, ? FROM payment_sessions s
              WHERE s.id = ? AND s.status = 'COMMITTED' AND s.order_id IS NULL`,
          )
          .bind(orderId, orderNo(orderId), shopId, auth.userId, quote.total, quote.total, requestId, now, sessionId),
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
      ];
      quote.raw.forEach((l, i) => {
        stmts.push(
          db
            .prepare(
              `INSERT INTO order_lines (id, order_id, line_no, kind, product_id, name_snapshot, unit_price, quantity, line_subtotal, line_paid,
                                        list_unit_price, price_cut_id, price_cut_name)
               SELECT ?, ?, ?, 'PRODUCT', ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${orderExists}`,
            )
            .bind(newId(now), orderId, i + 1, l.productId, l.name, l.unitPrice, l.quantity, l.lineTotal, l.lineTotal, l.listUnitPrice, l.unitPrice < l.listUnitPrice ? (quote.cut?.id ?? null) : null, l.unitPrice < l.listUnitPrice ? (quote.cut?.name ?? null) : null, orderId),
        );
        if (l.trackStock) {
          // 在庫の減算。足りなければ CHECK 制約が全体を巻き戻す(売り越しを DB が拒否)
          stmts.push(
            db.prepare(`UPDATE products SET stock_qty = stock_qty - ?, updated_at = ? WHERE id = ? AND track_stock = 1 AND ${orderExists}`).bind(l.quantity, now, l.productId, orderId),
            db
              .prepare(
                `INSERT INTO stock_movements (id, product_id, delta, qty_after, reason, ref_type, ref_id, operator_user_id, created_at)
                 SELECT ?, p.id, ?, p.stock_qty, 'SALE', 'ORDER', ?, ?, ? FROM products p WHERE p.id = ? AND p.track_stock = 1 AND ${orderExists}`,
              )
              .bind(newId(now), -l.quantity, orderId, auth.userId, now, l.productId, orderId),
          );
        }
      });
      stmts.push(
        bumpCatalogStmt(db, shopId),
        auditStmtIfExists(
          db,
          { actor: auth, action: "payment.commit", targetType: "order", targetId: orderId, after: { sessionId, total: quote.total, walletId: s.wallet_id } },
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

      if ((results[0].meta.changes ?? 0) === 0) {
        // 確定できなかった(誰かが先に確定・取り消した、期限切れ、見積もりのあとに価格や売り切れが変わった)
        const now2 = Date.now();
        const cur = await db.prepare("SELECT status, order_id FROM payment_sessions WHERE id = ?").bind(sessionId).first<{ status: string; order_id: string | null }>();
        if (cur?.status === "COMMITTED" && cur.order_id) return c.json({ ...(await loadPayResult(db, cur.order_id))!, replayed: true });
        if (cur?.status !== "OPEN") throw conflict("この決済は確定できません。状態を確認してください", "SESSION_DONE");
        const fresh = await quoteCart(db, shopId, JSON.parse(s.cart_json), now2);
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
