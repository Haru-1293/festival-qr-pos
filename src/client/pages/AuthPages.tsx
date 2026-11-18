import { QrCode, ScanLine } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import type { MeResponse } from "@shared/api";
import { ErrorText, Field } from "@/components/Shell";
import { QrScanner, scannerSupported } from "@/components/QrScanner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction } from "@/lib/useAction";

function AuthFrame({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  const { settings } = useAuth();
  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col justify-center gap-4 px-4 py-8">
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

export function LoginPage() {
  const { me, setMe } = useAuth();
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const { pending, error, run } = useAction();
  const [needsSetup, setNeedsSetup] = useState(false);

  useEffect(() => {
    api<{ needsSetup: boolean }>("/setup/status")
      .then((r) => setNeedsSetup(r.needsSetup))
      .catch(() => undefined);
  }, []);

  if (me) return <Navigate to="/" replace />;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const res = await api<MeResponse>("/auth/login", { body: { loginId, password } });
      setMe(res);
    });
  };

  return (
    <AuthFrame title="ログイン" description="メールアドレス(またはスタッフのログインID)でログインします">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="メールアドレス / ログインID">
          <Input
            value={loginId}
            onChange={(e) => setLoginId(e.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            inputMode="email"
            required
          />
        </Field>
        <Field label="パスワード">
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </Field>
        <ErrorText message={error} />
        <Button type="submit" size="lg" disabled={pending}>
          {pending ? "ログイン中…" : "ログイン"}
        </Button>
      </form>
      <div className="flex flex-col gap-2 border-t border-border pt-4 text-center text-sm">
        <Link to="/register" className="font-semibold text-secondary-foreground underline-offset-2 hover:underline">
          はじめての方はこちら(新規登録)
        </Link>
        <Link to="/qr-login" className="text-muted-foreground underline-offset-2 hover:underline">
          受付担当者・店員のQRログイン
        </Link>
        <p className="text-xs text-muted-foreground">パスワードを忘れた場合は、受付または運営にお声がけください。</p>
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
  const { pending, error, run } = useAction();

  if (me) return <Navigate to="/" replace />;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      setMe(await api<MeResponse>("/auth/register", { body: { email, password, nickname } }));
    });
  };

  return (
    <AuthFrame title="新規登録" description="メールアドレスはログインIDとして使います(メールは送信されません)">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="ニックネーム">
          <Input value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={20} required />
        </Field>
        <Field label="メールアドレス">
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            autoCapitalize="none"
            required
          />
        </Field>
        <Field label="パスワード" hint="8文字以上。忘れた場合は全体管理者が再設定します">
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            required
          />
        </Field>
        <ErrorText message={error} />
        <Button type="submit" size="lg" disabled={pending}>
          {pending ? "登録中…" : "登録してはじめる"}
        </Button>
      </form>
      <Link to="/login" className="text-center text-sm text-muted-foreground underline-offset-2 hover:underline">
        ログインに戻る
      </Link>
    </AuthFrame>
  );
}

/** 受付担当者・店員のQRログイン。カメラ読み取り、または QR の文字列を貼り付けて入力する */
export function ReceptionLoginPage() {
  const { me, setMe } = useAuth();
  const [token, setToken] = useState("");
  const [scanning, setScanning] = useState(false);
  const { pending, error, run } = useAction();
  const navigate = useNavigate();

  const login = useCallback(
    (value: string) => {
      void run(async () => {
        setMe(await api<MeResponse>("/auth/qr-login", { body: { token: value.trim() } }));
        navigate("/", { replace: true });
      });
    },
    [run, setMe, navigate],
  );

  const onScan = useCallback(
    (value: string) => {
      setScanning(false);
      login(value);
    },
    [login],
  );

  if (me) return <Navigate to="/" replace />;

  return (
    <AuthFrame title="QRでログイン" description="配布されたログイン用QRを読み取ってください(受付担当者・店員)。交代するときはログアウトしてください">
      {scanning && <QrScanner onScan={onScan} onClose={() => setScanning(false)} />}
      <Button size="lg" onClick={() => setScanning(true)} disabled={pending || !scannerSupported()}>
        <ScanLine /> QRを読み取る
      </Button>
      {!scannerSupported() && (
        <p className="text-xs text-muted-foreground">この端末ではカメラ読み取りに対応していません。下の欄にQRの文字列を入力してください。</p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          login(token);
        }}
        className="flex flex-col gap-3"
      >
        <Field label="QRの文字列(読み取れない場合)">
          <Input value={token} onChange={(e) => setToken(e.target.value)} autoCapitalize="none" autoCorrect="off" placeholder="FES1:…" />
        </Field>
        <ErrorText message={error} />
        <Button type="submit" variant="outline" disabled={pending || !token.trim()}>
          ログイン
        </Button>
      </form>
      <Link to="/login" className="text-center text-sm text-muted-foreground underline-offset-2 hover:underline">
        ログイン画面に戻る
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

  if (me) return <Navigate to="/" replace />;

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
        <Link to="/login" className="text-center text-sm font-semibold underline">
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
