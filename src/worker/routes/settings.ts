import { Hono } from "hono";
import type { AppEnv } from "../env";
import { getCurrency, getFestivalName } from "../lib/settings";

/** 未ログインでも読める公開設定(通貨表示・学園祭名)。ログイン画面や残高表示に使う */
export const settingsRoutes = new Hono<AppEnv>().get("/public", async (c) => {
  const [currency, festivalName] = await Promise.all([getCurrency(c.env.DB), getFestivalName(c.env.DB)]);
  c.header("Cache-Control", "no-store");
  return c.json({ currency, festivalName });
});
