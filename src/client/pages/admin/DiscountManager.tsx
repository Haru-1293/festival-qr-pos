import { Percent } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { AutoDiscountDto, AutoDiscountInput, CouponDto, CouponInput, DiscountMethod, ShopDto } from "@shared/api";
import { CouponForm, CouponList, RuleFields, STATE_LABEL, emptyRule, ruleBody, type RuleForm } from "@/components/CouponPanel";
import { ErrorText } from "@/components/Shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction } from "@/lib/useAction";
import { formatDateTime } from "@/lib/utils";
import { useConfirm } from "@/lib/confirm";
import { Checkbox } from "@/components/ui/checkbox";

/** 全体管理者の「割引・クーポン」管理(仕様 v0.2 §14) */
export function DiscountManager() {
  const confirm = useConfirm();
  const { money } = useAuth();
  const [autos, setAutos] = useState<AutoDiscountDto[]>([]);
  const [coupons, setCoupons] = useState<CouponDto[]>([]);
  const [shops, setShops] = useState<ShopDto[]>([]);
  const [af, setAf] = useState<RuleForm>(emptyRule("全品10%引き"));
  const [aCombine, setACombine] = useState(true);
  const createAuto = useAction();
  const row = useAction();

  const load = useCallback(async () => {
    const [d, s] = await Promise.all([api<{ autos: AutoDiscountDto[]; coupons: CouponDto[] }>("/discounts"), api<{ shops: ShopDto[] }>("/admin/shops")]);
    setAutos(d.autos);
    setCoupons(d.coupons);
    setShops(s.shops);
  }, []);
  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  const shopNames = (ids: string[]) => (ids.length === 0 ? "全店舗" : ids.map((i) => shops.find((s) => s.id === i)?.displayName ?? "?").join("、"));
  const desc = (r: { method: DiscountMethod; value: number; minOrderAmount: number | null; maxDiscountAmount: number | null }) =>
    `${r.method === "PERCENT" ? `${r.value}%引き` : `${money(r.value)}引き`}${r.minOrderAmount ? ` ・ ${money(r.minOrderAmount)}以上` : ""}${r.maxDiscountAmount ? ` ・ 最大${money(r.maxDiscountAmount)}` : ""}`;
  const period = (r: { startsAt: number | null; endsAt: number | null }) => `${r.startsAt ? formatDateTime(r.startsAt) : "すぐ"} 〜 ${r.endsAt ? formatDateTime(r.endsAt) : "止めるまで"}`;

  const submitAuto = (e: FormEvent) => {
    e.preventDefault();
    void createAuto.run(async () => {
      const body: AutoDiscountInput = {
        ...ruleBody(af),
        combinableWithCoupon: aCombine,
      };
      await api("/discounts/auto", { body });
      await load();
    });
  };
  const setAutoStatus = async (a: AutoDiscountDto, status: "ACTIVE" | "STOPPED") => {
    if (status === "STOPPED" && !(await confirm(`「${a.name}」を停止しますか?\nレジの会計からすぐに外れます。`, { destructive: true }))) return;
    void row.run(async () => {
      await api(`/discounts/auto/${a.id}/status`, { body: { status } });
      await load();
    });
  };
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Percent className="size-5" /> 全ユーザー対象割引
            </CardTitle>
            <CardDescription>条件を満たす会計に自動で適用されます(コード入力は不要)。</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={submitAuto} className="flex flex-col gap-3">
              <RuleFields f={af} set={(p) => setAf({ ...af, ...p })} shops={shops} />
              <label className="flex items-center gap-2 text-sm">
                <Checkbox className="size-4" checked={aCombine} onCheckedChange={(c) => setACombine(c === true)} />
                クーポンと併用できる
              </label>
              <ErrorText message={createAuto.error} />
              <Button type="submit" disabled={createAuto.pending || !af.value}>
                {createAuto.pending ? "作成中…" : "割引を開始する"}
              </Button>
            </form>
          </CardContent>
        </Card>

        <CouponForm shops={shops} create={async (body: CouponInput) => (await api<{ codes: string[] }>("/discounts/coupons", { body })).codes} onCreated={load} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>全ユーザー対象割引の一覧</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col divide-y divide-border">
          <ErrorText message={row.error} />
          {autos.length === 0 && <p className="py-2 text-sm text-muted-foreground">まだありません</p>}
          {autos.map((a) => (
            <div key={a.id} className="flex flex-col gap-1 py-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <p className="font-semibold">
                  {a.name}:{desc(a)}
                </p>
                <Badge variant={a.state === "RUNNING" ? "destructive" : "muted"}>{STATE_LABEL[a.state]}</Badge>
              </div>
              {a.items.length > 0 && <p className="text-xs font-semibold text-primary">対象: {a.items.map((i) => (i.type === "TAG" ? `タグ「${i.name}」` : i.type === "SET" ? `セット「${i.name}」` : i.name)).join("、")}</p>}
              <p className="text-xs text-muted-foreground">
                {shopNames(a.shopIds)} ・ {period(a)} ・ {a.combinableWithCoupon ? "クーポン併用可" : "クーポン併用不可"} ・ 利用 {a.usedCount}回 / 計 {money(a.usedAmount)}
              </p>
              {a.status !== "ENDED" && (
                <Button size="sm" variant="outline" className="self-start" disabled={row.pending} onClick={() => setAutoStatus(a, a.status === "ACTIVE" ? "STOPPED" : "ACTIVE")}>
                  {a.status === "ACTIVE" ? "停止する" : "再開する"}
                </Button>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      <CouponList
        coupons={coupons}
        shops={shops}
        setStatus={async (id, status) => {
          await api(`/discounts/coupons/${id}/status`, { body: { status } });
        }}
        onChanged={load}
      />
    </div>
  );
}
