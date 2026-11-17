import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import type { AppEnv } from "./env";
import { ApiError } from "./lib/errors";
import { originCheck, sessionLoader } from "./middleware/auth";
import { adminRoutes } from "./routes/admin";
import { authRoutes } from "./routes/auth";
import { settingsRoutes } from "./routes/settings";
import { setupRoutes } from "./routes/setup";
import { shopRoutes } from "./routes/shops";

const api = new Hono<AppEnv>()
  .use("*", secureHeaders())
  .use("*", originCheck)
  .use("*", sessionLoader)
  .route("/auth", authRoutes)
  .route("/setup", setupRoutes)
  .route("/settings", settingsRoutes)
  .route("/admin", adminRoutes)
  .route("/shops", shopRoutes)
  .get("/health", (c) => c.json({ ok: true, time: Date.now() }));

const app = new Hono<AppEnv>().route("/api", api);

app.notFound((c) => c.json({ error: { code: "NOT_FOUND", message: "見つかりません" } }, 404));

app.onError((err, c) => {
  if (err instanceof ApiError) {
    return c.json({ error: { code: err.code, message: err.message } }, err.status);
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
