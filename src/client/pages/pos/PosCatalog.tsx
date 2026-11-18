import { Ban, Check, CloudOff, ShoppingCart, Tag } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ProductDto } from "@shared/api";
import { PriceView } from "@/components/PriceView";
import { ErrorText, Shell } from "@/components/Shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction } from "@/lib/useAction";
import { useCart } from "@/lib/useCart";
import { useCatalog } from "@/lib/useCatalog";
import { cn } from "@/lib/utils";
import { Checkout } from "./Checkout";

function hm(ms: number) {
  return new Date(ms).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
}

/** 店員のレジ画面(商品一覧)。会計・決済は次の更新で追加。値下げ・売り切れはリアルタイムに反映される */
export function PosCatalog({ shopId, shopName, embedded = false }: { shopId: string; shopName: string; embedded?: boolean }) {
  const { money } = useAuth();
  const { catalog, offline, refresh } = useCatalog(shopId);
  const [tag, setTag] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const first = useRef(true);
  const toggle = useAction();
  const { cart, add, remove, clear } = useCart(shopId);
  const [checkout, setCheckout] = useState(false);

  // 価格・売り切れが変わったら、画面上部に知らせる(最初の読み込みでは出さない)
  const prev = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    if (!catalog) return;
    const now = new Map(catalog.products.map((p) => [p.id, `${p.salePrice}|${p.soldOut}`]));
    if (!first.current) {
      const changed = catalog.products.filter((p) => prev.current.get(p.id) !== now.get(p.id));
      if (changed.length > 0) {
        setNotice(`${changed.slice(0, 3).map((p) => p.name).join("、")}${changed.length > 3 ? ` ほか${changed.length - 3}件` : ""} が更新されました`);
        const t = window.setTimeout(() => setNotice(null), 6000);
        prev.current = now;
        return () => window.clearTimeout(t);
      }
    }
    first.current = false;
    prev.current = now;
  }, [catalog]);

  const tags = useMemo(() => {
    const m = new Map<string, string>();
    catalog?.products.forEach((p) => p.tags.forEach((t) => m.set(t.id, t.name)));
    return [...m.entries()];
  }, [catalog]);
  const items = useMemo(() => (catalog?.products ?? []).filter((p) => !tag || p.tags.some((t) => t.id === tag)), [catalog, tag]);

  const setSoldOut = (p: ProductDto, soldOut: boolean) => {
    void toggle.run(async () => {
      await api(`/pos/${shopId}/products/${p.id}/sold-out`, { body: { soldOut } });
      await refresh();
    });
  };

  const count = Object.values(cart).reduce((a, b) => a + b, 0);
  const total = Object.entries(cart).reduce((sum, [id, q]) => sum + (catalog?.products.find((p) => p.id === id)?.salePrice ?? 0) * q, 0);

  const body = checkout ? (
    <Checkout
      shopId={shopId}
      products={catalog?.products ?? []}
      cart={cart}
      onChange={add}
      onRemove={remove}
      onClose={() => setCheckout(false)}
      onFinished={() => {
        clear();
        setCheckout(false);
        void refresh();
      }}
    />
  ) : (
      <div className="flex flex-col gap-3">
        {offline && (
          <div role="status" className="flex items-center gap-2 rounded-xl bg-amber-100 px-3 py-2 text-sm font-medium text-amber-900">
            <CloudOff className="size-4 shrink-0" /> 通信できません。表示中の価格は最新でない可能性があります
          </div>
        )}
        {catalog?.cut && (
          <div className="flex items-center gap-2 rounded-xl bg-red-50 px-3 py-2 text-sm font-bold text-red-700">
            <Tag className="size-4 shrink-0" />
            <span className="min-w-0 flex-1">
              {catalog.cut.name}:{catalog.cut.method === "PERCENT" ? `${catalog.cut.value}%引き` : `${money(catalog.cut.value)}引き`}
              {catalog.cut.endsAt ? `(${hm(catalog.cut.endsAt)}まで)` : ""}
            </span>
          </div>
        )}
        {notice && (
          <p role="status" className="rounded-xl bg-secondary px-3 py-2 text-sm font-semibold text-secondary-foreground">
            {notice}
          </p>
        )}
        <ErrorText message={toggle.error} />

        {tags.length > 0 && (
          <div className="flex gap-2 overflow-x-auto pb-1">
            {[[null, "すべて"] as const, ...tags].map(([id, name]) => (
              <button
                key={id ?? "all"}
                onClick={() => setTag(id)}
                className={cn("h-9 shrink-0 rounded-full px-4 text-sm font-semibold", tag === id ? "bg-primary text-primary-foreground" : "bg-accent")}
              >
                {name}
              </button>
            ))}
          </div>
        )}

        {!catalog && <p className="p-6 text-center text-sm text-muted-foreground">読み込み中…</p>}
        {catalog && items.length === 0 && <p className="p-6 text-center text-sm text-muted-foreground">販売中の商品がありません</p>}
        <div className="grid grid-cols-2 gap-3">
          {items.map((p) => (
            <Card key={p.id} className={cn("flex flex-col gap-2 p-3", p.soldOut && "opacity-60")}>
              <button
                type="button"
                className="flex flex-col gap-2 text-left disabled:cursor-not-allowed"
                disabled={p.soldOut || p.salePrice === null}
                onClick={() => add(p.id, 1)}
                aria-label={`${p.name}をカートに入れる`}
              >
                <p className="line-clamp-2 min-h-[2.5rem] text-sm font-bold leading-tight">{p.name}</p>
                <span className="flex items-center justify-between gap-2">
                  <PriceView p={p} className="text-lg" />
                  {cart[p.id] ? <Badge>{cart[p.id]}</Badge> : null}
                </span>
              </button>
              <div className="flex flex-wrap items-center gap-1.5">
                {p.soldOut && <Badge variant="destructive">{p.soldOutReason === "STOCK" ? "売り切れ(在庫なし)" : "売り切れ"}</Badge>}
                {!p.soldOut && p.trackStock && p.stockQty !== null && p.stockQty <= 5 && <Badge variant="warning">残り{p.stockQty}</Badge>}
              </div>
              {p.manualSoldOut ? (
                <Button size="sm" variant="outline" onClick={() => setSoldOut(p, false)} disabled={toggle.pending}>
                  <Check className="!size-4" /> 販売再開
                </Button>
              ) : (
                <Button size="sm" variant="outline" onClick={() => setSoldOut(p, true)} disabled={toggle.pending || p.soldOut}>
                  <Ban className="!size-4" /> 売り切れにする
                </Button>
              )}
            </Card>
          ))}
        </div>
        {count > 0 && (
          <div className="sticky bottom-0 -mx-4 border-t border-border bg-background px-4 py-3">
            <Button size="lg" className="w-full justify-between" onClick={() => setCheckout(true)}>
              <span className="flex items-center gap-2">
                <ShoppingCart /> カート {count}点
              </span>
              <span>{money(total)}</span>
            </Button>
          </div>
        )}
      </div>
  );
  return embedded ? body : <Shell title={shopName || "レジ"}>{body}</Shell>;
}
