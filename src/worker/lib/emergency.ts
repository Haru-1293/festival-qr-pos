import { createMiddleware } from "hono/factory";
import type { EmergencyState } from "@shared/api";
import type { AppEnv } from "../env";
import { ApiError } from "./errors";
import { getSetting } from "./settings";

export const EMERGENCY_KEY = "emergency_stop";
export const DEFAULT_EMERGENCY: EmergencyState = { on: false, message: "" };

export async function getEmergency(db: D1Database): Promise<EmergencyState> {
  return { ...DEFAULT_EMERGENCY, ...(await getSetting<Partial<EmergencyState>>(db, EMERGENCY_KEY, {})) };
}

/**
 * 緊急停止中に止める操作(お金が動く入口だけ): レジの読み取り・確定、受付のチャージ・払戻し、顧客のQR発行。
 * 返金・訂正・途中回収・現金の締め・各種の管理は止めない(止めている間に後始末できるように)。
 * すでに処理中の確定は、そのまま完了する。
 */
const BLOCKED = /^\/api\/(pos\/[^/]+\/pay\/(scan|[^/]+\/commit)|reception\/(charge|payout)|wallet\/qr)$/;

export const emergencyStop = createMiddleware<AppEnv>(async (c, next) => {
  if (c.req.method === "POST" && BLOCKED.test(c.req.path)) {
    const e = await getEmergency(c.env.DB);
    if (e.on) {
      throw new ApiError(503, "EMERGENCY_STOP", e.message ? `緊急停止中です: ${e.message}` : "緊急停止中です。係の指示をお待ちください");
    }
  }
  await next();
});
