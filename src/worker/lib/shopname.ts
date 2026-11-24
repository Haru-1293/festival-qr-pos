import type { AuthContext } from "../env";
import { auditStmtIfExists } from "./audit";
import { newId } from "./ids";

/**
 * 店舗名は「変更できる表示名」。店舗そのものは不変のIDで結びつくので、名前を変えても過去の注文・返金・監査ログは同じ店舗につながる。
 * 変更のたびに shop_name_history(追記専用)へ記録し、過去のログには「その時点の店舗名」を出す。
 */

/** その時刻(timeCol)の店舗名を引く SQL 式。履歴がなければ現在の名前 */
export const shopNameAtSql = (shopIdCol: string, timeCol: string, currentNameCol: string) =>
  `COALESCE((SELECT h.display_name FROM shop_name_history h WHERE h.shop_id = ${shopIdCol} AND h.valid_from <= ${timeCol} ORDER BY h.valid_from DESC, h.id DESC LIMIT 1), ${currentNameCol})`;

/** 履歴の最新の名前が newName と違うときだけ履歴を足す文(UPDATE の後に同じ batch で実行する) */
export function historyStmt(db: D1Database, auth: AuthContext, shopId: string, newName: string, now: number) {
  return db
    .prepare(
      `INSERT INTO shop_name_history (id, shop_id, display_name, valid_from, changed_by)
       SELECT ?1, ?2, ?3, ?4, ?5
        WHERE EXISTS (SELECT 1 FROM shops WHERE id = ?2 AND display_name = ?3)
          AND COALESCE((SELECT h.display_name FROM shop_name_history h WHERE h.shop_id = ?2 ORDER BY h.valid_from DESC, h.id DESC LIMIT 1), '') <> ?3`,
    )
    .bind(newId(now), shopId, newName, now, auth.userId);
}

/** 店舗名の変更(店舗名の更新・履歴・監査ログ)。oldName と一致するときだけ更新する(同時操作で上書きしない) */
export function renameStmts(db: D1Database, auth: AuthContext, shopId: string, oldName: string, newName: string, now: number) {
  return [
    db.prepare("UPDATE shops SET name = ?1, display_name = ?1 WHERE id = ?2 AND display_name = ?3").bind(newName, shopId, oldName),
    historyStmt(db, auth, shopId, newName, now),
    auditStmtIfExists(
      db,
      { actor: auth, action: "shop.rename", targetType: "shop", targetId: shopId, before: { displayName: oldName }, after: { displayName: newName } },
      "SELECT 1 FROM shop_name_history WHERE shop_id = ? AND display_name = ? AND valid_from = ? AND changed_by = ?",
      [shopId, newName, now, auth.userId],
    ),
  ];
}
