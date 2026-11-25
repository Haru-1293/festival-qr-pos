import { Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { ErrorText, Field } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction } from "@/lib/useAction";

/** 利用者が自分で退会する。残高が0のときだけ。履歴は運営の監査のために残り、ログインとウォレットの利用だけ止まる */
export function AccountDeleteCard() {
  const { me, money, setMe } = useAuth();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const act = useAction();
  const balance = me?.wallet?.balance ?? 0;
  const blocked = balance !== 0;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void act.run(async () => {
      await api("/auth/delete-account", { body: { password } });
      setMe(null);
      nav("/", { replace: true });
    });
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Trash2 className="size-5" /> 退会
        </CardTitle>
        <CardDescription>退会するとログインできなくなります。残高が0のときだけ退会できます。取引の履歴は、学園祭の運営と監査のために保管されます。</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {blocked && <p className="rounded-lg bg-muted px-3 py-2 text-sm">残高が {money(balance)} 残っています。受付で払戻しを受けて、残高を0にしてから退会してください。</p>}
        <Button variant="outline" className="text-destructive" disabled={blocked} onClick={() => { act.setError(null); setPassword(""); setOpen(true); }}>
          退会する
        </Button>
      </CardContent>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>本当に退会しますか?</DialogTitle>
          <DialogDescription>退会後は、このアカウントでログインできません。この操作は取り消せません。</DialogDescription>
          <form onSubmit={submit} className="flex flex-col gap-3">
            <Field label="パスワード(確認のため)">
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
            </Field>
            <ErrorText message={act.error} />
            <div className="flex gap-2">
              <Button type="button" variant="outline" className="flex-1" onClick={() => setOpen(false)}>
                やめる
              </Button>
              <Button type="submit" variant="destructive" className="flex-1" disabled={act.pending || password === ""}>
                退会する
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
