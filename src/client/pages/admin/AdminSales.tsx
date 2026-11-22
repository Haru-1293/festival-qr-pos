import { Download } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { SalesReport } from "@shared/api";
import { PeriodPicker, periodQuery, type Period } from "@/components/PeriodPicker";
import { ErrorText } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { ShopSales } from "../shop/ShopSales";

const TimeSeriesChart = lazy(() => import("@/components/SalesCharts").then((m) => ({ default: m.TimeSeriesChart })));
const ShopShareChart = lazy(() => import("@/components/SalesCharts").then((m) => ({ default: m.ShopShareChart })));

const KIND: Record<string, string> = {
  AUTO: "全ユーザー割引",
  COMMON_COUPON: "共通クーポン",
  ONE_TIME_COUPON: "使い捨てクーポン",
};

/** 全体管理者の売上・精算。各店舗の純売上(支払額 − 返金額)が精算の対象額 */
export function AdminSales() {
  const { money } = useAuth();
  const [period, setPeriod] = useState<Period>({});
  const [r, setR] = useState<SalesReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    setError(null);
    api<SalesReport>(`/reports/sales${periodQuery(period)}`)
      .then(setR)
      .catch((e) => setError(errorMessage(e)));
  }, [period]);
  return (
    <div className="flex flex-col gap-4">
      <PeriodPicker onChange={setPeriod} />
      <ErrorText message={error} />
      {r && (
        <>
          <Suspense fallback={<p className="p-6 text-center text-sm text-muted-foreground">グラフを読み込み中…</p>}>
            <div className="grid gap-4 xl:grid-cols-2">
              <TimeSeriesChart period={period} />
              <ShopShareChart shops={r.shops} />
            </div>
          </Suspense>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between gap-2">
                <span>店舗ごとの売上</span>
                <Button asChild variant="outline" size="sm">
                  <a href={`/api/reports/sales.csv${periodQuery(period)}`} download>
                    <Download className="size-4" /> CSV
                  </a>
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col divide-y divide-border">
              {r.shops.map((s) => (
                <div key={s.shopId} className="flex flex-col gap-2 py-3">
                  <button type="button" className="flex items-center justify-between gap-3 text-left" onClick={() => setOpen(open === s.shopId ? null : s.shopId)} aria-expanded={open === s.shopId}>
                    <div className="min-w-0">
                      <p className="truncate font-semibold">{s.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {s.orders}件 ・ 支払 {money(s.paidTotal)} ・ 返金 {money(s.refundedTotal)}
                        {s.discountTotal > 0 ? ` ・ 割引 ${money(s.discountTotal)}` : ""}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-xs text-muted-foreground">純売上</p>
                      <p className="text-xl font-extrabold tracking-tight">{money(s.netSales)}</p>
                    </div>
                  </button>
                  {open === s.shopId && (
                    <>
                      <Button asChild variant="outline" size="sm" className="self-start">
                        <Link to={`/admin/shops/${s.shopId}`}>店舗の詳細ページを開く</Link>
                      </Button>
                      <ShopSales shopId={s.shopId} period={period} />
                    </>
                  )}
                </div>
              ))}
              <div className={cn("flex items-center justify-between pt-3 text-sm font-bold")}>
                <span>全店舗の合計 ・ {r.totals.orders}件</span>
                <span className="text-xl font-extrabold tracking-tight">{money(r.totals.netSales)}</span>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>割引の内訳</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col divide-y divide-border">
              {r.discounts.length === 0 && <p className="py-2 text-sm text-muted-foreground">この期間に使われた割引はありません</p>}
              {r.discounts.map((d, i) => (
                <div key={i} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <div className="min-w-0">
                    <p className="truncate font-semibold">{d.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {KIND[d.kind]} ・ {d.count}回
                    </p>
                  </div>
                  <p className="shrink-0 font-bold">-{money(d.amount)}</p>
                </div>
              ))}
            </CardContent>
          </Card>
          <p className="text-xs text-muted-foreground">純売上 = 支払額 − 返金額(割引は支払額にすでに反映)。店舗への精算の方法は運用に合わせて決めてください。</p>
        </>
      )}
    </div>
  );
}
