import { badRequest } from "./errors";

/** OAuth2の接続先を決めるのに必要な、アカウントの公開項目 */
export interface OAuthSpec {
  provider: "GOOGLE" | "MICROSOFT" | "SMTP";
  client_id: string | null;
  tenant: string | null;
  auth_url: string | null;
  token_url: string | null;
  scope: string | null;
}

export function oauthEndpoints(a: OAuthSpec): { authUrl: string; tokenUrl: string; scope: string; extra: Record<string, string> } {
  if (a.provider === "GOOGLE") {
    return {
      authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scope: "https://www.googleapis.com/auth/gmail.send",
      extra: { access_type: "offline", prompt: "consent" },
    };
  }
  if (a.provider === "MICROSOFT") {
    const t = encodeURIComponent(a.tenant || "common");
    return {
      authUrl: `https://login.microsoftonline.com/${t}/oauth2/v2.0/authorize`,
      tokenUrl: `https://login.microsoftonline.com/${t}/oauth2/v2.0/token`,
      scope: "offline_access https://graph.microsoft.com/Mail.Send",
      extra: { prompt: "consent" },
    };
  }
  if (!a.auth_url || !a.token_url) throw badRequest("認可URLとトークンURLを入力してください");
  return { authUrl: a.auth_url, tokenUrl: a.token_url, scope: a.scope ?? "", extra: {} };
}

export function buildAuthUrl(a: OAuthSpec, redirectUri: string, state: string): string {
  const e = oauthEndpoints(a);
  const u = new URL(e.authUrl);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", a.client_id ?? "");
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", state);
  if (e.scope) u.searchParams.set("scope", e.scope);
  for (const [k, v] of Object.entries(e.extra)) u.searchParams.set(k, v);
  return u.toString();
}

async function tokenRequest(tokenUrl: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(params).toString(),
  });
  const text = await res.text();
  let j: Record<string, unknown> = {};
  try {
    j = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* JSON以外 */
  }
  if (!res.ok || typeof j.access_token !== "string") {
    const why = String(j.error_description ?? j.error ?? text.slice(0, 120)).replace(/\s+/g, " ").slice(0, 200);
    throw new Error(`OAuth2のトークンを取得できませんでした(${why})`);
  }
  return j;
}

/** 認可コードをリフレッシュトークンに交換する */
export async function exchangeCode(a: OAuthSpec, clientSecret: string, code: string, redirectUri: string): Promise<string> {
  const e = oauthEndpoints(a);
  const j = await tokenRequest(e.tokenUrl, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: a.client_id ?? "",
    client_secret: clientSecret,
  });
  if (typeof j.refresh_token !== "string" || !j.refresh_token) {
    throw new Error("リフレッシュトークンが返りませんでした。認可画面で「オフラインアクセス」を許可してください");
  }
  return j.refresh_token;
}

/** リフレッシュトークンから、送信に使うアクセストークンを得る */
export async function refreshAccessToken(a: OAuthSpec, clientSecret: string, refreshToken: string): Promise<string> {
  const e = oauthEndpoints(a);
  const j = await tokenRequest(e.tokenUrl, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: a.client_id ?? "",
    client_secret: clientSecret,
    ...(e.scope ? { scope: e.scope } : {}),
  });
  return j.access_token as string;
}
