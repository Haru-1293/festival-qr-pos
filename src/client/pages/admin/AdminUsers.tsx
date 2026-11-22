import { KeyRound, QrCode, UserPlus } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { ReceptionQrIssued, ShopDto, UserDto } from "@shared/api";
import { ROLE_LABELS, type Role } from "@shared/roles";
import { LoginQrDialog } from "@/components/LoginQrDialog";
import { ErrorText, Field } from "@/components/Shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useAction } from "@/lib/useAction";
import { formatDateTime } from "@/lib/utils";
import { useConfirm, useNotify, usePrompt } from "@/lib/confirm";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const FILTERS: { id: Role | "ALL"; label: string }[] = [
  { id: "ALL", label: "すべて" },
  { id: "SHOP_MANAGER", label: "店舗責任者" },
  { id: "CLERK", label: "店員" },
  { id: "RECEPTION", label: "受付" },
  { id: "CUSTOMER", label: "顧客" },
  { id: "ADMIN", label: "全体管理者" },
];

export function AdminUsers() {
  const confirm = useConfirm();
  const prompt = usePrompt();
  const notify = useNotify();
  const [users, setUsers] = useState<UserDto[]>([]);
  const [shops, setShops] = useState<ShopDto[]>([]);
  const [filter, setFilter] = useState<Role | "ALL">("ALL");
  const [qr, setQr] = useState<{
    issued: ReceptionQrIssued;
    nickname: string;
  } | null>(null);

  const load = useCallback(async () => {
    const q = filter === "ALL" ? "" : `?role=${filter}`;
    const [u, s] = await Promise.all([api<{ users: UserDto[] }>(`/admin/users${q}`), api<{ shops: ShopDto[] }>("/admin/shops")]);
    setUsers(u.users);
    setShops(s.shops);
  }, [filter]);
  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  // --- 店舗責任者の登録 ---
  const [mShop, setMShop] = useState("");
  const [mNick, setMNick] = useState("");
  const [mLogin, setMLogin] = useState("");
  const [mPass, setMPass] = useState("");
  const manager = useAction();
  const submitManager = (e: FormEvent) => {
    e.preventDefault();
    void manager.run(async () => {
      await api("/admin/users/shop-manager", {
        body: {
          shopId: mShop,
          loginId: mLogin,
          password: mPass,
          nickname: mNick,
        },
      });
      setMNick("");
      setMLogin("");
      setMPass("");
      await load();
    });
  };

  // --- 受付担当者の登録 ---
  const [rNick, setRNick] = useState("");
  const [rLogin, setRLogin] = useState("");
  const [rPass, setRPass] = useState("");
  const reception = useAction();
  const submitReception = (e: FormEvent) => {
    e.preventDefault();
    void reception.run(async () => {
      const issued = await api<ReceptionQrIssued>("/admin/users/reception", {
        body: { nickname: rNick, ...(rLogin ? { loginId: rLogin, password: rPass } : {}) },
      });
      setQr({ issued, nickname: rNick });
      setRNick("");
      setRLogin("");
      setRPass("");
      await load();
    });
  };

  // --- 行操作 ---
  const row = useAction();
  const resetPassword = async (u: UserDto) => {
    const pw = await prompt(`${u.nickname} さんの新しいパスワード(8文字以上)`, { title: "パスワード再設定", required: true, action: "変更する" });
    if (!pw) return;
    void row.run(async () => {
      await api(`/admin/users/${u.id}/reset-password`, {
        body: { password: pw },
      });
      await notify("パスワードを変更しました。本人に伝えてください");
    });
  };
  const setCredentials = async (u: UserDto) => {
    const loginId = await prompt(`${u.nickname} さんのログインID(英数字と . _ @ + - )`, { title: "ログインIDの設定", defaultValue: u.loginId ?? "", required: true, action: "次へ" });
    if (!loginId) return;
    const password = await prompt("パスワード(8文字以上)", { title: "パスワードの設定", required: true, action: "設定する" });
    if (!password) return;
    void row.run(async () => {
      await api(`/admin/users/${u.id}/reception-credentials`, { body: { loginId: loginId.trim(), password } });
      await load();
      await notify("設定しました。ログイン中の端末はログアウトされます。本人にIDとパスワードを伝えてください");
    });
  };
  const toggle = async (u: UserDto) => {
    const next = u.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE";
    if (
      next === "SUSPENDED" &&
      !(await confirm(`${u.nickname} さんを利用停止にしますか?`, {
        destructive: true,
      }))
    )
      return;
    void row.run(async () => {
      await api(`/admin/users/${u.id}/status`, {
        method: "PATCH",
        body: { status: next },
      });
      await load();
    });
  };
  const reissueQr = async (u: UserDto) => {
    if (
      !(await confirm(`${u.nickname} さんのログインQRを再発行しますか?\n古いQRは直ちに使えなくなり、ログイン中の端末もログアウトされます。`, {
        destructive: true,
      }))
    )
      return;
    void row.run(async () => {
      const issued = await api<ReceptionQrIssued>(`/admin/users/${u.id}/reception-qr`, { body: { reason: "再発行" } });
      setQr({ issued, nickname: u.nickname });
      await load();
    });
  };
  const revokeQr = async (u: UserDto) => {
    const reason = await prompt(`${u.nickname} さんのログインQRを失効します。理由を入力してください(例: 紛失)`, { title: "ログインQRの失効", required: true, action: "失効する" });
    if (!reason) return;
    void row.run(async () => {
      await api(`/admin/users/${u.id}/reception-qr/revoke`, {
        body: { reason },
      });
      await load();
    });
  };

  return (
    <div className="flex flex-col gap-4">
      {qr && <LoginQrDialog issued={qr.issued} nickname={qr.nickname} onClose={() => setQr(null)} />}

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <UserPlus className="size-5" /> 店舗責任者を登録
            </CardTitle>
            <CardDescription>店員は、店舗責任者が自分の画面から登録します。</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={submitManager} className="flex flex-col gap-3">
              <Field label="店舗">
                <Select value={mShop} onValueChange={(v) => setMShop(v)}>
                  <SelectTrigger>
                    <SelectValue placeholder="選択してください" />
                  </SelectTrigger>
                  <SelectContent>
                    {shops.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.displayName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="表示名">
                <Input value={mNick} onChange={(e) => setMNick(e.target.value)} maxLength={20} required />
              </Field>
              <Field label="ログインID">
                <Input value={mLogin} onChange={(e) => setMLogin(e.target.value)} autoCapitalize="none" required />
              </Field>
              <Field label="初期パスワード" hint="8文字以上。本人に直接伝えてください">
                <Input value={mPass} onChange={(e) => setMPass(e.target.value)} minLength={8} autoComplete="off" required />
              </Field>
              <ErrorText message={manager.error} />
              <Button type="submit" disabled={manager.pending}>
                登録する
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <QrCode className="size-5" /> 受付担当者を登録
            </CardTitle>
            <CardDescription>担当の生徒1人につき、ログイン用QRを1枚発行します。</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={submitReception} className="flex flex-col gap-3">
              <Field label="表示名">
                <Input value={rNick} onChange={(e) => setRNick(e.target.value)} maxLength={20} required />
              </Field>
              <Field label="ログインID(任意)" hint="入力すると、QRのほかにID・パスワードでもログインできます">
                <Input value={rLogin} onChange={(e) => setRLogin(e.target.value)} autoCapitalize="none" />
              </Field>
              {rLogin && (
                <Field label="初期パスワード" hint="8文字以上">
                  <Input value={rPass} onChange={(e) => setRPass(e.target.value)} minLength={8} autoComplete="off" required />
                </Field>
              )}
              <ErrorText message={reception.error} />
              <Button type="submit" disabled={reception.pending}>
                登録してQRを発行
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>ユーザー一覧</CardTitle>
          <div className="flex flex-wrap gap-1.5 pt-1">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
                className={`rounded-full px-3 py-1.5 text-sm font-medium ${filter === f.id ? "bg-primary text-primary-foreground" : "bg-accent text-muted-foreground"}`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </CardHeader>
        <CardContent className="flex flex-col divide-y divide-border">
          <ErrorText message={row.error} />
          {users.length === 0 && <p className="py-2 text-sm text-muted-foreground">該当するユーザーはいません</p>}
          {users.map((u) => (
            <div key={u.id} className="flex flex-col gap-2 py-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-semibold">
                    {u.nickname}
                    {u.shopName && <span className="ml-2 text-xs font-normal text-muted-foreground">{u.shopName}</span>}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {u.loginId ?? "ログインQR"} ・ 登録 {formatDateTime(u.createdAt)}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <Badge variant="muted">{ROLE_LABELS[u.role]}</Badge>
                  {u.status !== "ACTIVE" && <Badge variant="warning">停止中</Badge>}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {(u.role !== "RECEPTION" || u.loginId) && (
                  <Button size="sm" variant="outline" onClick={() => resetPassword(u)} disabled={row.pending}>
                    <KeyRound className="!size-4" /> パスワード再設定
                  </Button>
                )}
                {u.role === "RECEPTION" && (
                  <>
                    <Button size="sm" variant="outline" onClick={() => setCredentials(u)} disabled={row.pending}>
                      <KeyRound className="!size-4" /> {u.loginId ? "ID・パスワード変更" : "ID・パスワード設定"}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => reissueQr(u)} disabled={row.pending}>
                      <QrCode className="!size-4" /> QR再発行
                    </Button>
                    {u.loginQrIssuedAt && (
                      <Button size="sm" variant="outline" onClick={() => revokeQr(u)} disabled={row.pending}>
                        QR失効
                      </Button>
                    )}
                    <span className="self-center text-xs text-muted-foreground">{u.loginQrIssuedAt ? `QR発行 ${formatDateTime(u.loginQrIssuedAt)}` : "有効なQRなし"}</span>
                  </>
                )}
                <Button size="sm" variant="outline" onClick={() => toggle(u)} disabled={row.pending}>
                  {u.status === "ACTIVE" ? "利用停止" : "再開"}
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
