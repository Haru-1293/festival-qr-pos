import { ArrowLeft } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { ShopOrderRow, ShopSalesSummary } from "@shared/api";
import { PeriodPicker, periodQuery, type Period } from "@/components/PeriodPicker";
import { ErrorText } from "@/components/Shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDateTime } from "@/lib/utils";
import { ShopSales } from "./ShopSales";

const STATUS_LABEL = { ACTIVE: "営業中", SUSPENDED: "停止中", CLOSED: "終了" } as const;
const KIND = { AUTO: "自動割引", COMMON_COUPON: "共通クーポン", ONE_TIME_COUPON: "1回限りクーポン" } as const;
const SOURCE = { CARD: "カード", PHONE: "スマホQR" } as const;

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-2xl font-extrabold tracking-tight">{value}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </Card>
  );
}

/** 店舗別の売上・取引履歴。全体管理者は店舗を選んで(backTo=店舗一覧)、店舗責任者は自店舗を見る */
export function ShopDetailView({ shopId, backTo }: { shopId: string; backTo?: string }) {
  const { money } = useAuth();
  const [period, setPeriod] = useState<Period>({});
  const [sum, setSum] = useState<ShopSalesSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [orders, setOrders] = useState<ShopOrderRow[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [ordersError, setOrdersError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    setSum(null);
    api<ShopSalesSummary>(`/reports/shops/${shopId}/summary${periodQuery(period)}`)
      .then(setSum)
      .catch((e) => setError(errorMessage(e)));
  }, [shopId, period]);

  const loadOrders = useCallback(
    async (before?: number) => {
      setLoading(true);
      setOrdersError(null);
      try {
        const base = periodQuery(period);
        const qs = before ? `${base}${base ? "&" : "?"}before=${before}` : base;
        const r = await api<{ orders: ShopOrderRow[]; next: number | null }>(`/reports/shops/${shopId}/orders${qs}`);
        setOrders((cur) => (before ? [...cur, ...r.orders] : r.orders));
        setNext(r.next);
      } catch (e) {
        setOrdersError(errorMessage(e));
      } finally {
        setLoading(false);
      }
    },
    [shopId, period],
  );
  useEffect(() => {
    void loadOrders();
  }, [loadOrders]);

  const s = sum?.shop;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        {backTo && (
          <Button asChild variant="ghost" size="sm">
            <Link to={backTo}>
              <ArrowLeft className="size-4" /> 店舗一覧
            </Link>
          </Button>
        )}
        {s && (
          <>
            <h1 className="text-xl font-extrabold">{s.name}</h1>
            <Badge variant={s.status === "ACTIVE" ? "default" : "warning"}>{STATUS_LABEL[s.status]}</Badge>
          </>
        )}
      </div>
      <PeriodPicker onChange={setPeriod} />
      <ErrorText message={error} />
      {s && sum && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="純売上(支払 − 返金)" value={money(s.netSales)} sub={`${s.orders}件`} />
          <Stat label="支払額" value={money(s.paidTotal)} sub={`割引前 ${money(s.subtotal)}`} />
          <Stat label="返金" value={money(s.refundedTotal)} />
          <Stat label="割引" value={money(s.discountTotal)} sub={sum.bySource.map((b) => `${SOURCE[b.source]} ${b.orders}件`).join(" ・ ") || undefined} />
          {s.gross && (
            <Stat
              label="粗利(原価を入力した商品)"
              value={money(s.gross.profit)}
              sub={`${s.gross.margin !== null ? `粗利率 ${s.gross.margin}% ・ ` : ""}原価 ${money(s.gross.cost)}${s.gross.coverage !== null ? ` ・ 売上の${s.gross.coverage}%が対象` : ""}`}
            />
          )}
        </div>
      )}

      <ShopSales shopId={shopId} period={period} hideSummary />

      {sum && sum.discounts.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>割引の内訳</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col divide-y divide-border">
            {sum.discounts.map((d, i) => (
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
      )}

      <Card>
        <CardHeader>
          <CardTitle>取引履歴</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col divide-y divide-border">
          <ErrorText message={ordersError} />
          {!loading && orders.length === 0 && !ordersError && <p className="py-2 text-sm text-muted-foreground">この期間の取引はありません</p>}
          {orders.map((o) => (
            <div key={o.id} className="flex items-start justify-between gap-3 py-2.5 text-sm">
              <div className="min-w-0">
                <p className="font-semibold">
                  #{o.orderNo} <span className="text-xs font-normal text-muted-foreground">{formatDateTime(o.paidAt)}</span>
                </p>
                <p className="truncate text-xs text-muted-foreground">{o.items ?? ""}</p>
                <p className="text-xs text-muted-foreground">
                  {SOURCE[o.source]}
                  {o.clerkNickname ? ` ・ ${o.clerkNickname}` : ""}
                  {o.discountTotal > 0 ? ` ・ 割引 ${money(o.discountTotal)}` : ""}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="font-bold">{money(o.totalPaid)}</p>
                {o.refundedTotal > 0 && <p className="text-xs text-destructive">返金 {money(o.refundedTotal)}</p>}
              </div>
            </div>
          ))}
          {next !== null && (
            <Button variant="outline" className="mt-3" disabled={loading} onClick={() => void loadOrders(next)}>
              {loading ? "読み込み中…" : "さらに表示"}
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
