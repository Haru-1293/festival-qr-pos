import { KeyRound } from "lucide-react";
import { useState, type FormEvent } from "react";
import { ErrorText, Field } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useAction } from "@/lib/useAction";

/** 自分のパスワードの変更(現在のパスワードが必要)。ほかの端末のログインは外れ、いまの端末だけ残る */
export function PasswordChangeCard() {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const act = useAction();
  const mismatch = again !== "" && next !== again;
  const reset = () => {
    setCurrent("");
    setNext("");
    setAgain("");
    act.setError(null);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (next !== again) return;
    void act.run(async () => {
      await api("/auth/change-password", { body: { currentPassword: current, newPassword: next } });
      reset();
      setOpen(false);
      setDone(true);
    });
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="size-5" /> アカウント
        </CardTitle>
        <CardDescription>パスワードを変えると、ほかの端末のログインは外れます</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {done && <p className="text-sm font-semibold text-primary">パスワードを変更しました</p>}
        <Button
          variant="outline"
          onClick={() => {
            setDone(false);
            setOpen(true);
          }}
        >
          パスワードを変更する
        </Button>
      </CardContent>
      <Dialog
        open={open}
        onOpenChange={(v) => {
          setOpen(v);
          if (!v) reset();
        }}
      >
        <DialogContent>
          <DialogTitle>パスワードの変更</DialogTitle>
          <DialogDescription>現在のパスワードと、新しいパスワード(8文字以上)を入力してください</DialogDescription>
          <form onSubmit={submit} className="flex flex-col gap-3">
            <Field label="現在のパスワード">
              <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
            </Field>
            <Field label="新しいパスワード" hint="8文字以上">
              <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={8} maxLength={128} required />
            </Field>
            <Field label="新しいパスワード(確認)">
              <Input type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" required />
            </Field>
            {mismatch && <p className="text-xs text-destructive">確認用のパスワードが一致しません</p>}
            <ErrorText message={act.error} />
            <Button type="submit" disabled={act.pending || mismatch || current === "" || next.length < 8 || again === ""}>
              変更する
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
