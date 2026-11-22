import { KeyRound, Pencil, QrCode, UserPlus } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { ReceptionQrIssued, UserDto } from "@shared/api";
import { ROLE_LABELS } from "@shared/roles";
import { LoginQrDialog } from "@/components/LoginQrDialog";
import { ErrorText, Field } from "@/components/Shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { useAction } from "@/lib/useAction";
import { formatDateTime } from "@/lib/utils";
import { useConfirm, useNotify, usePrompt } from "@/lib/confirm";

/** 店舗のスタッフ管理。店舗責任者は自店舗の店員を登録・パスワード再設定・停止できる */
export function StaffManager({ shopId }: { shopId: string }) {
  const confirm = useConfirm();
  const prompt = usePrompt();
  const notify = useNotify();
  const [staff, setStaff] = useState<UserDto[]>([]);
  const [loginId, setLoginId] = useState("");
  const [nickname, setNickname] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"CLERK" | "SHOP_MANAGER">("CLERK");
  const [qr, setQr] = useState<{
    issued: ReceptionQrIssued;
    nickname: string;
  } | null>(null);
  const create = useAction();
  const row = useAction();

  const load = useCallback(async () => {
    const r = await api<{ staff: UserDto[] }>(`/shops/${shopId}/staff`);
    setStaff(r.staff);
  }, [shopId]);

  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void create.run(async () => {
      await api(`/shops/${shopId}/staff`, {
        body: { loginId, password, nickname, role },
      });
      setLoginId("");
      setNickname("");
      setPassword("");
      await load();
    });
  };

  const resetPassword = async (u: UserDto) => {
    const pw = await prompt(`${u.nickname} さんの新しいパスワード(8文字以上)`, { title: "パスワード再設定", required: true, action: "変更する" });
    if (!pw) return;
    void row.run(async () => {
      await api(`/shops/${shopId}/staff/${u.id}/reset-password`, {
        body: { password: pw },
      });
      await notify("パスワードを変更しました。本人に伝えてください");
    });
  };

  const changeLoginId = async (u: UserDto) => {
    const next = await prompt(`${u.nickname} さんの新しいログインID(いまのIDでは入れなくなり、ログイン中の端末はログアウトされます)`, { title: "ログインIDの変更", defaultValue: u.loginId ?? "", required: true, action: "変更する" });
    if (!next || next === u.loginId) return;
    void row.run(async () => {
      await api(`/shops/${shopId}/staff/${u.id}/login-id`, {
        method: "PATCH",
        body: { loginId: next.trim() },
      });
      await load();
    });
  };

  const issueQr = async (u: UserDto) => {
    if (
      u.loginQrIssuedAt &&
      !(await confirm(`${u.nickname} さんのログインQRを再発行しますか?\n古いQRは直ちに使えなくなり、ログイン中の端末もログアウトされます。`, {
        destructive: true,
      }))
    )
      return;
    void row.run(async () => {
      const issued = await api<ReceptionQrIssued>(`/shops/${shopId}/staff/${u.id}/qr`, {
        body: { reason: u.loginQrIssuedAt ? "再発行" : "新規発行" },
      });
      setQr({ issued, nickname: u.nickname });
      await load();
    });
  };

  const revokeQr = async (u: UserDto) => {
    const reason = await prompt(`${u.nickname} さんのログインQRを失効します。理由を入力してください(例: 紛失)`, { title: "ログインQRの失効", required: true, action: "失効する" });
    if (!reason) return;
    void row.run(async () => {
      await api(`/shops/${shopId}/staff/${u.id}/qr/revoke`, {
        body: { reason },
      });
      await load();
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
      await api(`/shops/${shopId}/staff/${u.id}/status`, {
        method: "PATCH",
        body: { status: next },
      });
      await load();
    });
  };

  return (
    <div className="flex flex-col gap-4">
      {qr && <LoginQrDialog issued={qr.issued} nickname={qr.nickname} onClose={() => setQr(null)} />}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UserPlus className="size-5" /> スタッフを登録
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="flex flex-col gap-3">
            <Field label="役割" hint="店舗責任者は商品・売上・スタッフの管理ができます(複数人登録できます)">
              <Select value={role} onValueChange={(v) => setRole(v as "CLERK" | "SHOP_MANAGER")}>
                <SelectTrigger aria-label="役割">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="CLERK">店員(レジ)</SelectItem>
                  <SelectItem value="SHOP_MANAGER">店舗責任者</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="表示名">
              <Input value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={20} required />
            </Field>
            <Field label="ログインID" hint="店舗責任者が決めます。英数字と . _ @ + - が使えます(あとから変更できます)。QRでもログインできます">
              <Input value={loginId} onChange={(e) => setLoginId(e.target.value)} autoCapitalize="none" required />
            </Field>
            <Field label="初期パスワード" hint="8文字以上。店員に直接伝えてください">
              <Input type="text" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} autoComplete="off" required />
            </Field>
            <ErrorText message={create.error} />
            <Button type="submit" disabled={create.pending}>
              {create.pending ? "登録中…" : "登録する"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>スタッフ一覧</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col divide-y divide-border">
          <ErrorText message={row.error} />
          {staff.length === 0 && <p className="py-2 text-sm text-muted-foreground">まだ登録がありません</p>}
          {staff.map((u) => (
            <div key={u.id} className="flex flex-col gap-2 py-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-semibold">{u.nickname}</p>
                  <p className="truncate text-xs text-muted-foreground">{u.loginId}</p>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <Badge variant="muted">{ROLE_LABELS[u.role]}</Badge>
                  {u.status !== "ACTIVE" && <Badge variant="warning">停止中</Badge>}
                </div>
              </div>
              {u.role === "CLERK" && (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => changeLoginId(u)} disabled={row.pending}>
                    <Pencil className="!size-4" /> ID変更
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => resetPassword(u)} disabled={row.pending}>
                    <KeyRound className="!size-4" /> パスワード再設定
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => issueQr(u)} disabled={row.pending || u.status !== "ACTIVE"}>
                    <QrCode className="!size-4" /> {u.loginQrIssuedAt ? "QR再発行" : "ログインQR発行"}
                  </Button>
                  {u.loginQrIssuedAt && (
                    <Button size="sm" variant="outline" onClick={() => revokeQr(u)} disabled={row.pending}>
                      QR失効
                    </Button>
                  )}
                  <Button size="sm" variant="outline" onClick={() => toggle(u)} disabled={row.pending}>
                    {u.status === "ACTIVE" ? "利用停止" : "再開"}
                  </Button>
                  {u.loginQrIssuedAt && <span className="self-center text-xs text-muted-foreground">QR発行 {formatDateTime(u.loginQrIssuedAt)}</span>}
                </div>
              )}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
