import { ChefHat, Check, HandPlatter, Undo2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { TrackedOrderDto } from "@shared/api";
import { ErrorText } from "@/components/Shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction } from "@/lib/useAction";
import { cn } from "@/lib/utils";

const ago = (ms: number, now: number) => {
  const m = Math.max(0, Math.floor((now - ms) / 60_000));
  return m < 1 ? "いま" : `${m}分前`;
};

function OrderCard({ o, now, onMove, busy }: { o: TrackedOrderDto; now: number; onMove: (id: string, s: "PREPARING" | "READY" | "DONE") => void; busy: boolean }) {
  const ready = o.status === "READY";
  return (
    <Card className={cn("flex flex-col gap-2 p-3", ready && "border-primary bg-secondary/60")}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-3xl font-black tracking-tight">{o.callNo}</span>
        <Badge variant={ready ? "default" : "muted"}>{ago(o.status === "READY" ? o.updatedAt : o.createdAt, now)}</Badge>
      </div>
      <ul className="flex flex-col gap-0.5 text-sm">
        {o.items.map((it, i) => (
          <li key={i} className="flex justify-between gap-2">
            <span className="truncate">{it.name}</span>
            <span className="shrink-0 font-bold">×{it.quantity}</span>
          </li>
        ))}
      </ul>
      {ready ? (
        <div className="flex gap-2">
          <Button className="flex-1" onClick={() => onMove(o.orderId, "DONE")} disabled={busy}>
            <Check /> 受け渡した
          </Button>
          <Button variant="outline" size="icon" aria-label="調理中に戻す" onClick={() => onMove(o.orderId, "PREPARING")} disabled={busy}>
            <Undo2 />
          </Button>
        </div>
      ) : (
        <Button onClick={() => onMove(o.orderId, "READY")} disabled={busy}>
          <HandPlatter /> できあがり(呼び出す)
        </Button>
      )}
    </Card>
  );
}

/** 注文ステータス(調理中・提供可能)。店員・店舗責任者が使う。オプションがオフの店舗では案内だけ出す */
export function OrdersBoard({ shopId }: { shopId: string }) {
  const { me } = useAuth();
  const [orders, setOrders] = useState<TrackedOrderDto[] | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [now, setNow] = useState(Date.now());
  const [offline, setOffline] = useState(false);
  const move = useAction();

  const load = useCallback(async () => {
    try {
      const r = await api<{ enabled: boolean; orders: TrackedOrderDto[]; serverTime: number }>(`/orders/${shopId}/active`);
      setOrders(r.orders);
      setEnabled(r.enabled);
      setNow(r.serverTime);
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, [shopId]);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => document.visibilityState === "visible" && void load(), 3000);
    return () => window.clearInterval(t);
  }, [load]);

  const onMove = (orderId: string, status: "PREPARING" | "READY" | "DONE") =>
    void move.run(async () => {
      await api(`/orders/${shopId}/${orderId}/status`, { body: { status } });
      await load();
    });

  if (!enabled) {
    return (
      <Card className="p-5 text-sm text-muted-foreground">
        <p className="mb-1 flex items-center gap-2 text-base font-bold text-foreground">
          <ChefHat className="size-5" /> 注文ステータスは使われていません
        </p>
        <p>{me?.user.role === "SHOP_MANAGER" ? "「店舗設定」でオンにすると、支払いのたびに注文が「調理中」として並びます。" : "店舗責任者が「店舗設定」でオンにすると使えます。"}</p>
      </Card>
    );
  }
  const preparing = (orders ?? []).filter((o) => o.status === "PREPARING");
  const ready = (orders ?? []).filter((o) => o.status === "READY");
  return (
    <div className="flex flex-col gap-3">
      {offline && <p role="status" className="rounded-xl bg-amber-100 px-3 py-2 text-sm font-medium text-amber-900">通信できません。表示は最新でない可能性があります</p>}
      <ErrorText message={move.error} />
      {orders === null && <p className="p-6 text-center text-sm text-muted-foreground">読み込み中…</p>}
      <div className="grid gap-4 lg:grid-cols-2">
        <section aria-label="調理中" className="flex flex-col gap-2">
          <h2 className="flex items-center gap-2 text-base font-bold">
            <ChefHat className="size-5" /> 調理中 <Badge variant="muted">{preparing.length}</Badge>
          </h2>
          <div className="grid gap-2 sm:grid-cols-2">{preparing.map((o) => <OrderCard key={o.orderId} o={o} now={now} onMove={onMove} busy={move.pending} />)}</div>
          {orders && preparing.length === 0 && <p className="text-sm text-muted-foreground">調理中の注文はありません</p>}
        </section>
        <section aria-label="提供可能" className="flex flex-col gap-2">
          <h2 className="flex items-center gap-2 text-base font-bold">
            <HandPlatter className="size-5" /> 提供可能 <Badge>{ready.length}</Badge>
          </h2>
          <div className="grid gap-2 sm:grid-cols-2">{ready.map((o) => <OrderCard key={o.orderId} o={o} now={now} onMove={onMove} busy={move.pending} />)}</div>
          {orders && ready.length === 0 && <p className="text-sm text-muted-foreground">お渡し待ちの注文はありません</p>}
        </section>
      </div>
    </div>
  );
}
