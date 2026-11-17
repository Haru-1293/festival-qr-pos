import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { AdminCashSummary, CashTotals, ClosingDto } from "@shared/api";
import { ErrorText, Field } from "@/components/Shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useAction } from "@/lib/useAction";
import { formatDateTime, signedYen, yen } from "@/lib/utils";

const MODE_LABEL = { DAY: "日次(全受付をまとめて管理者が締める)", SHIFT: "担当者交代ごと(受付が自分で締める)", MANUAL: "手動(管理者が必要なときに締める)" } as const;

function TotalsGrid({ t }: { t: CashTotals }) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-sm">
      <span className="text-muted-foreground">チャージ受領</span>
      <span className="text-right font-semibold">{yen(t.charge)}</span>
      <span className="text-muted-foreground">払い戻し(出金)</span>
      <span className="text-right font-semibold">−{yen(t.payout)}</span>
      <span className="text-muted-foreground">途中回収</span>
      <span className="text-right font-semibold">−{yen(t.drop)}</span>
      <span className="text-muted-foreground">訂正</span>
      <span className="text-right font-semibold">{signedYen(t.correction)}</span>
    </div>
  );
}

/** 全体管理者: 受付の現金(未締め)の集計と、締め */
export function AdminCash() {
  const [summary, setSummary] = useState<AdminCashSummary | null>(null);
  const [closings, setClosings] = useState<ClosingDto[]>([]);
  const [target, setTarget] = useState("ALL");
  const [counted, setCounted] = useState("");
  const [note, setNote] = useState("");
  const [result, setResult] = useState<ClosingDto | null>(null);
  const { pending, error, run } = useAction();

  const load = useCallback(async () => {
    const [s, c] = await Promise.all([api<AdminCashSummary>("/cash/admin-summary"), api<{ closings: ClosingDto[] }>("/cash/closings")]);
    setSummary(s);
    setClosings(c.closings);
  }, []);
  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  const selected = target === "ALL" ? summary?.total : summary?.users.find((u) => u.userId === target)?.totals;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const hasCount = counted !== "";
    const label = target === "ALL" ? "全受付" : (summary?.users.find((u) => u.userId === target)?.nickname ?? "");
    if (!window.confirm(`${label}の現金を締めます。締めた記録は変更できません。よろしいですか?`)) return;
    void run(async () => {
      const r = await api<{ closing: ClosingDto }>("/cash/closings", {
        body: {
          target: target === "ALL" ? "ALL" : "USER",
          userId: target === "ALL" ? undefined : target,
          countedAmount: hasCount ? Number(counted) : null,
          note: note || undefined,
        },
      });
      setResult(r.closing);
      setCounted("");
      setNote("");
      setTarget("ALL");
      await load();
    });
  };

  if (!summary) return <p className="p-6 text-center text-sm text-muted-foreground">読み込み中…</p>;

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="flex flex-col gap-4">
        <Card className="overflow-hidden">
          <div className="bg-secondary px-4 py-4">
            <p className="text-sm text-secondary-foreground">受付全体の、あるはずの現金(未締め)</p>
            <p className="text-4xl font-extrabold tracking-tight">{yen(summary.total.expected)}</p>
            <p className="mt-1 text-xs text-muted-foreground">締めの単位: {MODE_LABEL[summary.closingMode]}</p>
          </div>
          <CardContent className="pt-3">
            <TotalsGrid t={summary.total} />
          </CardContent>
        </Card>

        {summary.users.map((u) => (
          <Card key={u.userId}>
            <CardHeader>
              <CardTitle className="flex items-center justify-between gap-2">
                <span className="truncate">{u.nickname}</span>
                <span className="shrink-0">{yen(u.totals.expected)}</span>
              </CardTitle>
              <CardDescription>未締め {u.totals.eventCount} 件</CardDescription>
            </CardHeader>
            <CardContent>
              <TotalsGrid t={u.totals} />
            </CardContent>
          </Card>
        ))}
        {summary.users.length === 0 && <p className="text-sm text-muted-foreground">未締めの現金記録はありません。</p>}
      </div>

      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>現金を締める</CardTitle>
            <CardDescription>締めた記録は変更できません。数えた現金の入力は任意で、入力すると差異(数えた額 − あるはずの額)が記録されます。</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={submit} className="flex flex-col gap-3">
              <Field label="対象">
                <select className="h-12 rounded-lg border border-input bg-card px-3 text-base" value={target} onChange={(e) => setTarget(e.target.value)}>
                  <option value="ALL">全受付をまとめて</option>
                  {summary.users.map((u) => (
                    <option key={u.userId} value={u.userId}>
                      {u.nickname}だけ
                    </option>
                  ))}
                </select>
              </Field>
              <p className="rounded-lg bg-muted px-3 py-2 text-sm">
                あるはずの現金 <b>{yen(selected?.expected ?? 0)}</b>({selected?.eventCount ?? 0}件)
              </p>
              <Field label="数えた現金(円・任意)">
                <Input inputMode="numeric" pattern="[0-9]*" value={counted} onChange={(e) => setCounted(e.target.value.replace(/[^0-9]/g, ""))} className="h-12 text-lg font-bold" />
              </Field>
              <Field label="メモ(任意)">
                <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
              </Field>
              <ErrorText message={error} />
              <Button type="submit" disabled={pending || (selected?.eventCount ?? 0) === 0}>
                {pending ? "締め中…" : "この内容で締める"}
              </Button>
            </form>
            {result && (
              <div className="mt-3 rounded-lg bg-secondary px-3 py-2 text-sm">
                <p className="font-bold">締めました({formatDateTime(result.closedAt)})</p>
                <p>期待額 {yen(result.expectedAmount)}</p>
                {result.countedAmount !== null && <p>数えた額 {yen(result.countedAmount)}</p>}
                {result.difference !== null && (
                  <p className={result.difference === 0 ? "" : "font-bold text-destructive"}>差異 {result.difference === 0 ? "なし" : signedYen(result.difference)}</p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>締めの履歴</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col divide-y divide-border">
            {closings.length === 0 && <p className="py-2 text-sm text-muted-foreground">まだ締めの記録がありません</p>}
            {closings.map((c) => (
              <div key={c.id} className="flex flex-col gap-0.5 py-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-semibold">
                    {formatDateTime(c.closedAt)}
                    <Badge variant="muted" className="ml-2">
                      {c.scopeUserNickname ? c.scopeUserNickname : c.scopeKind === "MANUAL" ? "手動(全受付)" : "日次(全受付)"}
                    </Badge>
                  </p>
                  <p className="font-bold">{yen(c.expectedAmount)}</p>
                </div>
                <p className="text-xs text-muted-foreground">
                  {c.countedAmount !== null ? `数えた額 ${yen(c.countedAmount)}` : "数えた額の入力なし"}
                  {c.difference !== null && c.difference !== 0 && <span className="font-bold text-destructive"> ・ 差異 {signedYen(c.difference)}</span>}
                  {c.difference === 0 && " ・ 差異なし"}
                  {` ・ 担当 ${c.closedByNickname ?? "-"}`}
                  {c.note ? ` ・ ${c.note}` : ""}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
