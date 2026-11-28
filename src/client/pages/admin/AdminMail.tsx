import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ErrorText, Field } from "@/components/Shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { useConfirm } from "@/lib/confirm";
import { useAction } from "@/lib/useAction";
import { formatDateTime } from "@/lib/utils";

type Slot = "PRIMARY" | "SUB";
type Provider = "GOOGLE" | "MICROSOFT" | "SMTP";
type AuthKind = "OAUTH2" | "PASSWORD";
type Security = "SSL" | "STARTTLS" | "NONE";

interface Account {
  slot: Slot;
  provider: Provider;
  auth: AuthKind;
  fromAddress: string;
  fromName: string | null;
  username: string | null;
  host: string | null;
  port: number | null;
  security: Security | null;
  clientId: string | null;
  tenant: string | null;
  authUrl: string | null;
  tokenUrl: string | null;
  scope: string | null;
  hasPassword: boolean;
  hasClientSecret: boolean;
  authorizedAt: number | null;
  lastStatus: "OK" | "ERROR" | null;
  lastError: string | null;
  lastUsedAt: number | null;
}
interface MailState {
  accounts: Account[];
  vaultReady: boolean;
  passwordResetEnabled: boolean;
  publicBaseUrl: string;
  redirectUri: string;
  recoveryEmail: string | null;
}

const PROVIDER_LABEL: Record<Provider, string> = { GOOGLE: "Google(Gmail)", MICROSOFT: "Microsoft(Outlook / Microsoft 365)", SMTP: "その他(カスタムSMTP)" };
const SLOT_INFO: Record<Slot, { title: string; description: string }> = {
  PRIMARY: { title: "メイン配信アドレス", description: "お客様へのメール(パスワード再設定など)の送信に使います。全体管理者宛てのときは、サブが使えなければこちらから送ります。" },
  SUB: { title: "サブ配信アドレス", description: "全体管理者へのメールを優先して送ります。メインが送れなかったときの予備として、お客様宛てにも使います。" },
};

interface Form {
  provider: Provider;
  auth: AuthKind;
  fromAddress: string;
  fromName: string;
  username: string;
  host: string;
  port: string;
  security: Security;
  clientId: string;
  clientSecret: string;
  tenant: string;
  authUrl: string;
  tokenUrl: string;
  scope: string;
  password: string;
}
const toForm = (a: Account | undefined): Form => ({
  provider: a?.provider ?? "GOOGLE",
  auth: a?.auth ?? "OAUTH2",
  fromAddress: a?.fromAddress ?? "",
  fromName: a?.fromName ?? "",
  username: a?.username ?? "",
  host: a?.host ?? "",
  port: a?.port ? String(a.port) : "587",
  security: a?.security ?? "STARTTLS",
  clientId: a?.clientId ?? "",
  clientSecret: "",
  tenant: a?.tenant ?? "",
  authUrl: a?.authUrl ?? "",
  tokenUrl: a?.tokenUrl ?? "",
  scope: a?.scope ?? "",
  password: "",
});

function AccountCard({ slot, account, state, reload }: { slot: Slot; account: Account | undefined; state: MailState; reload: () => Promise<void> }) {
  const confirm = useConfirm();
  const [f, setF] = useState<Form>(() => toForm(account));
  const [testTo, setTestTo] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const save = useAction();
  const test = useAction();
  const del = useAction();
  const authz = useAction();
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  useEffect(() => setF(toForm(account)), [account]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setNote(null);
    void save.run(async () => {
      const smtp = f.provider === "SMTP";
      const r = await api<{ needsAuthorization: boolean }>(`/admin/mail/accounts/${slot}`, {
        method: "PUT",
        body: {
          provider: f.provider,
          auth: f.auth,
          fromAddress: f.fromAddress,
          fromName: f.fromName || null,
          username: f.username || null,
          ...(smtp ? { host: f.host, port: Number(f.port), security: f.security } : {}),
          ...(f.auth === "OAUTH2"
            ? { clientId: f.clientId, clientSecret: f.clientSecret || null, ...(f.provider === "MICROSOFT" ? { tenant: f.tenant || null } : {}), ...(smtp ? { authUrl: f.authUrl, tokenUrl: f.tokenUrl, scope: f.scope || null } : {}) }
            : { password: f.password || null }),
        },
      });
      setNote(r.needsAuthorization ? "保存しました。続けて「認可する」を押してください" : "保存しました");
      await reload();
    });
  };
  const authorize = () =>
    void authz.run(async () => {
      const r = await api<{ url: string }>(`/admin/mail/accounts/${slot}/oauth/start`, { body: {} });
      window.location.href = r.url;
    });
  const sendTest = () =>
    void test.run(async () => {
      const r = await api<{ ok: boolean; error: string | null }>(`/admin/mail/accounts/${slot}/test`, { body: { to: testTo } });
      setNote(r.ok ? `${testTo} にテストメールを送りました` : `送信に失敗しました: ${r.error ?? ""}`);
      await reload();
    });
  const remove = async () => {
    if (!(await confirm(`${SLOT_INFO[slot].title}の登録を削除しますか?`, { destructive: true, action: "削除する" }))) return;
    void del.run(async () => {
      await api(`/admin/mail/accounts/${slot}`, { method: "DELETE" });
      setNote("削除しました");
      await reload();
    });
  };

  const oauth = f.auth === "OAUTH2";
  const smtp = f.provider === "SMTP";
  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {SLOT_INFO[slot].title}
          {account ? (
            account.lastStatus === "OK" ? <Badge>送信できました</Badge> : account.lastStatus === "ERROR" ? <Badge variant="destructive">送信に失敗</Badge> : <Badge variant="muted">登録済み</Badge>
          ) : (
            <Badge variant="muted">未登録</Badge>
          )}
        </CardTitle>
        <CardDescription>{SLOT_INFO[slot].description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form onSubmit={submit} className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="サービス">
              <Select value={f.provider} onValueChange={(v) => set("provider", v as Provider)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(PROVIDER_LABEL) as Provider[]).map((p) => (
                    <SelectItem key={p} value={p}>
                      {PROVIDER_LABEL[p]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="認証方式">
              <Select value={f.auth} onValueChange={(v) => set("auth", v as AuthKind)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="OAUTH2">OAuth 2.0</SelectItem>
                  <SelectItem value="PASSWORD">{f.provider === "GOOGLE" ? "アプリパスワード" : "パスワード"}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="送信元のメールアドレス">
              <Input type="email" value={f.fromAddress} onChange={(e) => set("fromAddress", e.target.value)} autoCapitalize="none" required />
            </Field>
            <Field label="差出人名(任意)">
              <Input value={f.fromName} onChange={(e) => set("fromName", e.target.value)} maxLength={60} placeholder="○○学園祭 実行委員会" />
            </Field>
          </div>

          {smtp && (
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="SMTPサーバー">
                <Input value={f.host} onChange={(e) => set("host", e.target.value)} autoCapitalize="none" placeholder="smtp.example.com" required />
              </Field>
              <Field label="ポート">
                <Input inputMode="numeric" value={f.port} onChange={(e) => set("port", e.target.value.replace(/\D/g, ""))} required />
              </Field>
              <Field label="暗号化">
                <Select value={f.security} onValueChange={(v) => set("security", v as Security)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="STARTTLS">STARTTLS(587)</SelectItem>
                    <SelectItem value="SSL">SSL/TLS(465)</SelectItem>
                    <SelectItem value="NONE">なし(非推奨)</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </div>
          )}
          {(smtp || !oauth) && (
            <Field label="ユーザー名" hint={smtp ? "空欄なら送信元のメールアドレスを使います" : "空欄なら送信元のメールアドレス"}>
              <Input value={f.username} onChange={(e) => set("username", e.target.value)} autoCapitalize="none" autoComplete="off" />
            </Field>
          )}

          {!oauth ? (
            <Field label={f.provider === "GOOGLE" ? "アプリパスワード" : "パスワード"} hint={account?.hasPassword ? "保存済みです。変えるときだけ入力してください" : f.provider === "GOOGLE" ? "Googleアカウントの2段階認証を有効にして発行する16文字のパスワード" : undefined}>
              <Input type="password" value={f.password} onChange={(e) => set("password", e.target.value)} autoComplete="new-password" placeholder={account?.hasPassword ? "••••••••(保存済み)" : ""} />
            </Field>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="クライアントID">
                  <Input value={f.clientId} onChange={(e) => set("clientId", e.target.value)} autoCapitalize="none" autoComplete="off" required />
                </Field>
                <Field label="クライアントシークレット" hint={account?.hasClientSecret ? "保存済みです。変えるときだけ入力してください" : undefined}>
                  <Input type="password" value={f.clientSecret} onChange={(e) => set("clientSecret", e.target.value)} autoComplete="new-password" placeholder={account?.hasClientSecret ? "••••••••(保存済み)" : ""} />
                </Field>
                {f.provider === "MICROSOFT" && (
                  <Field label="テナントID(任意)" hint="空欄なら common(個人・組織の両方)">
                    <Input value={f.tenant} onChange={(e) => set("tenant", e.target.value)} autoCapitalize="none" />
                  </Field>
                )}
                {smtp && (
                  <>
                    <Field label="認可URL">
                      <Input value={f.authUrl} onChange={(e) => set("authUrl", e.target.value)} autoCapitalize="none" placeholder="https://…/authorize" required />
                    </Field>
                    <Field label="トークンURL">
                      <Input value={f.tokenUrl} onChange={(e) => set("tokenUrl", e.target.value)} autoCapitalize="none" placeholder="https://…/token" required />
                    </Field>
                    <Field label="スコープ(任意)">
                      <Input value={f.scope} onChange={(e) => set("scope", e.target.value)} autoCapitalize="none" />
                    </Field>
                  </>
                )}
              </div>
              <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
                {f.provider === "GOOGLE" && "Google Cloud で OAuth クライアント(ウェブアプリ)を作り、Gmail API を有効にします。"}
                {f.provider === "MICROSOFT" && "Microsoft Entra ID でアプリを登録し、委任のアクセス許可 Mail.Send を付けます。"}
                {smtp && "XOAUTH2に対応したSMTPサーバーで使えます。"} リダイレクトURIには次を登録してください:
                <code className="mt-1 block break-all font-mono text-foreground">{state.redirectUri}</code>
              </p>
            </>
          )}

          <ErrorText message={save.error} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={save.pending || !state.vaultReady}>
              {save.pending ? "保存中…" : account ? "変更を保存" : "登録する"}
            </Button>
            {account && oauth && account.auth === "OAUTH2" && (
              <Button type="button" variant={account.authorizedAt ? "outline" : "default"} onClick={authorize} disabled={authz.pending}>
                {account.authorizedAt ? "認可し直す" : "認可する"}
              </Button>
            )}
            {account && (
              <Button type="button" variant="ghost" className="text-destructive" onClick={() => void remove()} disabled={del.pending}>
                削除
              </Button>
            )}
          </div>
        </form>

        {account && (
          <div className="flex flex-col gap-2 border-t border-border pt-3">
            <p className="text-xs text-muted-foreground">
              {account.auth === "OAUTH2" && (account.authorizedAt ? `認可済み(${formatDateTime(account.authorizedAt)})` : "認可がまだです")}
              {account.lastUsedAt && ` ・ 最後の送信: ${formatDateTime(account.lastUsedAt)}`}
            </p>
            {account.lastStatus === "ERROR" && account.lastError && <p className="text-sm text-destructive">{account.lastError}</p>}
            <div className="flex gap-2">
              <Input type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="テストメールの宛先" aria-label="テストメールの宛先" />
              <Button type="button" variant="outline" onClick={sendTest} disabled={test.pending || !testTo}>
                {test.pending ? "送信中…" : "テスト送信"}
              </Button>
            </div>
            <ErrorText message={test.error ?? authz.error ?? del.error} />
          </div>
        )}
        {note && <p className="text-sm font-medium text-secondary-foreground">{note}</p>}
      </CardContent>
    </Card>
  );
}

function ResetCard({ state, reload }: { state: MailState; reload: () => Promise<void> }) {
  const [enabled, setEnabled] = useState(state.passwordResetEnabled);
  const [base, setBase] = useState(state.publicBaseUrl);
  const [note, setNote] = useState<string | null>(null);
  const a = useAction();
  const save = (next: boolean, url: string) =>
    void a.run(async () => {
      await api("/admin/mail/settings", { method: "PUT", body: { passwordResetEnabled: next, publicBaseUrl: url } });
      setEnabled(next);
      setNote("保存しました");
      await reload();
    });
  return (
    <Card>
      <CardHeader>
        <CardTitle>パスワード再設定メール</CardTitle>
        <CardDescription>お客様がパスワードを忘れたとき、登録のメールアドレスに再設定のURLを送ります(送信から1時間だけ有効・1回だけ使えます)。全体管理者の再設定は、このスイッチに関わらず、再設定用メールアドレスに送ります。</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <label className="flex items-center justify-between gap-3 text-sm font-medium">
          お客様のパスワード再設定を使えるようにする
          <Switch checked={enabled} onCheckedChange={(v) => save(v, base)} disabled={a.pending} />
        </label>
        <Field label="サイトのURL(任意)" hint="メールのリンクとOAuth2の戻り先に使います。空欄なら、いま開いているアドレスを使います(独自ドメインを使うときに設定)">
          <div className="flex gap-2">
            <Input value={base} onChange={(e) => setBase(e.target.value)} placeholder="https://fes.example.com" autoCapitalize="none" />
            <Button type="button" variant="outline" onClick={() => save(enabled, base)} disabled={a.pending}>
              保存
            </Button>
          </div>
        </Field>
        <ErrorText message={a.error} />
        {note && <p className="text-sm font-medium text-secondary-foreground">{note}</p>}
        {enabled && state.accounts.length === 0 && <p className="text-sm text-amber-700">メール送信の設定がまだないため、再設定メールは送られません。下で登録してください。</p>}
      </CardContent>
    </Card>
  );
}

function RecoveryCard({ state, reload }: { state: MailState; reload: () => Promise<void> }) {
  const [email, setEmail] = useState(state.recoveryEmail ?? "");
  const [pw, setPw] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const a = useAction();
  const save = (value: string | null) =>
    void a.run(async () => {
      await api("/admin/mail/recovery-email", { method: "PUT", body: { email: value, currentPassword: pw } });
      setPw("");
      setNote(value ? "保存しました" : "解除しました");
      await reload();
    });
  return (
    <Card className={state.recoveryEmail ? undefined : "border-amber-400"}>
      <CardHeader>
        <CardTitle>あなたの再設定用メールアドレス</CardTitle>
        <CardDescription>
          全体管理者のパスワードを忘れたときに、再設定のURLを送る先です。{state.recoveryEmail ? "" : "まだ登録されていません。登録しておくことをおすすめします。"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save(email.trim() || null);
          }}
          className="flex flex-col gap-3"
        >
          <Field label="メールアドレス">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" autoCapitalize="none" />
          </Field>
          <Field label="現在のパスワード" hint="変更・解除のときに確認します">
            <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" required />
          </Field>
          <ErrorText message={a.error} />
          <div className="flex gap-2">
            <Button type="submit" disabled={a.pending || !pw}>
              {state.recoveryEmail ? "変更する" : "登録する"}
            </Button>
            {state.recoveryEmail && (
              <Button type="button" variant="ghost" className="text-destructive" disabled={a.pending || !pw} onClick={() => save(null)}>
                解除
              </Button>
            )}
          </div>
          {note && <p className="text-sm font-medium text-secondary-foreground">{note}</p>}
        </form>
      </CardContent>
    </Card>
  );
}

/** メール送信の設定(Google / Microsoft / カスタムSMTP、OAuth2 またはパスワード)、パスワード再設定のオンオフ、再設定用メールアドレス */
export function AdminMail() {
  const [state, setState] = useState<MailState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setState(await api<MailState>("/admin/mail"));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "読み込めませんでした");
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  const oauth = new URLSearchParams(window.location.search).get("oauth");
  const oauthMsg: Record<string, string> = { ok: "OAuth2の認可が完了しました。テスト送信で確認してください", denied: "認可がキャンセルされました", expired: "認可の有効時間が切れました。もう一度やり直してください", error: "認可に失敗しました。設定(クライアントID・シークレット・リダイレクトURI)を確認してください" };

  if (loadError) return <ErrorText message={loadError} />;
  if (!state) return <p className="text-sm text-muted-foreground">読み込み中…</p>;
  const by = (s: Slot) => state.accounts.find((a) => a.slot === s);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <h2 className="text-lg font-bold lg:col-span-2">メール送信</h2>
      {oauth && oauthMsg[oauth] && <p className={`rounded-lg px-3 py-2 text-sm lg:col-span-2 ${oauth === "ok" ? "bg-secondary" : "bg-amber-50 text-amber-900"}`}>{oauthMsg[oauth]}</p>}
      {!state.vaultReady && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 lg:col-span-2">資格情報を暗号化して保存するため、シークレット PIN_PEPPER(16文字以上)の設定が必要です。設定するまで登録できません。</p>}
      <ResetCard state={state} reload={reload} />
      <RecoveryCard state={state} reload={reload} />
      <AccountCard slot="PRIMARY" account={by("PRIMARY")} state={state} reload={reload} />
      <AccountCard slot="SUB" account={by("SUB")} state={state} reload={reload} />
    </div>
  );
}
