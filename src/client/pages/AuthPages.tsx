import { QrCode, ScanLine } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { ROLE_LABELS, type Role } from "@shared/roles";
import { ROLE_HOME } from "@/lib/roleHome";
import type { MeResponse } from "@shared/api";
import { ErrorText, Field } from "@/components/Shell";
import { QrScanner, scannerSupported } from "@/components/QrScanner";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction } from "@/lib/useAction";

function AuthFrame({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  const { settings } = useAuth();
  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-4 py-8">
      <div className="text-center">
        <div className="mx-auto mb-3 flex size-16 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow">
          <QrCode className="size-9" />
        </div>
        <h1 className="text-xl font-bold">{settings.festivalName}</h1>
        <p className="text-sm text-muted-foreground">QR決済</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </CardHeader>
        <CardContent className="flex flex-col gap-4">{children}</CardContent>
      </Card>
    </div>
  );
}

export type Portal = "customer" | "shop" | "clerk" | "reception" | "admin";

const PORTALS: Record<Portal, { role: Role; title: string; description: string; qr: boolean }> = {
  customer: { role: "CUSTOMER", title: "ログイン", description: "メールアドレスとパスワードでログインします", qr: false },
  shop: { role: "SHOP_MANAGER", title: "店舗責任者ログイン", description: "店舗の商品・売上・スタッフを管理します", qr: false },
  clerk: { role: "CLERK", title: "店員ログイン", description: "レジを使います。ID・パスワード、または配布されたQRでログインできます", qr: true },
  reception: { role: "RECEPTION", title: "受付ログイン", description: "チャージ・払い戻しを行います。ID・パスワード、または配布されたQRでログインできます(同時に使える端末は1台)", qr: true },
  admin: { role: "ADMIN", title: "全体管理者ログイン", description: "運営全体の設定・集計を行います", qr: false },
};

/** 役割ごとのログイン画面。ID・パスワードに加えて、店員・受付はQRでも入れる。違う役割のアカウントでは入れない */
export function PortalLoginPage({ portal }: { portal: Portal }) {
  const cfg = PORTALS[portal];
  const { me, setMe, logout } = useAuth();
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [scanning, setScanning] = useState(false);
  const { pending, error, run } = useAction();
  const [wrongRole, setWrongRole] = useState<string | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    if (portal !== "admin" && portal !== "customer") return;
    api<{ needsSetup: boolean }>("/setup/status")
      .then((r) => setNeedsSetup(r.needsSetup))
      .catch(() => undefined);
  }, [portal]);

  // 入れたあとの確認: 役割が違えば、そのアカウントを使わせずにログアウトする
  const accept = useCallback(
    async (res: MeResponse) => {
      if (res.user.role !== cfg.role) {
        await api("/auth/logout", { method: "POST", body: {} }).catch(() => undefined);
        setWrongRole(`このアカウントは${ROLE_LABELS[res.user.role]}用です。${ROLE_LABELS[res.user.role]}のログイン画面からログインしてください(${ROLE_HOME[res.user.role]})`);
        return;
      }
      setMe(res);
      navigate(ROLE_HOME[cfg.role], { replace: true });
    },
    [cfg.role, setMe, navigate],
  );

  const qrLogin = useCallback(
    (value: string) => {
      setWrongRole(null);
      void run(async () => accept(await api<MeResponse>("/auth/qr-login", { body: { token: value.trim() } })));
    },
    [run, accept],
  );
  const onScan = useCallback(
    (value: string) => {
      setScanning(false);
      qrLogin(value);
    },
    [qrLogin],
  );

  if (me && me.user.role === cfg.role) return <Navigate to={ROLE_HOME[cfg.role]} replace />;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setWrongRole(null);
    void run(async () => accept(await api<MeResponse>("/auth/login", { body: { loginId, password } })));
  };

  return (
    <AuthFrame title={cfg.title} description={cfg.description}>
      {me && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          いま{ROLE_LABELS[me.user.role]}としてログイン中です。
          <button className="ml-1 font-semibold underline" onClick={() => void logout()}>
            ログアウト
          </button>
        </p>
      )}
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label={portal === "customer" ? "メールアドレス" : "ログインID"}>
          <Input value={loginId} onChange={(e) => setLoginId(e.target.value)} autoComplete="username" autoCapitalize="none" inputMode={portal === "customer" ? "email" : "text"} required />
        </Field>
        <Field label="パスワード">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </Field>
        <ErrorText message={wrongRole ?? error} />
        <Button type="submit" size="lg" disabled={pending}>
          {pending ? "ログイン中…" : "ログイン"}
        </Button>
      </form>

      {cfg.qr && (
        <div className="flex flex-col gap-3 border-t border-border pt-4">
          <p className="text-sm font-semibold">QRでログイン</p>
          {scanning && <QrScanner onScan={onScan} onClose={() => setScanning(false)} />}
          <Button variant="outline" size="lg" onClick={() => setScanning(true)} disabled={pending || !scannerSupported()}>
            <ScanLine /> QRを読み取る
          </Button>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              qrLogin(token);
            }}
            className="flex gap-2"
          >
            <Input value={token} onChange={(e) => setToken(e.target.value)} autoCapitalize="none" autoCorrect="off" placeholder="QRの文字列(FES1:…)" aria-label="QRの文字列" />
            <Button type="submit" variant="outline" disabled={pending || !token.trim()}>
              ログイン
            </Button>
          </form>
        </div>
      )}

      <div className="flex flex-col gap-2 border-t border-border pt-4 text-center text-sm">
        {portal === "customer" && (
          <Link to="/register" className="font-semibold text-secondary-foreground underline-offset-2 hover:underline">
            はじめての方はこちら(新規登録)
          </Link>
        )}
        <Link to="/" className="text-muted-foreground underline-offset-2 hover:underline">
          トップページへ
        </Link>
        <p className="text-xs text-muted-foreground">パスワードを忘れた場合は、{portal === "customer" ? "受付または運営" : portal === "admin" ? "他の全体管理者" : "運営(または店舗責任者)"}にお声がけください。</p>
        {needsSetup && (
          <Link to="/setup" className="text-xs text-amber-700 underline">
            初回セットアップ(全体管理者の作成)
          </Link>
        )}
      </div>
    </AuthFrame>
  );
}

export function RegisterPage() {
  const { me, setMe } = useAuth();
  const [email, setEmail] = useState("");
  const [nickname, setNickname] = useState("");
  const [password, setPassword] = useState("");
  const [agree, setAgree] = useState(false);
  const { settings } = useAuth();
  const hasLegal = settings.legal.TERMS !== null || settings.legal.PRIVACY !== null;
  const { pending, error, run } = useAction();

  if (me) return <Navigate to={ROLE_HOME[me.user.role]} replace />;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      setMe(
        await api<MeResponse>("/auth/register", {
          body: { email, password, nickname, agree: hasLegal ? agree : undefined },
        }),
      );
    });
  };

  return (
    <AuthFrame title="新規登録" description="メールアドレスはログインIDとして使います(メールは送信されません)">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="ニックネーム">
          <Input value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={20} required />
        </Field>
        <Field label="メールアドレス">
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" autoCapitalize="none" required />
        </Field>
        <Field label="パスワード" hint="8文字以上。忘れた場合は全体管理者が再設定します">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={8} required />
        </Field>
        {hasLegal && (
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={agree} onCheckedChange={(v) => setAgree(v === true)} className="mt-0.5" />
            <span>
              {settings.legal.TERMS !== null && (
                <Link to="/terms" target="_blank" className="font-semibold underline">
                  利用規約
                </Link>
              )}
              {settings.legal.TERMS !== null && settings.legal.PRIVACY !== null && "と"}
              {settings.legal.PRIVACY !== null && (
                <Link to="/privacy" target="_blank" className="font-semibold underline">
                  プライバシーポリシー
                </Link>
              )}
              に同意します
            </span>
          </label>
        )}
        {settings.globalExpiry && <p className="text-xs text-muted-foreground">ウォレットの有効期限は {settings.globalExpiry.replaceAll("-", "/")} までです。</p>}
        <ErrorText message={error} />
        <Button type="submit" size="lg" disabled={pending || (hasLegal && !agree)}>
          {pending ? "登録中…" : "登録してはじめる"}
        </Button>
      </form>
      <Link to="/login" className="text-center text-sm text-muted-foreground underline-offset-2 hover:underline">
        ログインに戻る
      </Link>
    </AuthFrame>
  );
}

/** 初回セットアップ。SETUP_TOKEN を知っている人だけが最初の全体管理者を作れる */
export function SetupPage() {
  const { me, setMe } = useAuth();
  const [setupToken, setSetupToken] = useState("");
  const [loginId, setLoginId] = useState("");
  const [nickname, setNickname] = useState("");
  const [password, setPassword] = useState("");
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  const { pending, error, run } = useAction();

  useEffect(() => {
    api<{ needsSetup: boolean }>("/setup/status")
      .then((r) => setNeedsSetup(r.needsSetup))
      .catch(() => setNeedsSetup(false));
  }, []);

  if (me) return <Navigate to={ROLE_HOME[me.user.role]} replace />;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      setMe(
        await api<MeResponse>("/setup/admin", {
          body: { loginId, password, nickname },
          headers: { "x-setup-token": setupToken },
        }),
      );
    });
  };

  if (needsSetup === false) {
    return (
      <AuthFrame title="セットアップ済み">
        <p className="text-sm">全体管理者はすでに作成されています。</p>
        <Link to="/admin/login" className="text-center text-sm font-semibold underline">
          ログインへ
        </Link>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame title="初回セットアップ" description="最初の全体管理者を作成します。作成後、この画面は使えなくなります">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="セットアップトークン" hint="デプロイ時に設定した SETUP_TOKEN">
          <Input type="password" value={setupToken} onChange={(e) => setSetupToken(e.target.value)} autoComplete="off" required />
        </Field>
        <Field label="ログインID">
          <Input value={loginId} onChange={(e) => setLoginId(e.target.value)} autoCapitalize="none" required />
        </Field>
        <Field label="表示名">
          <Input value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={20} required />
        </Field>
        <Field label="パスワード" hint="8文字以上">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={8} required />
        </Field>
        <ErrorText message={error} />
        <Button type="submit" size="lg" disabled={pending}>
          {pending ? "作成中…" : "全体管理者を作成"}
        </Button>
      </form>
    </AuthFrame>
  );
}
