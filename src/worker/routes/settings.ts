import { Hono } from "hono";
import type { AppEnv } from "../env";
import { getEmergency } from "../lib/emergency";
import { getGlobalExpiry } from "../lib/globalExpiry";
import { currentLegalVersions, loadLegal, LEGAL_KINDS, type LegalKind } from "../lib/legal";
import { getCurrency, getFestivalName } from "../lib/settings";
import { mailConfigured } from "../lib/mail";
import { customerResetEnabled } from "./passwordReset";

/** 未ログインでも読める公開設定(通貨表示・学園祭名)。ログイン画面や残高表示に使う */
export const settingsRoutes = new Hono<AppEnv>()
  .get("/public", async (c) => {
    const [currency, festivalName, emergency, globalExpiry, legal, mailOn, resetOn] = await Promise.all([
      getCurrency(c.env.DB),
      getFestivalName(c.env.DB),
      getEmergency(c.env.DB),
      getGlobalExpiry(c.env.DB),
      currentLegalVersions(c.env.DB),
      mailConfigured(c.env.DB),
      customerResetEnabled(c.env.DB),
    ]);
    c.header("Cache-Control", "no-store");
    return c.json({ currency, festivalName, emergency, globalExpiry: globalExpiry.date, legal, passwordReset: mailOn && resetOn, adminPasswordReset: mailOn });
  })
  // 利用規約・プライバシーポリシー(未ログインでも読める)
  .get("/legal/:kind", async (c) => {
    const kind = c.req.param("kind").toUpperCase() as LegalKind;
    if (!LEGAL_KINDS.includes(kind)) return c.json({ error: { code: "NOT_FOUND", message: "見つかりません" } }, 404);
    return c.json({ document: await loadLegal(c.env.DB, kind) });
  });
