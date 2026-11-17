import { KeyRound, Printer, QrCode, UserPlus } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { ReceptionQrIssued, ShopDto, UserDto } from "@shared/api";
import { ROLE_LABELS, type Role } from "@shared/roles";
import { QrCodeView } from "@/components/QrCodeView";
import { ErrorText, Field } from "@/components/Shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useAction } from "@/lib/useAction";
import { formatDateTime } from "@/lib/utils";

const FILTERS: { id: Role | "ALL"; label: string }[] = [
  { id: "ALL", label: "すべて" },
  { id: "SHOP_MANAGER", label: "店舗責任者" },
  { id: "CLERK", label: "店員" },
  { id: "RECEPTION", label: "受付" },
  { id: "CUSTOMER", label: "顧客" },
  { id: "ADMIN", label: "全体管理者" },
];

/** 発行直後だけ表示する受付ログインQR。生トークンはサーバーに保存されないため、閉じると再表示できない */
function ReceptionQrDialog({ issued, nickname, onClose }: { issued: ReceptionQrIssued; nickname: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 print:static print:bg-white print:p-0">
      <div className="w-full max-w-sm rounded-2xl bg-card p-5 shadow-xl print:max-w-none print:shadow-none">
        <h2 className="text-lg font-bold">{nickname} さんのログインQR</h2>
        <p className="mt-1 text-sm text-muted-foreground print:hidden">
          この画面を閉じると再表示できません。印刷して本人に渡してください(紛失時は再発行できます)。
        </p>
        <div className="my-4 flex justify-center">
          <QrCodeView value={issued.token} size={260} />
        </div>
        <p className="break-all rounded-lg bg-muted p-2 text-center font-mono text-xs print:hidden">{issued.token}</p>
        <div className="mt-4 flex gap-2 print:hidden">
          <Button variant="outline" className="flex-1" onClick={() => window.print()}>
            <Printer /> 印刷
          </Button>
          <Button className="flex-1" onClick={onClose}>
            閉じる
          </Button>
        </div>
      </div>
    </div>
  );
}

export function AdminUsers() {
  const [users, setUsers] = useState<UserDto[]>([]);
  const [shops, setShops] = useState<ShopDto[]>([]);
  const [filter, setFilter] = useState<Role | "ALL">("ALL");
  const [qr, setQr] = useState<{ issued: ReceptionQrIssued; nickname: string } | null>(null);

  const load = useCallback(async () => {
    const q = filter === "ALL" ? "" : `?role=${filter}`;
    const [u, s] = await Promise.all([
      api<{ users: UserDto[] }>(`/admin/users${q}`),
      api<{ shops: ShopDto[] }>("/admin/shops"),
    ]);
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
      await api("/admin/users/shop-manager", { body: { shopId: mShop, loginId: mLogin, password: mPass, nickname: mNick } });
      setMNick("");
      setMLogin("");
      setMPass("");
      await load();
    });
  };

  // --- 受付担当者の登録 ---
  const [rNick, setRNick] = useState("");
  const reception = useAction();
  const submitReception = (e: FormEvent) => {
    e.preventDefault();
    void reception.run(async () => {
      const issued = await api<ReceptionQrIssued>("/admin/users/reception", { body: { nickname: rNick } });
      setQr({ issued, nickname: rNick });
      setRNick("");
      await load();
    });
  };

  // --- 行操作 ---
  const row = useAction();
  const resetPassword = (u: UserDto) => {
    const pw = window.prompt(`${u.nickname} さんの新しいパスワード(8文字以上)`);
    if (!pw) return;
    void row.run(async () => {
      await api(`/admin/users/${u.id}/reset-password`, { body: { password: pw } });
      window.alert("パスワードを変更しました。本人に伝えてください");
    });
  };
  const toggle = (u: UserDto) => {
    const next = u.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE";
    if (next === "SUSPENDED" && !window.confirm(`${u.nickname} さんを利用停止にしますか?`)) return;
    void row.run(async () => {
      await api(`/admin/users/${u.id}/status`, { method: "PATCH", body: { status: next } });
      await load();
    });
  };
  const reissueQr = (u: UserDto) => {
    if (!window.confirm(`${u.nickname} さんのログインQRを再発行しますか?\n古いQRは直ちに使えなくなり、ログイン中の端末もログアウトされます。`)) return;
    void row.run(async () => {
      const issued = await api<ReceptionQrIssued>(`/admin/users/${u.id}/reception-qr`, { body: { reason: "再発行" } });
      setQr({ issued, nickname: u.nickname });
      await load();
    });
  };
  const revokeQr = (u: UserDto) => {
    const reason = window.prompt(`${u.nickname} さんのログインQRを失効します。理由を入力してください(例: 紛失)`);
    if (!reason) return;
    void row.run(async () => {
      await api(`/admin/users/${u.id}/reception-qr/revoke`, { body: { reason } });
      await load();
    });
  };

  return (
    <div className="flex flex-col gap-4">
      {qr && <ReceptionQrDialog issued={qr.issued} nickname={qr.nickname} onClose={() => setQr(null)} />}

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
                <select
                  className="h-12 rounded-lg border border-input bg-card px-3 text-base"
                  value={mShop}
                  onChange={(e) => setMShop(e.target.value)}
                  required
                >
                  <option value="">選択してください</option>
                  {shops.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.displayName}
                    </option>
                  ))}
                </select>
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
                className={`rounded-full px-3 py-1.5 text-sm font-medium ${
                  filter === f.id ? "bg-primary text-primary-foreground" : "bg-accent text-muted-foreground"
                }`}
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
                {u.role !== "RECEPTION" && (
                  <Button size="sm" variant="outline" onClick={() => resetPassword(u)} disabled={row.pending}>
                    <KeyRound className="!size-4" /> パスワード再設定
                  </Button>
                )}
                {u.role === "RECEPTION" && (
                  <>
                    <Button size="sm" variant="outline" onClick={() => reissueQr(u)} disabled={row.pending}>
                      <QrCode className="!size-4" /> QR再発行
                    </Button>
                    {u.receptionQrIssuedAt && (
                      <Button size="sm" variant="outline" onClick={() => revokeQr(u)} disabled={row.pending}>
                        QR失効
                      </Button>
                    )}
                    <span className="self-center text-xs text-muted-foreground">
                      {u.receptionQrIssuedAt ? `QR発行 ${formatDateTime(u.receptionQrIssuedAt)}` : "有効なQRなし"}
                    </span>
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
