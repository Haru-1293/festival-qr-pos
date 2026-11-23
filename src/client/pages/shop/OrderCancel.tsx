import { Ban } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { FulfillmentStatus } from "@shared/api";
import { ErrorText } from "@/components/Shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction } from "@/lib/useAction";
import { useRequestId } from "@/lib/useRequestId";
import { formatDateTime } from "@/lib/utils";

interface RecentOrder {
  orderId: string;
  orderNo: string;
  paidAt: number;
  total: number;
  callNo: number | null;
  status: FulfillmentStatus | null;
  items: string | null;
}
const REASONS = ["在庫がなくなった", "注文の間違い", "お客様が取りやめた", "作れなくなった"];

/**
 * 注文の取消し(店員・店舗責任者)。受けた注文を提供できないとき、支払いを全額お客様のウォレットへ戻す。
 * 理由は必須で、監査ログに残る。対象は、支払いから2時間以内でまだ返金のない注文(受け渡し済みは除く)。
 */
export function OrderCancel({ shopId }: { shopId: string }) {
  const { money, me } = useAuth();
  const [orders, setOrders] = useState<RecentOrder[] | null>(null);
  const [target, setTarget] = useState<RecentOrder | null>(null);
  const [reason, setReason] = useState("");
  const [restore, setRestore] = useState(false);
  const [doneMsg, setDoneMsg] = useState<string | null>(null);
  const load = useAction();
  const op = useAction();
  const reqId = useRequestId();

  const reload = useCallback(
    () =>
      load.run(async () => {
        setOrders((await api<{ orders: RecentOrder[] }>(`/orders/${shopId}/recent`)).orders);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shopId],
  );
  useEffect(() => {
    void reload();
  }, [reload]);

  const pick = (o: RecentOrder) => {
    setTarget(o);
    setReason("");
    setRestore(false);
    setDoneMsg(null);
    op.setError(null);
    reqId.renew();
  };

  const submit = () => {
    if (!target) return;
    void op.run(async () => {
      await api(`/orders/${shopId}/${target.orderId}/cancel`, { body: { requestId: reqId.get(), reason: reason.trim(), restoreStock: restore } });
      setDoneMsg(`注文 ${target.orderNo} を取り消し、${money(target.total)} をお客様のウォレットへ戻しました`);
      setTarget(null);
      reqId.renew();
      await reload();
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        在庫がなくなったなどで提供できない注文を取り消します。支払った金額は全額、お客様のウォレットへ戻ります(使ったクーポンも戻ります)。取り消した理由は記録されます。
      </p>
      {doneMsg && <p className="rounded-xl bg-secondary px-3 py-3 text-sm font-semibold">{doneMsg}</p>}
      <ErrorText message={load.error} />

      {target ? (
        <Card className="border-primary">
          <CardHeader>
            <CardTitle>この注文を取り消します</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <div>
              <p className="font-semibold">
                {target.orderNo}
                {target.callNo !== null && ` ・ 呼び出し ${target.callNo}番`} ・ {money(target.total)}
              </p>
              <p className="text-muted-foreground">{target.items}</p>
            </div>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              取消しの理由(必須)
              <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} className="h-11 text-base" />
            </label>
            <div className="flex flex-wrap gap-2">
              {REASONS.map((r) => (
                <button key={r} type="button" onClick={() => setReason(r)} className="h-8 rounded-full bg-accent px-3 text-xs font-semibold">
                  {r}
                </button>
              ))}
            </div>
            <label className="flex items-start gap-2 text-sm">
              <Checkbox className="mt-0.5" checked={restore} onCheckedChange={(c) => setRestore(c === true)} />
              <span>
                商品を在庫に戻す
                <span className="block text-xs text-muted-foreground">注文の間違いなど、商品が手つかずのときだけオンにします。在庫が足りなかったときはオフのままにします。</span>
              </span>
            </label>
            <ErrorText message={op.error} />
            <p className="text-xs text-muted-foreground">操作者: {me?.user.nickname}</p>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setTarget(null)} disabled={op.pending}>
                やめる
              </Button>
              <Button variant="destructive" className="flex-1" disabled={op.pending || reason.trim().length === 0} onClick={submit}>
                {op.pending ? "取り消し中…" : "取り消して全額戻す"}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
          {orders && orders.length === 0 && <p className="p-6 text-center text-sm text-muted-foreground">取り消せる注文はありません(2時間以内・返金なし)</p>}
          {orders?.map((o) => (
            <Card key={o.orderId} className="flex items-center justify-between gap-3 p-3">
              <div className="min-w-0">
                <p className="font-semibold">
                  {o.orderNo} <span className="text-xs font-normal text-muted-foreground">{formatDateTime(o.paidAt)}</span>
                </p>
                <p className="truncate text-xs text-muted-foreground">{o.items}</p>
                <div className="mt-1 flex items-center gap-2 text-xs">
                  <span className="font-bold">{money(o.total)}</span>
                  {o.callNo !== null && <Badge variant="muted">{o.callNo}番</Badge>}
                  {o.status === "DONE" && <Badge variant="warning">受け渡し済み</Badge>}
                </div>
              </div>
              <Button variant="outline" size="sm" disabled={o.status === "DONE" || o.total <= 0} onClick={() => pick(o)}>
                <Ban /> 取消し
              </Button>
            </Card>
          ))}
          <Button variant="ghost" onClick={() => void reload()} disabled={load.pending}>
            最新の状態に更新
          </Button>
        </>
      )}
    </div>
  );
}
