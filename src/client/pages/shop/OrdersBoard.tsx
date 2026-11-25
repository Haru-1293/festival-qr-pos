import { CALL_TAG_MAX } from "@shared/callTag";
import { ChefHat, Check, HandPlatter, Pencil, Undo2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { TrackedOrderDto } from "@shared/api";
import { ErrorText } from "@/components/Shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction } from "@/lib/useAction";
import { cn } from "@/lib/utils";

const ago = (ms: number, now: number) => {
  const m = Math.max(0, Math.floor((now - ms) / 60_000));
  return m < 1 ? "いま" : `${m}分前`;
};

function OrderCard({
  o,
  now,
  onMove,
  onRenumber,
  busy,
}: {
  o: TrackedOrderDto;
  now: number;
  onMove: (id: string, s: "PREPARING" | "READY" | "DONE") => void;
  onRenumber: (id: string, callNo: string) => Promise<boolean>;
  busy: boolean;
}) {
  const ready = o.status === "READY";
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState("");
  return (
    <Card className={cn("flex flex-col gap-2 p-3", ready && "border-primary bg-secondary/60")}>
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        {editing ? (
          <form
            className="flex min-w-0 flex-wrap items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              void onRenumber(o.orderId, val).then((ok) => ok && setEditing(false));
            }}
          >
            <Input autoFocus autoCapitalize="characters" autoComplete="off" aria-label="新しい番号札" value={val} onChange={(e) => setVal(e.target.value.replace(/[^\x21-\x7E]/g, "").toUpperCase().slice(0, CALL_TAG_MAX))} className="h-10 w-24 text-center text-xl font-bold" />
            <Button type="submit" size="sm" disabled={busy || val === ""}>
              変更
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
              やめる
            </Button>
          </form>
        ) : (
          <span className="flex items-center gap-1">
            <span className="text-3xl font-black tracking-tight">{o.callNo}</span>
            <button
              type="button"
              aria-label="番号を付け替える"
              className="flex size-7 items-center justify-center rounded-full text-muted-foreground hover:bg-accent"
              onClick={() => {
                setVal(String(o.callNo));
                setEditing(true);
              }}
            >
              <Pencil className="size-3.5" />
            </button>
          </span>
        )}
        <Badge className="shrink-0 whitespace-nowrap" variant={ready ? "default" : "muted"}>{ago(o.status === "READY" ? o.updatedAt : o.createdAt, now)}</Badge>
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

  /** 番号の付け替え(番号札の取り違えなどの直し)。成功したら true */
  const onRenumber = async (orderId: string, callNo: string): Promise<boolean> => {
    let ok = false;
    await move.run(async () => {
      await api(`/orders/${shopId}/${orderId}/call-no`, { body: { callNo } });
      ok = true;
      await load();
    });
    return ok;
  };

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
          <div className="grid gap-2 sm:grid-cols-2">{preparing.map((o) => <OrderCard key={o.orderId} o={o} now={now} onMove={onMove} onRenumber={onRenumber} busy={move.pending} />)}</div>
          {orders && preparing.length === 0 && <p className="text-sm text-muted-foreground">調理中の注文はありません</p>}
        </section>
        <section aria-label="提供可能" className="flex flex-col gap-2">
          <h2 className="flex items-center gap-2 text-base font-bold">
            <HandPlatter className="size-5" /> 提供可能 <Badge>{ready.length}</Badge>
          </h2>
          <div className="grid gap-2 sm:grid-cols-2">{ready.map((o) => <OrderCard key={o.orderId} o={o} now={now} onMove={onMove} onRenumber={onRenumber} busy={move.pending} />)}</div>
          {orders && ready.length === 0 && <p className="text-sm text-muted-foreground">お渡し待ちの注文はありません</p>}
        </section>
      </div>
    </div>
  );
}
