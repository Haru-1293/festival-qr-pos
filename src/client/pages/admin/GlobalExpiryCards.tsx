import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { GlobalExpiryInfo } from "@shared/api";
import { ErrorText, Field } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DatePicker } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useConfirm } from "@/lib/confirm";
import { useAction } from "@/lib/useAction";

const RESET_PHRASE = "全データを削除";
const jstDate = (ms: number) => new Date(ms).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "long", day: "numeric" });
const jstIso = (ms: number) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);

/** 全体の有効期限と、期限後の全データ削除(全体管理者だけ) */
export function GlobalExpiryCards() {
  const confirm = useConfirm();
  const { refresh } = useAuth();
  const [info, setInfo] = useState<GlobalExpiryInfo | null>(null);
  const [date, setDate] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [phrase, setPhrase] = useState("");
  const [password, setPassword] = useState("");
  const [resetDone, setResetDone] = useState<string | null>(null);
  const save = useAction();
  const reset = useAction();

  const load = useCallback(async () => {
    const r = await api<{ globalExpiry: GlobalExpiryInfo }>("/admin/system/global-expiry");
    setInfo(r.globalExpiry);
    setDate(r.globalExpiry.date ?? "");
  }, []);
  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);

  const put = (next: string | null) =>
    save.run(async () => {
      const r = await api<{ globalExpiry: GlobalExpiryInfo; updated: { wallets: number; cards: number } }>("/admin/system/global-expiry", { method: "PUT", body: { date: next } });
      setInfo(r.globalExpiry);
      setDate(r.globalExpiry.date ?? "");
      setNote(next === null ? "全体の有効期限を解除しました(すでに揃えた期限は戻りません)" : `全体の有効期限を保存しました。ウォレット${r.updated.wallets}件・カード${r.updated.cards}件の期限をそろえました`);
      await refresh();
    });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!date) return;
    const ok = await confirm(`全体の有効期限を ${jstDate(Date.parse(`${date}T12:00:00+09:00`))} の終わりに設定します。期限内のすべてのウォレットとカードの期限が、その日にそろいます。よろしいですか?`, { action: "設定する" });
    if (ok) void put(date);
  };

  const doReset = async () => {
    const ok = await confirm("全データを削除します。監査ログ・取引・店舗・商品・利用者(全体管理者以外)・カードがすべて消え、元に戻せません。本当に実行しますか?", {
      title: "全データの削除",
      action: "完全に削除する",
      destructive: true,
    });
    if (!ok) return;
    await reset.run(async () => {
      const r = await api<{ removed: Record<string, number> }>("/admin/system/reset", { body: { phrase, password } });
      const total = Object.values(r.removed).reduce((a, b) => a + b, 0);
      setResetDone(`全データを削除しました(${total.toLocaleString()}件)。全体管理者のアカウントと設定・規約は残っています`);
      setPhrase("");
      setPassword("");
      await load();
      await refresh();
    });
  };

  const today = jstIso(Date.now());
  const max = jstIso(Date.now() + 184 * 86400000);
  return (
    <>
      <Card className="h-fit">
        <CardHeader>
          <CardTitle>全体の有効期限</CardTitle>
          <CardDescription>
            学園祭全体の使える期限です。設定すると、期限内のウォレットとカードの期限がその日にそろい、これから発行・登録するものもこの日を超えません。前払式支払手段の特例により、今日から184日(6か月)以内に限ります。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
            <Field label="有効期限の日付" hint="その日の23:59まで(日本時間)">
              <DatePicker value={date} onChange={(v) => setDate(v)} min={today} max={max} />
            </Field>
            {info?.date && (
              <p className="rounded-lg bg-muted px-3 py-2 text-sm">
                いまの設定: {info.date.replaceAll("-", "/")} {info.expired ? "(期限切れ)" : ""}
              </p>
            )}
            <ErrorText message={save.error} />
            {note && <p className="text-sm font-medium text-secondary-foreground">{note}</p>}
            <div className="flex gap-2">
              <Button type="submit" className="flex-1" disabled={save.pending || !date || date === info?.date}>
                保存
              </Button>
              {info?.date && (
                <Button type="button" variant="outline" disabled={save.pending} onClick={() => void put(null)}>
                  解除
                </Button>
              )}
            </div>
          </form>
        </CardContent>
      </Card>

      <Card className="h-fit border-destructive/50">
        <CardHeader>
          <CardTitle className="text-destructive">全データの削除</CardTitle>
          <CardDescription>
            全体の有効期限が切れて1か月たったあとにだけできます。監査ログを含む取引・店舗・商品・利用者(全体管理者を除く)・カードをすべて消します。全体管理者のアカウント、設定、利用規約は残ります。元に戻せません。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {!info?.date ? (
            <p className="rounded-lg bg-muted px-3 py-2 text-sm">全体の有効期限が未設定のため、削除はできません。</p>
          ) : !info.canReset ? (
            <p className="rounded-lg bg-muted px-3 py-2 text-sm">{info.resetAvailableAt && `${jstDate(info.resetAvailableAt)}(期限の1か月後)から削除できます。`}</p>
          ) : (
            <>
              <Field label={`確認のため「${RESET_PHRASE}」と入力`}>
                <Input value={phrase} onChange={(e) => setPhrase(e.target.value)} autoComplete="off" />
              </Field>
              <Field label="あなたのパスワード">
                <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
              </Field>
              <ErrorText message={reset.error} />
              <Button variant="destructive" disabled={reset.pending || phrase !== RESET_PHRASE || password === ""} onClick={() => void doReset()}>
                全データを削除する
              </Button>
            </>
          )}
          {resetDone && <p className="text-sm font-medium text-secondary-foreground">{resetDone}</p>}
        </CardContent>
      </Card>
    </>
  );
}
