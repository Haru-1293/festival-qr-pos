import { KeyRound, UserPlus } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { UserDto } from "@shared/api";
import { ROLE_LABELS } from "@shared/roles";
import { ErrorText, Field } from "@/components/Shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useAction } from "@/lib/useAction";

/** 店舗のスタッフ管理。店舗責任者は自店舗の店員を登録・パスワード再設定・停止できる */
export function StaffManager({ shopId }: { shopId: string }) {
  const [staff, setStaff] = useState<UserDto[]>([]);
  const [loginId, setLoginId] = useState("");
  const [nickname, setNickname] = useState("");
  const [password, setPassword] = useState("");
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
      await api(`/shops/${shopId}/staff`, { body: { loginId, password, nickname } });
      setLoginId("");
      setNickname("");
      setPassword("");
      await load();
    });
  };

  const resetPassword = (u: UserDto) => {
    const pw = window.prompt(`${u.nickname} さんの新しいパスワード(8文字以上)`);
    if (!pw) return;
    void row.run(async () => {
      await api(`/shops/${shopId}/staff/${u.id}/reset-password`, { body: { password: pw } });
      window.alert("パスワードを変更しました");
    });
  };

  const toggle = (u: UserDto) => {
    const next = u.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE";
    if (next === "SUSPENDED" && !window.confirm(`${u.nickname} さんを利用停止にしますか?`)) return;
    void row.run(async () => {
      await api(`/shops/${shopId}/staff/${u.id}/status`, { method: "PATCH", body: { status: next } });
      await load();
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UserPlus className="size-5" /> 店員を登録
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="flex flex-col gap-3">
            <Field label="表示名">
              <Input value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={20} required />
            </Field>
            <Field label="ログインID" hint="英数字と . _ @ + - が使えます">
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
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => resetPassword(u)} disabled={row.pending}>
                    <KeyRound className="!size-4" /> パスワード再設定
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => toggle(u)} disabled={row.pending}>
                    {u.status === "ACTIVE" ? "利用停止" : "再開"}
                  </Button>
                </div>
              )}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
