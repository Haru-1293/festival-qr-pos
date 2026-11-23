import { Download } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import type { ProductSalesRow } from "@shared/api";
import { PeriodPicker, periodQuery, type Period } from "@/components/PeriodPicker";
import { ErrorText } from "@/components/Shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";

const TimeSeriesChart = lazy(() => import("@/components/SalesCharts").then((m) => ({ default: m.TimeSeriesChart })));
const ProductChart = lazy(() => import("@/components/SalesCharts").then((m) => ({ default: m.ProductChart })));

/** 店舗の商品別売上と注文CSV(店舗責任者は自店舗、全体管理者は店舗を選んで) */
export function ShopSales({ shopId, period: fixedPeriod, hideSummary }: { shopId: string; period?: Period; hideSummary?: boolean }) {
  const { money } = useAuth();
  const [ownPeriod, setPeriod] = useState<Period>({});
  // 全体管理者の売上画面から開くときは、そちらで選んだ期間を使う(ここでは選ばせない)
  const period = fixedPeriod ?? ownPeriod;
  const [rows, setRows] = useState<ProductSalesRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setError(null);
    api<{ products: ProductSalesRow[] }>(`/reports/shops/${shopId}/products${periodQuery(period)}`)
      .then((r) => setRows(r.products))
      .catch((e) => setError(errorMessage(e)));
  }, [shopId, period]);
  const paid = rows?.reduce((a, r) => a + r.paid, 0) ?? 0;
  const qty = rows?.reduce((a, r) => a + r.quantity, 0) ?? 0;
  return (
    <div className="flex flex-col gap-4">
      {!fixedPeriod && <PeriodPicker onChange={setPeriod} />}
      <ErrorText message={error} />
      {rows && !hideSummary && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Card className="p-4">
            <p className="text-xs text-muted-foreground">売上(支払額)</p>
            <p className="text-3xl font-extrabold">{money(paid)}</p>
          </Card>
          <Card className="p-4">
            <p className="text-xs text-muted-foreground">売れた数</p>
            <p className="text-3xl font-extrabold">{qty}<span className="ml-1 text-base font-medium">個</span></p>
          </Card>
        </div>
      )}
      <Suspense fallback={<p className="p-6 text-center text-sm text-muted-foreground">グラフを読み込み中…</p>}>
        <div className="grid gap-4 xl:grid-cols-2">
          <TimeSeriesChart shopId={shopId} period={period} />
          {rows && <ProductChart rows={rows} />}
        </div>
      </Suspense>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between gap-2">
            <span>商品別の売上</span>
            <Button asChild variant="outline" size="sm">
              <a href={`/api/reports/shops/${shopId}/orders.csv${periodQuery(period)}`} download>
                <Download className="size-4" /> 注文CSV
              </a>
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col divide-y divide-border">
          {rows && rows.length === 0 && <p className="py-2 text-sm text-muted-foreground">この期間の売上はまだありません</p>}
          {rows?.map((r) => (
            <div key={`${r.kind}-${r.name}`} className="flex items-center justify-between gap-3 py-2.5 text-sm">
              <div className="min-w-0">
                <p className="truncate font-semibold">
                  {r.name} {r.kind === "SET" && <Badge variant="muted">セット</Badge>}
                </p>
                <p className="text-xs text-muted-foreground">
                  {r.quantity}個{r.discount > 0 ? ` ・ 割引 ${money(r.discount)}` : ""}
                  {r.cost !== null && r.cost !== undefined && r.costSales !== null && r.costSales !== undefined && ` ・ 粗利 ${money(r.costSales - r.cost)}`}
                </p>
              </div>
              <p className="shrink-0 font-bold">{money(r.paid)}</p>
            </div>
          ))}
          {rows && rows.length > 0 && (
            <div className="flex justify-between pt-3 text-sm font-bold">
              <span>合計 {qty}個</span>
              <span>{money(paid)}</span>
            </div>
          )}
          <p className="pt-3 text-xs text-muted-foreground">金額は支払額ベースです(返金は含みません)。粗利は、原価を入力した商品の売上(返金を引いたあと)から原価を引いた額です。</p>
        </CardContent>
      </Card>
    </div>
  );
}
