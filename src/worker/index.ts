import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";
import type { AppEnv } from "./env";
import { ApiError } from "./lib/errors";
import { configurePbkdf2 } from "./lib/crypto";
import { originCheck, sessionLoader } from "./middleware/auth";
import { adminRoutes } from "./routes/admin";
import { authRoutes } from "./routes/auth";
import { cashRoutes } from "./routes/cash";
import { cardRoutes } from "./routes/cards";
import { catalogRoutes } from "./routes/catalog";
import { setRoutes } from "./routes/sets";
import { posRoutes } from "./routes/pos";
import { discountRoutes, shopCouponRoutes } from "./routes/discounts";
import { reportRoutes } from "./routes/reports";
import { orderRoutes } from "./routes/orders";
import { publicRoutes } from "./routes/public";
import { emergencyStop } from "./lib/emergency";
import { refundRoutes } from "./routes/refunds";
import { receptionRoutes } from "./routes/reception";
import { settingsRoutes } from "./routes/settings";
import { printTemplateRoutes } from "./routes/printTemplates";
import { systemRoutes } from "./routes/system";
import { setupRoutes } from "./routes/setup";
import { shopRoutes } from "./routes/shops";
import { walletRoutes } from "./routes/wallet";

// 入力検証のエラーメッセージを日本語にする(画面にそのまま表示されるため)
z.config(z.locales.ja());

const api = new Hono<AppEnv>()
  .use("*", secureHeaders())
  .use("*", async (c, next) => {
    configurePbkdf2(c.env.PBKDF2_ITERATIONS);
    await next();
  })
  // 残高・取引・個人情報を含むので、APIの応答はブラウザや中間装置に保存させない
  .use("*", async (c, next) => {
    await next();
    if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-store");
  })
  .use("*", originCheck)
  .use("*", sessionLoader)
  .use("*", emergencyStop)
  .route("/auth", authRoutes)
  .route("/setup", setupRoutes)
  .route("/settings", settingsRoutes)
  .route("/print-templates", printTemplateRoutes)
  .route("/admin/system", systemRoutes)
  .route("/admin", adminRoutes)
  .route("/shops", shopRoutes)
  .route("/wallet", walletRoutes)
  .route("/reception", receptionRoutes)
  .route("/cash", cashRoutes)
  .route("/cards", cardRoutes)
  .route("/catalog", catalogRoutes)
  .route("/catalog", setRoutes)
  .route("/pos", posRoutes)
  .route("/refunds", refundRoutes)
  .route("/discounts", discountRoutes)
  .route("/shop-coupons", shopCouponRoutes)
  .route("/reports", reportRoutes)
  .route("/orders", orderRoutes)
  .route("/public", publicRoutes)
  .get("/health", (c) => c.json({ ok: true, time: Date.now() }));

const app = new Hono<AppEnv>().route("/api", api);

app.notFound((c) => c.json({ error: { code: "NOT_FOUND", message: "見つかりません" } }, 404));

app.onError((err, c) => {
  if (err instanceof ApiError) {
    return c.json({ error: { code: err.code, message: err.message, ...(err.details === undefined ? {} : { details: err.details }) } }, err.status);
  }
  if (err instanceof HTTPException) {
    return c.json({ error: { code: "HTTP_ERROR", message: err.message || "リクエストが正しくありません" } }, err.status);
  }
  // 内部情報(SQL・スタック)は返さない。ログにだけ残す
  console.error("unhandled", err);
  return c.json({ error: { code: "INTERNAL", message: "サーバーでエラーが発生しました" } }, 500);
});

export type AppType = typeof app;
export default app;
