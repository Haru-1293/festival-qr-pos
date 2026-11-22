import { useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ProductSalesRow, SalesRow, TimeSeriesPoint } from "@shared/api";
import { periodQuery, type Period } from "@/components/PeriodPicker";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";

const COLORS = ["#06c755", "#0ea5e9", "#f59e0b", "#a855f7", "#ef4444", "#14b8a6", "#64748b", "#ec4899"];
const jst = (t: number, bucket: "hour" | "day") =>
  new Date(t).toLocaleString("ja-JP", bucket === "hour" ? { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "numeric" } : { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric" });
const compact = (n: number) => (Math.abs(n) >= 10000 ? `${Math.round(n / 1000) / 10}万` : String(n));

/** 売り上げの推移(時間帯別・日別)。shopId を省くと全店舗 */
export function TimeSeriesChart({ shopId, period }: { shopId?: string; period: Period }) {
  const { money } = useAuth();
  const [bucket, setBucket] = useState<"hour" | "day">("hour");
  const [points, setPoints] = useState<TimeSeriesPoint[] | null>(null);
  useEffect(() => {
    const q = periodQuery(period);
    const path = shopId ? `/reports/shops/${shopId}/timeseries` : "/reports/timeseries";
    api<{ points: TimeSeriesPoint[] }>(`${path}${q}${q ? "&" : "?"}bucket=${bucket}`)
      .then((r) => setPoints(r.points))
      .catch(() => setPoints([]));
  }, [shopId, period, bucket]);
  const data = (points ?? []).map((p) => ({ label: jst(p.t, bucket), 売上: p.netSales, 件数: p.orders }));
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-2">
          <span>売上の推移</span>
          <Tabs value={bucket} onValueChange={(v) => setBucket(v as "hour" | "day")}>
            <TabsList className="h-9">
              <TabsTrigger value="hour" className="h-7 px-3 text-xs">時間帯別</TabsTrigger>
              <TabsTrigger value="day" className="h-7 px-3 text-xs">日別</TabsTrigger>
            </TabsList>
          </Tabs>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {points && data.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">この期間の売上はまだありません</p>
        ) : (
          <div className="h-64 w-full" role="img" aria-label="売上の推移の棒グラフ">
            <ResponsiveContainer>
              <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={compact} width={44} />
                <Tooltip formatter={(v, n) => (n === "売上" ? money(Number(v)) : `${v}件`)} />
                <Bar dataKey="売上" fill="#06c755" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** 商品別の売上(上位をグラフで) */
export function ProductChart({ rows }: { rows: ProductSalesRow[] }) {
  const { money } = useAuth();
  const top = [...rows].sort((a, b) => b.paid - a.paid).slice(0, 8);
  if (top.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>売れている商品(金額)</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="w-full" style={{ height: 40 + top.length * 36 }} role="img" aria-label="商品別売上の横棒グラフ">
          <ResponsiveContainer>
            <BarChart data={top.map((r) => ({ name: r.name, 売上: r.paid }))} layout="vertical" margin={{ top: 0, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={compact} />
              <YAxis type="category" dataKey="name" tick={{ fontSize: 12 }} width={90} />
              <Tooltip formatter={(v) => money(Number(v))} />
              <Bar dataKey="売上" radius={[0, 4, 4, 0]}>
                {top.map((_, i) => (
                  <Cell key={i} fill={COLORS[i % COLORS.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

/** 店舗ごとの純売上の割合(全体管理者) */
export function ShopShareChart({ shops }: { shops: SalesRow[] }) {
  const { money } = useAuth();
  const data = shops.filter((s) => s.netSales > 0).map((s) => ({ name: s.name, value: s.netSales }));
  if (data.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>店舗ごとの売上の割合</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-64 w-full" role="img" aria-label="店舗別売上の円グラフ">
          <ResponsiveContainer>
            <PieChart>
              <Pie data={data} dataKey="value" nameKey="name" innerRadius="45%" outerRadius="80%" paddingAngle={2} label={(e) => e.name}>
                {data.map((_, i) => (
                  <Cell key={i} fill={COLORS[i % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip formatter={(v) => money(Number(v))} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
