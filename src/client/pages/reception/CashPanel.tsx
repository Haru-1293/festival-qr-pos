import { Landmark, Pencil } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { CashEventDto, CashEventKind, ClosingDto, ReceptionSummary } from "@shared/api";
import { ErrorText, Field } from "@/components/Shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction } from "@/lib/useAction";
import { useRequestId } from "@/lib/useRequestId";
import { formatDateTime, signedYen, yen } from "@/lib/utils";
import { useConfirm } from "@/lib/confirm";

export const KIND_LABEL: Record<CashEventKind, string> = {
  CHARGE: "チャージ受領",
  PAYOUT: "払い戻し(出金)",
  DROP: "途中回収",
  CORRECTION: "訂正",
};

const onlyDigits = (s: string) => s.replace(/[^0-9]/g, "");

/** 受付の現金: 手元にあるはずの現金、途中回収、訂正、締め */
export function CashPanel({ refreshKey, onChanged }: { refreshKey: number; onChanged: () => void }) {
  const { money } = useAuth();
  const [summary, setSummary] = useState<ReceptionSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSummary(await api<ReceptionSummary>("/reception/summary"));
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "読み込めませんでした");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const changed = () => {
    onChanged();
    void load();
  };

  if (!summary) return <p className="p-6 text-center text-sm text-muted-foreground">{loadError ?? "読み込み中…"}</p>;
  const t = summary.totals;

  return (
    <div className="flex flex-col gap-4">
      <Card className="overflow-hidden">
        <div className="bg-secondary px-4 py-4">
          <p className="text-sm text-secondary-foreground">手元にあるはずの現金(未締め)</p>
          <p className="text-4xl font-extrabold tracking-tight">{signedYen(t.expected).replace("+", "")}</p>
        </div>
        <CardContent className="grid grid-cols-2 gap-x-4 gap-y-1 pt-3 text-sm">
          <span className="text-muted-foreground">チャージ受領</span>
          <span className="text-right font-semibold">{yen(t.charge)}</span>
          <span className="text-muted-foreground">払い戻し(出金)</span>
          <span className="text-right font-semibold">−{yen(t.payout)}</span>
          <span className="text-muted-foreground">途中回収</span>
          <span className="text-right font-semibold">−{yen(t.drop)}</span>
          <span className="text-muted-foreground">訂正</span>
          <span className="text-right font-semibold">{signedYen(t.correction)}</span>
          <span className="col-span-2 pt-1 text-xs text-muted-foreground">計算式: チャージ − 払い戻し − 途中回収 ± 訂正({t.eventCount}件)</span>
        </CardContent>
      </Card>

      <DropForm held={t.expected} onDone={changed} />
      <CloseForm summary={summary} onDone={changed} />

      <Card>
        <CardHeader>
          <CardTitle>最近の記録</CardTitle>
          <CardDescription>入力ミスは「訂正」で直せます(元の記録は残り、差額だけが追加されます)。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col divide-y divide-border">
          {summary.recent.length === 0 && <p className="py-2 text-sm text-muted-foreground">まだ記録がありません</p>}
          {summary.recent.map((e) => (
            <EventRow key={e.id} e={e} money={money} onDone={changed} />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function DropForm({ held, onDone }: { held: number; onDone: () => void }) {
  const confirm = useConfirm();
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [localErr, setLocalErr] = useState<string | null>(null);
  const { pending, error, run } = useAction();
  const reqId = useRequestId();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const n = Number(amount);
    if (!Number.isInteger(n) || n <= 0) return;
    if (n > held) return setLocalErr(`手元にあるはずの現金(${yen(held)})を超えて回収することはできません`);
    setLocalErr(null);
    if (
      !(await confirm(`${yen(n)} を途中回収として記録しますか?`, {
        destructive: true,
      }))
    )
      return;
    void run(async () => {
      await api("/reception/cash/drop", {
        body: { requestId: reqId.get(), amount: n, note: note || undefined },
      });
      reqId.renew();
      setSaved(`${yen(n)} を記録しました`);
      setAmount("");
      setNote("");
      onDone();
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Landmark className="size-5" /> 途中回収
        </CardTitle>
        <CardDescription>受付に溜まった現金を、金庫などへ移したときに記録します。回収できるのは、手元にあるはずの現金({yen(held)})までです。</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <Field label="回収した現金(円)">
            <Input inputMode="numeric" pattern="[0-9]*" value={amount} onChange={(e) => setAmount(onlyDigits(e.target.value))} className="h-12 text-lg font-bold" required />
          </Field>
          <Field label="メモ(任意)">
            <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="例: 金庫へ" />
          </Field>
          <ErrorText message={localErr ?? error} />
          {saved && <p className="text-sm font-medium text-secondary-foreground">{saved}</p>}
          <Button type="submit" variant="outline" disabled={pending || !amount}>
            {pending ? "記録中…" : "途中回収を記録"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function CloseForm({ summary, onDone }: { summary: ReceptionSummary; onDone: () => void }) {
  const confirm = useConfirm();
  const [counted, setCounted] = useState("");
  const [note, setNote] = useState("");
  const [result, setResult] = useState<ClosingDto | null>(null);
  const { pending, error, run } = useAction();

  if (!summary.canCloseSelf) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>現金の締め</CardTitle>
          <CardDescription>現在の設定では、締めは全体管理者が行います。担当を交代するときは、現金を数えて管理者に渡してください。</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const hasCount = counted !== "";
    const msg = hasCount ? `数えた現金 ${yen(Number(counted))} で締めます。締めた記録は変更できません。よろしいですか?` : "数えた現金の入力なしで締めます。締めた記録は変更できません。よろしいですか?";
    if (!(await confirm(msg, { destructive: true }))) return;
    void run(async () => {
      const r = await api<{ closing: ClosingDto }>("/cash/closings", {
        body: {
          target: "SELF",
          countedAmount: hasCount ? Number(counted) : null,
          note: note || undefined,
        },
      });
      setResult(r.closing);
      setCounted("");
      setNote("");
      onDone();
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>現金の締め(担当交代)</CardTitle>
        <CardDescription>手元の現金を数えて入力すると、差異が記録されます(入力は任意)。締めた記録は変更できません。</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <p className="rounded-lg bg-muted px-3 py-2 text-sm">
            あるはずの現金 <b>{yen(summary.totals.expected)}</b>
          </p>
          <Field label="数えた現金(円・任意)">
            <Input inputMode="numeric" pattern="[0-9]*" value={counted} onChange={(e) => setCounted(onlyDigits(e.target.value))} className="h-12 text-lg font-bold" />
          </Field>
          <Field label="メモ(任意)">
            <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
          </Field>
          <ErrorText message={error} />
          <Button type="submit" disabled={pending || summary.totals.eventCount === 0}>
            {pending ? "締め中…" : "この内容で締める"}
          </Button>
          {summary.totals.eventCount === 0 && <p className="text-xs text-muted-foreground">締める記録がありません</p>}
        </form>
        {result && (
          <div className="mt-3 rounded-lg bg-secondary px-3 py-2 text-sm">
            <p className="font-bold">締めました({formatDateTime(result.closedAt)})</p>
            <p>期待額 {yen(result.expectedAmount)}</p>
            {result.countedAmount !== null && <p>数えた額 {yen(result.countedAmount)}</p>}
            {result.difference !== null && <p className={result.difference === 0 ? "" : "font-bold text-destructive"}>差異 {result.difference === 0 ? "なし" : signedYen(result.difference)}</p>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function EventRow({ e, money, onDone }: { e: CashEventDto; money: (n: number) => string; onDone: () => void }) {
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [newCash, setNewCash] = useState("");
  const [reason, setReason] = useState("");
  const { pending, error, run } = useAction();
  const reqId = useRequestId();
  const canCorrect = e.kind === "CHARGE" && e.ledgerId !== null;
  const corrected = e.kind === "CHARGE" && e.effectiveCash !== null && e.effectiveCash !== e.amount;

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    const n = Number(newCash);
    if (!Number.isInteger(n) || n < 0 || !e.ledgerId) return;
    if (!(await confirm(`受領額を ${yen(n)} に訂正します(残高も同じだけ増減します)。よろしいですか?`, { destructive: true }))) return;
    void run(async () => {
      await api(`/reception/charge/${e.ledgerId}/correct`, {
        body: { requestId: reqId.get(), newCashAmount: n, reason },
      });
      reqId.renew();
      setEditing(false);
      setNewCash("");
      setReason("");
      onDone();
    });
  };

  return (
    <div className="flex flex-col gap-2 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-1.5 text-sm font-semibold">
            {KIND_LABEL[e.kind]}
            {e.customerNickname && <span className="font-normal text-muted-foreground">{e.customerNickname}</span>}
            {e.closed && <Badge variant="muted">締め済み</Badge>}
          </p>
          <p className="text-xs text-muted-foreground">
            {formatDateTime(e.createdAt)}
            {e.reason ? ` ・ ${e.reason}` : ""}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="font-bold">{e.kind === "CORRECTION" ? signedYen(e.amount) : yen(e.amount)}</p>
          {corrected && <p className="text-xs text-amber-700">訂正後 {yen(e.effectiveCash ?? 0)}</p>}
        </div>
      </div>
      {canCorrect && !editing && (
        <div>
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            <Pencil className="!size-4" /> 訂正
          </Button>
        </div>
      )}
      {editing && (
        <form onSubmit={submit} className="flex flex-col gap-2 rounded-lg bg-muted p-3">
          <p className="text-xs text-muted-foreground">
            現在の受領額 {yen(e.effectiveCash ?? e.amount)}(チャージ {money(e.effectiveCash ?? e.amount)})
          </p>
          <Field label="正しい受領額(円)">
            <Input inputMode="numeric" pattern="[0-9]*" value={newCash} onChange={(ev) => setNewCash(onlyDigits(ev.target.value))} required />
          </Field>
          <Field label="訂正の理由">
            <Input value={reason} onChange={(ev) => setReason(ev.target.value)} maxLength={200} placeholder="例: 入力ミス" required />
          </Field>
          <ErrorText message={error} />
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setEditing(false)} disabled={pending}>
              やめる
            </Button>
            <Button type="submit" size="sm" disabled={pending || newCash === "" || !reason.trim()}>
              {pending ? "訂正中…" : "訂正する"}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
