import { HandPlatter, ChefHat } from "lucide-react";
import { useEffect, useState } from "react";
import type { ActiveOrderDto } from "@shared/api";
import { Card } from "@/components/ui/card";
import { api } from "@/lib/api";
import { cn, formatDateTime } from "@/lib/utils";

/**
 * 受け取り待ちの注文(呼び出し番号)。支払いをしたお店の呼び出し番号(自動・番号札どちらも)を、受け渡しが済むまで表示する。
 * 画面を開いている間だけ4秒おきに更新する。呼ばれたら「呼ばれています」と目立たせる。
 */
export function ActiveOrdersCard() {
  const [orders, setOrders] = useState<ActiveOrderDto[]>([]);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await api<{ orders: ActiveOrderDto[] }>("/wallet/active-orders");
        if (!alive) return;
        setOrders(r.orders);
        setOffline(false);
      } catch {
        if (alive) setOffline(true);
      }
    };
    void load();
    const t = window.setInterval(() => document.visibilityState === "visible" && void load(), 4000);
    const onVisible = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (orders.length === 0) return null;
  return (
    <section className="flex flex-col gap-2" aria-label="受け取り待ちの注文" aria-live="polite">
      <h2 className="text-sm font-bold">受け取り待ちの注文</h2>
      {offline && <p className="text-xs text-muted-foreground">通信できません。表示は最新でない可能性があります</p>}
      {orders.map((o) => {
        const ready = o.status === "READY";
        return (
          <Card key={o.orderId} className={cn("flex items-center gap-4 p-4", ready ? "border-2 border-primary bg-secondary" : "")}>
            <div className={cn("flex min-w-20 flex-col items-center rounded-2xl px-3 py-2", ready ? "bg-primary text-primary-foreground" : "bg-muted")}>
              <span className="text-xs">呼び出し番号</span>
              <span className="text-5xl font-black leading-none">{o.callNo}</span>
            </div>
            <div className="min-w-0 flex-1">
              <p className={cn("flex items-center gap-1.5 text-base font-extrabold", ready && "text-primary")}>
                {ready ? <HandPlatter className="size-5" /> : <ChefHat className="size-5" />}
                {ready ? "呼ばれています。受け取りに来てください" : "調理中・調理待ち"}
              </p>
              <p className="truncate text-sm font-semibold">{o.shopName}</p>
              <p className="truncate text-xs text-muted-foreground">{o.items}</p>
              <p className="text-xs text-muted-foreground">{formatDateTime(o.paidAt)} ・ 取引番号 {o.orderNo}</p>
            </div>
          </Card>
        );
      })}
    </section>
  );
}
