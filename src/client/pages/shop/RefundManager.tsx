import { ArrowLeft, Minus, Plus, Search } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { OrderDetail, OrderStatus, OrderSummary, ProductDto, RefundResult } from "@shared/api";
import { refundAmountForLine, refundAmountForPercent } from "@shared/pricing";
import { PeriodPicker, type Period } from "@/components/PeriodPicker";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ErrorText, Field } from "@/components/Shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ApiRequestError, api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction } from "@/lib/useAction";
import { useRequestId } from "@/lib/useRequestId";
import { formatDateTime } from "@/lib/utils";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Checkbox } from "@/components/ui/checkbox";

const STATUS_LABEL: Record<OrderStatus, string> = {
  PAID: "支払い済み",
  PARTIALLY_REFUNDED: "一部返金済み",
  REFUNDED: "全額返金済み",
};
const REASONS = ["お客様都合", "商品の不備", "入力ミス", "提供できなかった"];
type Mode = "PARTIAL" | "FULL" | "ARBITRARY";

/** 注文の一覧 → 詳細 → 返金(確認つき)。店舗責任者は自店舗、全体管理者は店舗を選んで操作する */
export function RefundManager({ shopId }: { shopId: string }) {
  const { money, me } = useAuth();
  const isAdmin = me?.user.role === "ADMIN";
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [q, setQ] = useState("");
  const [productId, setProductId] = useState("ALL");
  const [period, setPeriod] = useState<Period>({});
  const [state, setState] = useState("any");
  const [products, setProducts] = useState<ProductDto[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [pct, setPct] = useState<Record<string, number>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [mode, setMode] = useState<Mode>("PARTIAL");
  const [qty, setQty] = useState<Record<string, number>>({});
  const [restore, setRestore] = useState<Record<string, boolean>>({});
  const [restoreCoupon, setRestoreCoupon] = useState(true);
  const [restoreAll, setRestoreAll] = useState(true);
  const [arbitrary, setArbitrary] = useState("");
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState<RefundResult | null>(null);
  const list = useAction();
  const op = useAction();
  const reqId = useRequestId();

  const loadList = useCallback(
    (more = false) =>
      list.run(async () => {
        const p = new URLSearchParams();
        if (q.trim()) p.set("q", q.trim());
        if (productId !== "ALL") p.set("productId", productId);
        if (period.from !== undefined) p.set("from", String(period.from));
        if (period.to !== undefined) p.set("to", String(period.to));
        if (state !== "any") p.set("state", state);
        if (more && next !== null) p.set("before", String(next));
        const r = await api<{ orders: OrderSummary[]; next: number | null }>(`/refunds/shops/${shopId}/orders?${p}`);
        setOrders((cur) => (more ? [...cur, ...r.orders] : r.orders));
        setNext(r.next);
      }),
    // 検索条件は「検索」ボタンで反映する
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shopId, q, productId, period, state, next],
  );
  useEffect(() => {
    setOpenId(null);
    setDetail(null);
    setProductId("ALL");
    void api<{ products: ProductDto[] }>(`/catalog/${shopId}/products`).then((r) => setProducts(r.products)).catch(() => undefined);
    void list.run(async () => {
      const r = await api<{ orders: OrderSummary[]; next: number | null }>(`/refunds/shops/${shopId}/orders`);
      setOrders(r.orders);
      setNext(r.next);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shopId]);

  const open = async (id: string) => {
    setOpenId(id);
    setDone(null);
    setConfirming(false);
    setQty({});
    setPct({});
    setRestore({});
    setArbitrary("");
    setReason("");
    setMode("PARTIAL");
    op.setError(null);
    reqId.renew();
    await op.run(async () => setDetail(await api<OrderDetail>(`/refunds/orders/${id}`)));
  };

  const close = () => {
    setOpenId(null);
    setDetail(null);
    setDone(null);
    void loadList();
  };

  // ---------- 一覧 ----------
  if (!openId) {
    return (
      <div className="flex flex-col gap-3">
        <form
          className="flex flex-col gap-2"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void loadList();
          }}
        >
          <div className="flex gap-2">
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="取引番号(例: WASDGSC3)" maxLength={20} />
            <Button type="submit" variant="outline" aria-label="検索">
              <Search />
            </Button>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Select value={productId} onValueChange={setProductId}>
              <SelectTrigger aria-label="商品で絞り込む">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">すべての商品</SelectItem>
                {products.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={state} onValueChange={setState}>
              <SelectTrigger aria-label="返金の状態">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">返金の状態: すべて</SelectItem>
                <SelectItem value="refundable">まだ返金できるもの</SelectItem>
                <SelectItem value="refunded">返金のあるもの</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <PeriodPicker withTime onChange={setPeriod} />
          <Button type="submit" disabled={list.pending}>
            この条件で検索
          </Button>
        </form>
        <ErrorText message={list.error} />
        {orders.length === 0 && <p className="p-6 text-center text-sm text-muted-foreground">注文がありません</p>}
        {orders.map((o) => (
          <button key={o.id} onClick={() => void open(o.id)} className="text-left">
            <Card className="p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="font-semibold">
                  {o.orderNo} <span className="text-xs font-normal text-muted-foreground">{formatDateTime(o.paidAt)}</span>
                </p>
                <p className="font-bold">{money(o.total)}</p>
              </div>
              <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span className="min-w-0 truncate">{o.items ?? (o.customerNickname ?? "お客様")}</span>
                {o.status === "PAID" ? (
                  <span>{STATUS_LABEL.PAID}</span>
                ) : (
                  <Badge variant="warning">
                    {STATUS_LABEL[o.status]}(返金 {money(o.refundedTotal)})
                  </Badge>
                )}
              </div>
            </Card>
          </button>
        ))}
        {next !== null && (
          <Button variant="outline" disabled={list.pending} onClick={() => void loadList(true)}>
            さらに読み込む
          </Button>
        )}
      </div>
    );
  }

  // ---------- 詳細・返金 ----------
  if (!detail) return <p className="p-6 text-center text-sm text-muted-foreground">{op.error ?? "読み込み中…"}</p>;

  const picks = detail.lines
    .map((l) => ({
      l,
      n: qty[l.id] ?? 0,
      p: pct[l.id] ?? 0, // 1〜99 のときは返金率で返金する
      left: l.quantity - l.refundedQuantity,
    }))
    .filter((x) => x.n > 0 || (x.p > 0 && x.p < 100))
    .map((x) => {
      const byPercent = x.p > 0 && x.p < 100;
      return {
        ...x,
        byPercent,
        amount: byPercent ? refundAmountForPercent(x.l, x.p) : refundAmountForLine(x.l, x.n),
        restore: byPercent ? false : (restore[x.l.id] ?? true),
      };
    });
  const amount = mode === "FULL" ? detail.total : mode === "ARBITRARY" ? Number(arbitrary || 0) : picks.reduce((s, p) => s + p.amount, 0);
  const valid = amount > 0 && picks.every((p) => p.amount > 0) && amount <= detail.refundable && reason.trim().length > 0 && (mode !== "PARTIAL" || picks.length > 0);

  const submit = () => {
    void op.run(async () => {
      try {
        const body = {
          requestId: reqId.get(),
          kind: mode,
          reason: reason.trim(),
          expectedAmount: amount,
          ...(mode === "PARTIAL"
            ? {
                lines: picks.map((p) => ({
                  orderLineId: p.l.id,
                  quantity: p.byPercent ? 1 : p.n,
                  restoreStock: p.restore,
                  ...(p.byPercent ? { percent: p.p } : {}),
                })),
              }
            : {}),
          ...(mode === "FULL" ? { restoreStock: restoreAll, restoreCoupon } : {}),
          ...(mode === "ARBITRARY" ? { amount } : {}),
        };
        const r = await api<RefundResult>(`/refunds/orders/${detail.id}/refund`, { body });
        setDone(r);
        reqId.renew();
      } catch (e) {
        // 上限超過・同時に別の返金が入った場合は、最新の状態を読み直す
        if (e instanceof ApiRequestError && ["REFUND_CHANGED", "OVER_REFUNDABLE", "AMOUNT_CHANGED", "ALREADY_REFUNDED"].includes(e.code)) {
          reqId.renew();
          setConfirming(false);
          setDetail(await api<OrderDetail>(`/refunds/orders/${detail.id}`));
        }
        throw e;
      }
    });
  };

  if (done) {
    return (
      <div className="flex flex-col gap-3">
        <Card className="overflow-hidden">
          <div className="bg-secondary px-4 py-6 text-center">
            <p className="text-lg font-extrabold">返金しました</p>
            <p className="mt-1 text-3xl font-extrabold tracking-tight">{money(done.amount)}</p>
            <p className="mt-1 text-sm text-secondary-foreground">
              取引番号 {detail.orderNo} ・ 残り返金可能額 {money(done.refundable)}
            </p>
            {done.replayed && <p className="mt-1 text-xs">(通信が切れたため、先ほどの結果を表示しています)</p>}
          </div>
        </Card>
        <Button size="lg" onClick={close}>
          注文の一覧へ
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <Button variant="ghost" className="self-start" onClick={close}>
        <ArrowLeft /> 一覧に戻る
      </Button>
      <Card className="overflow-hidden">
        <div className="bg-secondary px-4 py-3">
          <p className="text-sm text-secondary-foreground">
            取引番号 {detail.orderNo} ・ {detail.customerNickname ?? "お客様"} ・ {formatDateTime(detail.paidAt)}
          </p>
          <p className="text-3xl font-extrabold tracking-tight">{money(detail.total)}</p>
          {detail.discounts.length > 0 && (
            <p className="text-xs font-semibold text-primary">
              小計 {money(detail.subtotal)} から割引 {detail.discounts.map((d) => `${d.name} -${money(d.amount)}`).join("、")}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            {STATUS_LABEL[detail.status]} ・ 返金済み {money(detail.refundedTotal)} ・ 残り返金可能額 {money(detail.refundable)}
            {detail.clerkNickname && ` ・ 担当 ${detail.clerkNickname}`}
          </p>
        </div>
      </Card>

      {detail.refundable > 0 ? (
        <>
          <Tabs
            value={mode}
            onValueChange={(v) => {
              setMode(v as Mode);
              setConfirming(false);
            }}
          >
            <TabsList aria-label="返金のしかた" className={isAdmin ? "grid grid-cols-3" : "grid grid-cols-2"}>
              {([["PARTIAL", "商品を選ぶ"], ["FULL", "全額"], ...(isAdmin ? [["ARBITRARY", "任意金額"]] : [])] as [Mode, string][]).map(([m, label]) => (
                <TabsTrigger key={m} value={m} disabled={m === "FULL" && detail.refundedTotal > 0} className="disabled:opacity-40">
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          {mode === "PARTIAL" && (
            <Card>
              <CardContent className="flex flex-col divide-y divide-border pt-3">
                {detail.lines.map((l) => {
                  const left = l.quantity - l.refundedQuantity;
                  const n = qty[l.id] ?? 0;
                  return (
                    <div key={l.id} className="flex flex-col gap-1.5 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate font-semibold">{l.name}</p>
                          {l.components && l.components.length > 0 && (
                            <p className="text-xs text-muted-foreground">
                              {l.components.map((c) => `${c.name}${c.quantity > 1 ? `×${c.quantity}` : ""}${c.surcharge > 0 ? `(+${c.surcharge})` : ""}`).join("、")}
                            </p>
                          )}
                          <p className="text-xs text-muted-foreground">
                            {money(l.unitPrice)} × {l.quantity}
                            {l.kind === "SET" && " (追加料金は別)"}
                            {l.priceCutName && `(${l.priceCutName})`} ・ 返金済み {l.refundedQuantity}個
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <Button size="icon" variant="outline" aria-label="減らす" disabled={n <= 0} onClick={() => setQty({ ...qty, [l.id]: n - 1 })}>
                            <Minus />
                          </Button>
                          <span className="w-7 text-center text-lg font-bold">{n}</span>
                          <Button size="icon" variant="outline" aria-label="増やす" disabled={n >= left} onClick={() => { setQty({ ...qty, [l.id]: n + 1 }); setPct({ ...pct, [l.id]: 0 }); }}>
                            <Plus />
                          </Button>
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5 text-xs">
                        <span className="text-muted-foreground">または 返金率</span>
                        <Input
                          inputMode="numeric"
                          aria-label={`${l.name}の返金率(%)`}
                          className="h-8 w-16 px-2 text-right"
                          placeholder="例: 50"
                          value={pct[l.id] ? String(pct[l.id]) : ""}
                          onChange={(e) => {
                            const v = Math.min(99, Number(e.target.value.replace(/[^0-9]/g, "")) || 0);
                            setPct({ ...pct, [l.id]: v });
                            if (v > 0) setQty({ ...qty, [l.id]: 0 });
                          }}
                        />
                        <span className="text-muted-foreground">%</span>
                        {[10, 30, 50].map((v) => (
                          <button key={v} type="button" className="h-7 rounded-full bg-accent px-2.5 font-semibold" onClick={() => { setPct({ ...pct, [l.id]: v }); setQty({ ...qty, [l.id]: 0 }); }}>
                            {v}%
                          </button>
                        ))}
                        {(pct[l.id] ?? 0) > 0 && (
                          <span className="font-semibold">= {money(refundAmountForPercent(l, pct[l.id]))}(数量・在庫は動きません)</span>
                        )}
                      </div>
                      {n > 0 && (
                        <label className="flex items-center gap-2 text-xs">
                          <Checkbox
                            className="size-4"
                            checked={restore[l.id] ?? true}
                            onCheckedChange={(c) =>
                              setRestore({
                                ...restore,
                                [l.id]: c === true,
                              })
                            }
                          />
                          在庫に戻す(返金 {money(refundAmountForLine(l, n))})
                        </label>
                      )}
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          )}
          {mode === "FULL" && (
            <label className="flex items-center gap-2 rounded-xl bg-card px-3 py-3 text-sm font-medium">
              <Checkbox checked={restoreAll} onCheckedChange={(c) => setRestoreAll(c === true)} />
              すべての商品を在庫に戻す
            </label>
          )}
          {mode === "FULL" && detail.couponUsed && (
            <label className="flex items-center gap-2 rounded-xl bg-card px-3 py-3 text-sm font-medium">
              <Checkbox checked={restoreCoupon} onCheckedChange={(c) => setRestoreCoupon(c === true)} />
              使ったクーポンを、もう一度使える状態に戻す
            </label>
          )}
          {mode === "ARBITRARY" && (
            <Field label="返金額" hint={`残り返金可能額 ${money(detail.refundable)} まで。在庫は動きません`}>
              <Input inputMode="numeric" value={arbitrary} onChange={(e) => setArbitrary(e.target.value.replace(/[^0-9]/g, ""))} className="h-12 text-lg font-bold" />
            </Field>
          )}

          <Field label="返金の理由(必須)">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
          </Field>
          <div className="flex flex-wrap gap-2">
            {REASONS.map((r) => (
              <button key={r} type="button" onClick={() => setReason(r)} className="h-8 rounded-full bg-accent px-3 text-xs font-semibold">
                {r}
              </button>
            ))}
          </div>

          <ErrorText message={op.error} />
          <Button size="lg" disabled={!valid} onClick={() => setConfirming(true)}>
            {amount > 0 ? `${money(amount)} を返金する(確認へ)` : "返金する商品を選んでください"}
          </Button>
          {amount > detail.refundable && <p className="text-xs font-semibold text-destructive">残り返金可能額を超えています</p>}
          {/* 確認はポップアップで出す */}
          <Dialog
            open={confirming}
            onOpenChange={(o) => {
              if (!o && !op.pending) setConfirming(false);
            }}
          >
            <DialogContent hideClose={op.pending} onInteractOutside={(e) => e.preventDefault()}>
              <DialogTitle>この内容で返金します</DialogTitle>
              <div className="flex flex-col gap-1 text-sm">
                <p>
                  元の取引 {detail.orderNo}(支払い {money(detail.total)})
                </p>
                <p>これまでの返金 {money(detail.refundedTotal)}</p>
                {mode === "PARTIAL" &&
                  picks.map((p) => (
                    <p key={p.l.id}>
                      ・{p.l.name} {p.byPercent ? `の ${p.p}%` : `× ${p.n}`}({money(p.amount)}){p.byPercent ? "" : p.restore ? " 在庫に戻す" : " 在庫は戻さない"}
                    </p>
                  ))}
                {mode === "FULL" && <p>・全商品{restoreAll ? "(在庫に戻す)" : "(在庫は戻さない)"}</p>}
                {mode === "FULL" && detail.couponUsed && <p>・クーポン{restoreCoupon ? "は戻す" : "は使用済みのまま"}</p>}
                <p className="text-lg font-extrabold">今回の返金 {money(amount)}</p>
                <p>
                  返金後の累計 {money(detail.refundedTotal + amount)} / 残り {money(detail.refundable - amount)}
                </p>
                <p className="text-muted-foreground">
                  理由: {reason} ・ 操作者: {me?.user.nickname}
                </p>
              </div>
              <ErrorText message={op.error} />
              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={() => setConfirming(false)} disabled={op.pending}>
                  戻る
                </Button>
                <Button className="flex-1" onClick={submit} disabled={op.pending}>
                  {op.pending ? "返金中…" : "返金する"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </>
      ) : (
        <p className="rounded-xl bg-card px-3 py-3 text-sm text-muted-foreground">この注文はすべて返金済みです。</p>
      )}

      {detail.refunds.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>返金の履歴</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col divide-y divide-border text-sm">
            {detail.refunds.map((r) => (
              <div key={r.id} className="flex flex-col gap-0.5 py-2">
                <div className="flex justify-between gap-2">
                  <span className="font-semibold">{formatDateTime(r.createdAt)}</span>
                  <span className="font-bold">{money(r.amount)}</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {r.cancel ? "注文取消し" : r.kind === "FULL" ? "全額" : r.kind === "ARBITRARY" ? "任意金額" : "商品を選んで"} ・ {r.reason} ・ {r.operatorNickname ?? "-"}
                  {r.couponRestored && " ・ クーポンを戻した"}
                </p>
                {r.lines.map((x, i) => (
                  <p key={i} className="text-xs text-muted-foreground">
                    ・{x.name} {x.percent !== null ? `の ${x.percent}%` : `× ${x.quantity}`}({money(x.amount)}){x.restoreStock ? " 在庫に戻した" : ""}
                  </p>
                ))}
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
