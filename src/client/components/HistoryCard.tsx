import { ArrowDownLeft, ArrowUpRight, Banknote, RotateCcw, Search } from "lucide-react";
import { useCallback, useState } from "react";
import type { HistoryItem } from "@shared/api";
import { PeriodPicker, type Period } from "@/components/PeriodPicker";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, formatDateTime } from "@/lib/utils";

const LABEL: Record<HistoryItem["kind"], string> = {
  CHARGE: "チャージ",
  CHARGE_CORRECTION: "チャージの訂正",
  PAYMENT: "お支払い",
  REFUND: "返金",
  PAYOUT: "払い戻し(現金)",
  ADJUSTMENT: "残高の調整",
};

function KindIcon({ kind }: { kind: HistoryItem["kind"] }) {
  const cls = "size-5";
  if (kind === "PAYMENT") return <ArrowUpRight className={cls} />;
  if (kind === "REFUND") return <RotateCcw className={cls} />;
  if (kind === "PAYOUT") return <Banknote className={cls} />;
  return <ArrowDownLeft className={cls} />;
}

const TABS = [
  { id: "all", label: "すべて" },
  { id: "charge", label: "チャージ" },
  { id: "payment", label: "お支払い" },
  { id: "refund", label: "返金・払い戻し" },
] as const;
type Tab = (typeof TABS)[number]["id"];

/**
 * 顧客の利用履歴(チャージ・支払い・返金・払い戻し)。
 * データベースの読み取りを節約するため、開いただけでは読み込まず、種類・期間を選んで「検索」したときだけ読む(1回20件、続きは「さらに表示」)
 */
export function HistoryCard(_props: { balance: number | undefined }) {
  const { money } = useAuth();
  const [tab, setTab] = useState<Tab>("all");
  const [period, setPeriod] = useState<Period>({});
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const search = useCallback(
    async (cursor?: string) => {
      setBusy(true);
      setError(null);
      try {
        const p = new URLSearchParams({ kind: tab, limit: "20" });
        if (period.from !== undefined) p.set("from", String(period.from));
        if (period.to !== undefined) p.set("to", String(period.to));
        if (cursor) p.set("cursor", cursor);
        const r = await api<{ items: HistoryItem[]; next: string | null }>(`/wallet/history?${p}`);
        setItems((cur) => (cursor && cur ? [...cur, ...r.items] : r.items));
        setNext(r.next);
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setBusy(false);
      }
    },
    [tab, period],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>利用履歴</CardTitle>
        <CardDescription>チャージ・お支払い・返金の記録です(新しい順)。種類と期間を選んで「検索」してください。</CardDescription>
        <div className="flex flex-wrap gap-1.5 pt-1" role="tablist" aria-label="履歴の種類">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={cn("rounded-full px-3 py-1.5 text-sm font-medium", tab === t.id ? "bg-primary text-primary-foreground" : "bg-accent text-muted-foreground")}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-2 pt-2">
          <PeriodPicker onChange={setPeriod} />
          <Button onClick={() => void search()} disabled={busy}>
            <Search /> 検索
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col divide-y divide-border">
        {error && <p className="py-2 text-sm text-destructive">{error}</p>}
        {items === null && !error && <p className="py-2 text-sm text-muted-foreground">「検索」を押すと、履歴が表示されます</p>}
        {items?.length === 0 && <p className="py-2 text-sm text-muted-foreground">該当する履歴がありません</p>}
        {items?.map((i) => (
          <div key={i.id} className="flex items-center gap-3 py-3">
            <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-full", i.amount > 0 ? "bg-secondary text-primary" : "bg-accent")}>
              <KindIcon kind={i.kind} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">
                {LABEL[i.kind]}
                {i.shopName && ` ・ ${i.shopName}`}
              </p>
              <p className="text-xs text-muted-foreground">
                {formatDateTime(i.createdAt)}
                {i.orderNo && ` ・ 取引番号 ${i.orderNo}`}
              </p>
            </div>
            <div className="shrink-0 text-right">
              <p className={cn("font-bold", i.amount > 0 ? "text-primary" : "")}>{(i.amount > 0 ? "+" : "−") + money(Math.abs(i.amount))}</p>
              <p className="text-xs text-muted-foreground">残高 {money(i.balanceAfter)}</p>
            </div>
          </div>
        ))}
        {next && (
          <div className="pt-3">
            <Button variant="outline" className="w-full" onClick={() => void search(next)} disabled={busy}>
              {busy ? "読み込み中…" : "さらに表示"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
