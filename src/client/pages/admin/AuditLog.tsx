import { Download } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { AuditEntryDto } from "@shared/api";
import { ErrorText } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/utils";

const pretty = (j: string | null): string => {
  if (!j) return "";
  try {
    return JSON.stringify(JSON.parse(j), null, 1);
  } catch {
    return j;
  }
};

/** 監査ログ(いつ・誰が・何をしたか)。新しい順、検索と続きの読み込み、CSV */
export function AuditLog() {
  const [entries, setEntries] = useState<AuditEntryDto[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [q, setQ] = useState("");
  const [action, setAction] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (before?: number) => {
      setBusy(true);
      setError(null);
      try {
        const p = new URLSearchParams({ limit: "50" });
        if (before !== undefined) p.set("before", String(before));
        if (q.trim()) p.set("q", q.trim());
        if (action.trim()) p.set("action", action.trim());
        const r = await api<{ entries: AuditEntryDto[]; next: number | null }>(`/reports/audit?${p}`);
        setEntries((cur) => (before === undefined ? r.entries : [...cur, ...r.entries]));
        setNext(r.next);
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setBusy(false);
      }
    },
    [q, action],
  );
  useEffect(() => {
    void load();
    // 検索語は「検索」ボタンで反映する(入力のたびには読み込まない)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void load();
        }}
      >
        <label className="flex min-w-40 flex-1 flex-col gap-1 text-xs text-muted-foreground">
          操作(先頭一致。例: refund, discount, settings)
          <Input value={action} onChange={(e) => setAction(e.target.value)} maxLength={60} className="h-10" />
        </label>
        <label className="flex min-w-40 flex-1 flex-col gap-1 text-xs text-muted-foreground">
          操作者名・対象ID
          <Input value={q} onChange={(e) => setQ(e.target.value)} maxLength={60} className="h-10" />
        </label>
        <Button type="submit" disabled={busy}>
          検索
        </Button>
        <Button asChild variant="outline">
          <a href="/api/reports/audit.csv" download>
            <Download className="size-4" /> CSV
          </a>
        </Button>
      </form>
      <ErrorText message={error} />
      <Card>
        <CardContent className="flex flex-col divide-y divide-border">
          {entries.length === 0 && !busy && <p className="py-2 text-sm text-muted-foreground">記録がありません</p>}
          {entries.map((e) => (
            <div key={e.id} className="py-2.5 text-sm">
              <button type="button" className="flex w-full flex-col gap-0.5 text-left" onClick={() => setOpen(open === e.id ? null : e.id)} aria-expanded={open === e.id}>
                <span className="flex items-baseline justify-between gap-2">
                  <span className="font-mono text-xs font-bold">{e.action}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{formatDateTime(e.createdAt)}</span>
                </span>
                <span className="text-xs text-muted-foreground">
                  {e.actorNickname ?? "システム"}
                  {e.actorRole ? `(${e.actorRole})` : ""}
                  {e.targetType ? ` ・ ${e.targetType}` : ""}
                  {e.reason ? ` ・ 理由: ${e.reason}` : ""}
                </span>
              </button>
              {open === e.id && (
                <div className="mt-2 grid gap-2 rounded-lg bg-muted p-2 text-xs sm:grid-cols-2">
                  {e.targetId && <p className="break-all sm:col-span-2">対象ID: {e.targetId}</p>}
                  {e.before && <pre className="overflow-x-auto whitespace-pre-wrap break-all">変更前{"\n"}{pretty(e.before)}</pre>}
                  {e.after && <pre className="overflow-x-auto whitespace-pre-wrap break-all">変更後{"\n"}{pretty(e.after)}</pre>}
                </div>
              )}
            </div>
          ))}
          {next !== null && (
            <Button variant="outline" className="mt-3" disabled={busy} onClick={() => void load(next)}>
              {busy ? "読み込み中…" : "さらに読み込む"}
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
