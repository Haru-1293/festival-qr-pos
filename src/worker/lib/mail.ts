import type { Bindings } from "../env";
import { base64UrlOf, buildMime } from "./mailMime";
import { refreshAccessToken, type OAuthSpec } from "./oauth";
import { smtpSend } from "./smtp";
import { openText, sealText, vaultSecret } from "./vault";

export type MailSlot = "PRIMARY" | "SUB";
export type MailProvider = "GOOGLE" | "MICROSOFT" | "SMTP";
export type MailAuth = "OAUTH2" | "PASSWORD";

export interface MailAccountRow extends OAuthSpec {
  slot: MailSlot;
  auth: MailAuth;
  from_address: string;
  from_name: string | null;
  username: string | null;
  host: string | null;
  port: number | null;
  security: "SSL" | "STARTTLS" | "NONE" | null;
  secret_sealed: string | null;
  authorized_at: number | null;
  last_status: "OK" | "ERROR" | null;
  last_error: string | null;
  last_used_at: number | null;
  updated_at: number;
}

/** 暗号化して持つ秘密の項目 */
export interface MailSecret {
  password?: string;
  clientSecret?: string;
  refreshToken?: string;
}

export async function loadAccounts(db: D1Database): Promise<MailAccountRow[]> {
  const { results } = await db.prepare("SELECT * FROM mail_accounts ORDER BY slot").all<MailAccountRow>();
  return results;
}

export async function openSecret(env: Pick<Bindings, "PIN_PEPPER">, row: Pick<MailAccountRow, "secret_sealed">): Promise<MailSecret> {
  const t = await openText(vaultSecret(env), row.secret_sealed);
  if (!t) return {};
  try {
    return JSON.parse(t) as MailSecret;
  } catch {
    return {};
  }
}

export async function sealSecret(env: Pick<Bindings, "PIN_PEPPER">, s: MailSecret): Promise<string | null> {
  return sealText(vaultSecret(env), JSON.stringify(s));
}

/** 方式ごとの既定のSMTP接続先 */
function smtpTarget(a: MailAccountRow): { host: string; port: number; security: "SSL" | "STARTTLS" | "NONE" } {
  if (a.provider === "GOOGLE") return { host: "smtp.gmail.com", port: 465, security: "SSL" };
  if (a.provider === "MICROSOFT") return { host: "smtp.office365.com", port: 587, security: "STARTTLS" };
  return { host: a.host ?? "", port: a.port ?? 587, security: a.security ?? "STARTTLS" };
}

export interface Outgoing {
  to: string;
  subject: string;
  text: string;
}

/** 1つのアカウントで送る。失敗したら Error を投げる */
export async function sendViaAccount(env: Pick<Bindings, "PIN_PEPPER">, a: MailAccountRow, m: Outgoing): Promise<void> {
  const secret = await openSecret(env, a);
  const msg = { fromAddress: a.from_address, fromName: a.from_name, ...m };
  const domain = a.from_address.split("@")[1] ?? "localhost";
  const user = a.username || a.from_address;

  if (a.auth === "PASSWORD") {
    if (!secret.password) throw new Error("パスワードが保存されていません(PIN_PEPPERが変わった可能性があります。入力し直してください)");
    const t = smtpTarget(a);
    await smtpSend({ ...t, auth: { kind: "PASSWORD", username: user, password: secret.password }, from: a.from_address, to: m.to, data: buildMime(msg, domain) });
    return;
  }
  // OAuth2
  if (!secret.refreshToken || !secret.clientSecret) throw new Error("OAuth2の認可がまだ終わっていません(「認可する」を押してください)");
  const token = await refreshAccessToken(a, secret.clientSecret, secret.refreshToken);
  if (a.provider === "GOOGLE") {
    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ raw: base64UrlOf(buildMime(msg, domain)) }),
    });
    if (!res.ok) throw new Error(`Gmailの送信に失敗しました(${res.status} ${(await res.text()).replace(/\s+/g, " ").slice(0, 160)})`);
    return;
  }
  if (a.provider === "MICROSOFT") {
    const res = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        message: { subject: m.subject, body: { contentType: "Text", content: m.text }, toRecipients: [{ emailAddress: { address: m.to } }] },
        saveToSentItems: false,
      }),
    });
    if (!res.ok) throw new Error(`Microsoftの送信に失敗しました(${res.status} ${(await res.text()).replace(/\s+/g, " ").slice(0, 160)})`);
    return;
  }
  const t = smtpTarget(a);
  await smtpSend({ ...t, auth: { kind: "XOAUTH2", username: user, token }, from: a.from_address, to: m.to, data: buildMime(msg, domain) });
}

async function note(db: D1Database, slot: MailSlot, err: string | null) {
  await db
    .prepare("UPDATE mail_accounts SET last_status = ?, last_error = ?, last_used_at = ? WHERE slot = ?")
    .bind(err === null ? "OK" : "ERROR", err, Date.now(), slot)
    .run()
    .catch(() => undefined);
}

export type MailPurpose = "CUSTOMER" | "ADMIN";

export interface SendResult {
  ok: boolean;
  /** 実際に送れた枠(PRIMARY / SUB) */
  via: MailSlot | null;
  error: string | null;
}

/**
 * 宛先に応じて送る。お客様宛: メイン→サブ、全体管理者宛: サブ→メイン(サブが登録されていれば優先)の順に試す。
 * 先の枠で失敗したら、次の枠で送る
 */
export async function sendMail(env: Pick<Bindings, "DB" | "PIN_PEPPER">, purpose: MailPurpose, m: Outgoing): Promise<SendResult> {
  const rows = await loadAccounts(env.DB);
  const by = new Map(rows.map((r) => [r.slot, r]));
  const order: MailSlot[] = purpose === "ADMIN" ? ["SUB", "PRIMARY"] : ["PRIMARY", "SUB"];
  let lastErr: string | null = null;
  for (const slot of order) {
    const a = by.get(slot);
    if (!a) continue;
    try {
      await sendViaAccount(env, a, m);
      await note(env.DB, slot, null);
      return { ok: true, via: slot, error: null };
    } catch (e) {
      lastErr = e instanceof Error ? e.message : "送信に失敗しました";
      await note(env.DB, slot, lastErr);
    }
  }
  return { ok: false, via: null, error: lastErr ?? "送信用のメールアカウントが登録されていません" };
}

/** 送れる状態か(1つでも登録されている) */
export async function mailConfigured(db: D1Database): Promise<boolean> {
  return (await db.prepare("SELECT 1 FROM mail_accounts LIMIT 1").first()) !== null;
}
