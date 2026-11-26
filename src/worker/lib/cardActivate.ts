import type { AuthContext } from "../env";
import { hashPin } from "./crypto";
import { conflict } from "./errors";
import { newId } from "./ids";
import type { CardRow } from "./cards";

/** 暗証番号(PIN)のハッシュに使う秘密値。未設定のときはPINを扱えない */
export function pinPepper(env: { PIN_PEPPER?: string }): string {
  if (!env.PIN_PEPPER || env.PIN_PEPPER.length < 16) throw conflict("PIN_PEPPER が設定されていないため、PINを扱えません", "PEPPER_MISSING");
  return env.PIN_PEPPER;
}

/**
 * カードの有効化: ウォレットを作り、ニックネーム・PINを設定して使える状態にする(全体管理者・受付の両方が使う)。
 * ウォレットとカードの更新は同じ batch(同一トランザクション)で、カードが未有効化のときだけ成功する。
 * 戻り値は作ったウォレットID。
 */
export async function activateCard(
  db: D1Database,
  env: { PIN_PEPPER?: string },
  actor: AuthContext,
  card: CardRow,
  b: { nickname: string; pin: string; memo?: string; expiresAt: number },
): Promise<string> {
  const now = Date.now();
  const pinHash = await hashPin(b.pin, pinPepper(env));
  const walletId = newId(now);
  const id = card.id;
  const res = await db.batch([
    db
      .prepare("INSERT INTO wallets (id, owner_user_id, balance, status, expires_at, created_at) SELECT ?, NULL, 0, 'ACTIVE', ?, ? WHERE EXISTS (SELECT 1 FROM cards WHERE id = ? AND status = 'ISSUED')")
      .bind(walletId, b.expiresAt, now, id),
    db
      .prepare(
        `UPDATE cards SET status = 'ACTIVE', wallet_id = ?, nickname = ?, pin_hash = ?, expires_at = ?, memo = COALESCE(?, memo), activated_at = ?, activated_by = ?
          WHERE id = ? AND status = 'ISSUED' AND EXISTS (SELECT 1 FROM wallets WHERE id = ?)`,
      )
      .bind(walletId, b.nickname, pinHash, b.expiresAt, b.memo || null, now, actor.userId, id, walletId),
    db
      .prepare(
        `INSERT INTO audit_logs (id, actor_user_id, actor_role, action, target_type, target_id, before_json, after_json, created_at)
         SELECT ?, ?, ?, 'card.activate', 'card', ?, NULL, ?, ? WHERE EXISTS (SELECT 1 FROM cards WHERE id = ? AND status = 'ACTIVE' AND activated_at = ?)`,
      )
      .bind(newId(now), actor.userId, actor.role, id, JSON.stringify({ displayNo: card.display_no, nickname: b.nickname, walletId, expiresAt: b.expiresAt }), now, id, now),
  ]);
  if ((res[1].meta.changes ?? 0) !== 1) throw conflict("このカードはすでに有効化されています", "CARD_STATE");
  return walletId;
}
