import { Hono } from "hono";
import type { WalletQrResponse } from "@shared/api";
import type { AppEnv } from "../env";
import { randomToken, sha256Hex } from "../lib/crypto";
import { forbidden, notFound } from "../lib/errors";
import { WALLET_QR_PREFIX } from "../lib/qr";
import { getOperations } from "../lib/settings";
import { requireAuth, requireRole } from "../middleware/auth";

/** 顧客のウォレット。支払い・受付で使うスマホQRを発行する */
export const walletRoutes = new Hono<AppEnv>()
  .use("*", requireRole("CUSTOMER"))
  // 新しいQRを作ると、以前のQR(未使用分)は直ちに無効になる。有効期間は設定値(既定5分)
  .post("/qr", async (c) => {
    const auth = requireAuth(c);
    const db = c.env.DB;
    const wallet = await db
      .prepare("SELECT id, status FROM wallets WHERE owner_user_id = ?")
      .bind(auth.userId)
      .first<{ id: string; status: string }>();
    if (!wallet) throw notFound("ウォレットが見つかりません");
    if (wallet.status !== "ACTIVE") throw forbidden("ご利用が停止されています。受付にお問い合わせください", "WALLET_INACTIVE");

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
  });
