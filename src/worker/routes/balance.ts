import { Hono } from "hono";
import { z } from "zod";
import type { BalanceInquiry } from "@shared/api";
import type { AppEnv } from "../env";
import { auditStmt } from "../lib/audit";
import { CARD_SELECT, type CardRow } from "../lib/cards";
import { sha256Hex } from "../lib/crypto";
import { badRequest } from "../lib/errors";
import { CARD_QR_PATTERN } from "../lib/qr";
import { zv } from "../lib/validate";
import { requireAuth, requireRole } from "../middleware/auth";

/**
 * 残高照会。店員・店舗責任者・受付・全体管理者が、カードのQRを読み取って残高を確認する。
 * 読み取るだけで、QR・残高・状態は何も変わらない(PINも不要)。誰が見たかは監査ログに残す。
 */
export const balanceRoutes = new Hono<AppEnv>()
  .use("*", requireRole("ADMIN", "SHOP_MANAGER", "CLERK", "RECEPTION"))
  .post("/inquiry", zv("json", z.object({ token: z.string().trim().max(100) })), async (c) => {
    const auth = requireAuth(c);
    const { token } = c.req.valid("json");
    if (!CARD_QR_PATTERN.test(token)) throw badRequest("カードのQRではありません", "INVALID_QR");
    const db = c.env.DB;
    const card = await db.prepare(`${CARD_SELECT} WHERE c.qr_token_hash = ?`).bind(await sha256Hex(token)).first<CardRow>();
    if (!card) throw badRequest("このカードは登録されていないか、無効になっています", "INVALID_QR");
    const now = Date.now();
    await db.batch([auditStmt(db, { actor: auth, action: "card.balance_view", targetType: "card", targetId: card.id, after: { card: card.display_no } })]);
    const body: BalanceInquiry = {
      displayNo: card.display_no,
      nickname: card.nickname,
      status: card.status,
      balance: card.balance ?? 0,
      expiresAt: card.expires_at,
      expired: card.status !== "DELETED" && card.expires_at !== null && card.expires_at <= now,
      lastUsedAt: card.last_used_at,
    };
    return c.json(body);
  });
