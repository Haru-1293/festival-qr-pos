import { Hono } from "hono";
import type { ActiveOrderDto, HistoryItem, WalletQrResponse } from "@shared/api";
import type { AppEnv } from "../env";
import { randomToken, sha256Hex } from "../lib/crypto";
import { forbidden, notFound } from "../lib/errors";
import { WALLET_QR_PREFIX } from "../lib/qr";
import { getOperations } from "../lib/settings";
import { orderNo } from "../lib/order";
import { requireAuth, requireRole } from "../middleware/auth";
import { shopNameAtSql } from "../lib/shopname";

/** 顧客のウォレット。支払い・受付で使うスマホQRを発行する */
export const walletRoutes = new Hono<AppEnv>()
  .use("*", requireRole("CUSTOMER"))
  // 受け取り待ちの注文(呼び出し番号)。受け渡し済み・取り消した注文は出さない。自分のウォレットの注文だけ
  .get("/active-orders", async (c) => {
    const auth = requireAuth(c);
    const { results } = await c.env.DB
      .prepare(
        `SELECT o.id, o.paid_at, COALESCE(t.call_label, CAST(t.call_no AS TEXT)) AS call_no, t.status, s.display_name,
                (SELECT group_concat(name_snapshot || '×' || quantity, ' / ') FROM order_lines l WHERE l.order_id = o.id) AS items
           FROM wallets w JOIN orders o ON o.wallet_id = w.id JOIN order_tracking t ON t.order_id = o.id JOIN shops s ON s.id = o.shop_id
          WHERE w.owner_user_id = ? AND o.paid_at >= ? AND t.status IN ('PREPARING','READY') AND o.refunded_total < o.total_paid
          ORDER BY o.paid_at DESC LIMIT 20`,
      )
      .bind(auth.userId, Date.now() - 24 * 3600_000)
      .all<{ id: string; paid_at: number; call_no: string; status: "PREPARING" | "READY"; display_name: string; items: string | null }>();
    c.header("Cache-Control", "no-store");
    return c.json({
      orders: results.map((r) => ({ orderId: r.id, orderNo: orderNo(r.id), shopName: r.display_name, callNo: r.call_no, status: r.status, paidAt: r.paid_at, items: r.items }) satisfies ActiveOrderDto),
    });
  })
  // 新しいQRを作ると、以前のQR(未使用分)は直ちに無効になる。有効期間は設定値(既定5分)
  .post("/qr", async (c) => {
    const auth = requireAuth(c);
    const db = c.env.DB;
    const wallet = await db
      .prepare("SELECT id, status, expires_at FROM wallets WHERE owner_user_id = ?")
      .bind(auth.userId)
      .first<{ id: string; status: string; expires_at: number | null }>();
    if (!wallet) throw notFound("ウォレットが見つかりません");
    if (wallet.status !== "ACTIVE") throw forbidden("ご利用が停止されています。受付にお問い合わせください", "WALLET_INACTIVE");

    if (wallet.expires_at !== null && wallet.expires_at <= Date.now()) {
      throw forbidden("ウォレットの有効期限が切れています。残高のお取り扱いは受付にお問い合わせください", "WALLET_EXPIRED");
    }

    const { qrTtlSeconds } = await getOperations(db);
    const token = `${WALLET_QR_PREFIX}${randomToken(24)}`;
    const hash = await sha256Hex(token);
    const now = Date.now();
    const expiresAt = now + qrTtlSeconds * 1000;
    await db.batch([
      db
        .prepare("UPDATE pay_qr_tokens SET invalidated_at = ? WHERE wallet_id = ? AND invalidated_at IS NULL AND consumed_at IS NULL")
        .bind(now, wallet.id),
      db
        .prepare(
          `INSERT INTO pay_qr_tokens (token_hash, wallet_id, purpose, created_at, expires_at)
           VALUES (?, ?, 'PAY', ?, ?)`,
        )
        .bind(hash, wallet.id, now, expiresAt),
    ]);
    return c.json({ token, expiresAt, ttlSeconds: qrTtlSeconds } satisfies WalletQrResponse);
  })
  // 自分の利用履歴(チャージ・支払い・返金・払戻し)。新しい順
  .get("/history", async (c) => {
    const auth = requireAuth(c);
    const { results } = await c.env.DB
      .prepare(
        `SELECT l.id, l.kind, l.amount, l.balance_after, l.created_at, l.ref_type, l.ref_id,
                COALESCE(${shopNameAtSql("so.id", "l.created_at", "so.display_name")}, ${shopNameAtSql("sr.id", "l.created_at", "sr.display_name")}) AS shop_name,
                COALESCE(o.id, ro.id) AS order_id
           FROM wallet_ledger l JOIN wallets w ON w.id = l.wallet_id
           LEFT JOIN orders o ON l.ref_type = 'ORDER' AND o.id = l.ref_id
           LEFT JOIN shops so ON so.id = o.shop_id
           LEFT JOIN refunds r ON l.ref_type = 'REFUND' AND r.id = l.ref_id
           LEFT JOIN orders ro ON ro.id = r.order_id
           LEFT JOIN shops sr ON sr.id = ro.shop_id
          WHERE w.owner_user_id = ?
          ORDER BY l.created_at DESC, l.id DESC LIMIT 100`,
      )
      .bind(auth.userId)
      .all<{ id: string; kind: HistoryItem["kind"]; amount: number; balance_after: number; created_at: number; shop_name: string | null; order_id: string | null }>();
    c.header("Cache-Control", "no-store");
    const items: HistoryItem[] = results.map((r) => ({
      id: r.id,
      kind: r.kind,
      amount: r.amount,
      balanceAfter: r.balance_after,
      createdAt: r.created_at,
      shopName: r.shop_name,
      orderNo: r.order_id ? orderNo(r.order_id) : null,
    }));
    return c.json({ items });
  });
