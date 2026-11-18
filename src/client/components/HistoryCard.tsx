import { ArrowDownLeft, ArrowUpRight, Banknote, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { HistoryItem } from "@shared/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";
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

/** 顧客の利用履歴(チャージ・支払い・返金・払い戻し)。残高が変わったら読み直す */
export function HistoryCard({ balance }: { balance: number | undefined }) {
  const { money } = useAuth();
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const load = useCallback(async () => {
    try {
      setItems((await api<{ items: HistoryItem[] }>("/wallet/history")).items);
    } catch {
      /* 取得できなければ、前回の表示のまま */
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, balance]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>利用履歴</CardTitle>
        <CardDescription>チャージ・お支払い・返金の記録です(新しい順)。</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col divide-y divide-border">
        {items === null && <p className="py-2 text-sm text-muted-foreground">読み込み中…</p>}
        {items?.length === 0 && <p className="py-2 text-sm text-muted-foreground">まだ履歴がありません</p>}
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
      </CardContent>
    </Card>
  );
}
