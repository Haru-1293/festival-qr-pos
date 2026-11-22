import { Ban, Check, CloudOff, Search, Settings2, Tag } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ProductDto, SetDto } from "@shared/api";
import { SetPicker } from "@/components/SetPicker";
import { PriceView } from "@/components/PriceView";
import { ErrorText } from "@/components/Shell";
import { Input } from "@/components/ui/input";
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
import { CartBar, CartPanel, cartTotals } from "./CartPanel";

function hm(ms: number) {
  return new Date(ms).toLocaleTimeString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * レジ画面(店員・店舗責任者)。商品をタップしてカートに入れ、会計へ進む。
 * カートの点数・金額は画面上部に常に出る(広い画面では右にカート欄)。値下げ・売り切れはリアルタイムに反映される
 */
export function PosCatalog({ shopId }: { shopId: string }) {
  const { money } = useAuth();
  const { catalog, offline, refresh } = useCatalog(shopId);
  const [tag, setTag] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const first = useRef(true);
  const toggle = useAction();
  const { cart, add, change, remove, clear } = useCart(shopId);
  const [picking, setPicking] = useState<SetDto | null>(null);
  const [checkout, setCheckout] = useState(false);
  const [query, setQuery] = useState("");
  const [manage, setManage] = useState(false);

  // 価格・売り切れが変わったら、画面上部に知らせる(最初の読み込みでは出さない)
  const prev = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    if (!catalog) return;
    const now = new Map(catalog.products.map((p) => [p.id, `${p.salePrice}|${p.soldOut}`]));
    if (!first.current) {
      const changed = catalog.products.filter((p) => prev.current.get(p.id) !== now.get(p.id));
      if (changed.length > 0) {
        setNotice(
          `${changed
            .slice(0, 3)
            .map((p) => p.name)
            .join("、")}${changed.length > 3 ? ` ほか${changed.length - 3}件` : ""} が更新されました`,
        );
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
  const items = useMemo(
    () => (catalog?.products ?? []).filter((p) => (!tag || p.tags.some((t) => t.id === tag)) && (!query || p.name.includes(query))),
    [catalog, tag, query],
  );

  const setSoldOut = (p: ProductDto, soldOut: boolean) => {
    void toggle.run(async () => {
      await api(`/pos/${shopId}/products/${p.id}/sold-out`, {
        body: { soldOut },
      });
      await refresh();
    });
  };

  const setSetSoldOut = (s: SetDto, soldOut: boolean) => {
    void toggle.run(async () => {
      await api(`/pos/${shopId}/sets/${s.id}/sold-out`, { body: { soldOut } });
      await refresh();
    });
  };

  const { count, total } = cartTotals(cart, catalog?.products ?? [], catalog?.sets ?? []);
  const inCart = (id: string) => cart.filter((l) => l.productId === id || l.setId === id).reduce((a, l) => a + l.quantity, 0);

  const body = checkout ? (
    <div className="mx-auto w-full max-w-xl">
    <Checkout
      shopId={shopId}
      products={catalog?.products ?? []}
      sets={catalog?.sets ?? []}
      cart={cart}
      onChange={change}
      onRemove={remove}
      onClose={() => setCheckout(false)}
      onFinished={() => {
        clear();
        setCheckout(false);
        void refresh();
      }}
    />
    </div>
  ) : (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
    <div className="flex min-w-0 flex-1 flex-col gap-3">
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

      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="商品名で探す" className="h-10 pl-9 text-sm" aria-label="商品名で探す" />
        </div>
        <Button variant={manage ? "default" : "outline"} size="sm" className="h-10" onClick={() => setManage(!manage)} aria-pressed={manage}>
          <Settings2 className="!size-4" /> 売り切れ操作
        </Button>
      </div>

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
      {(catalog?.sets.length ?? 0) > 0 && (
        <section aria-label="セット" className="flex flex-col gap-2">
          <p className="text-sm font-bold text-muted-foreground">セット</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 2xl:grid-cols-5">
            {catalog!.sets.map((st) => (
              <Card key={st.id} className={cn("flex flex-col gap-2 p-3", !st.available && "opacity-60")}>
                <button
                  type="button"
                  className="flex flex-col gap-2 text-left disabled:cursor-not-allowed"
                  disabled={!st.available}
                  onClick={() => setPicking(st)}
                  aria-label={`${st.name}の内訳を選ぶ`}
                >
                  <p className="line-clamp-2 min-h-[2.5rem] text-sm font-bold leading-tight">{st.name}</p>
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-lg font-extrabold">
                      {st.cutAmount > 0 && <span className="mr-1 text-xs font-medium text-muted-foreground line-through">{money(st.price)}</span>}
                      {money(st.salePrice)}
                    </span>
                    {inCart(st.id) > 0 ? <Badge>{inCart(st.id)}</Badge> : null}
                  </span>
                </button>
                <div className="flex flex-wrap items-center gap-1.5">
                  {!st.available && <Badge variant="destructive">{st.unavailableReason === "NO_OPTIONS" ? "売り切れ(内訳なし)" : "売り切れ"}</Badge>}
                  {st.segments.some((g) => g.items.some((i) => i.surcharge > 0)) && <Badge variant="muted">追加料金あり</Badge>}
                </div>
                {manage && (st.manualSoldOut ? (
                  <Button size="sm" variant="outline" onClick={() => setSetSoldOut(st, false)} disabled={toggle.pending}>
                    <Check className="!size-4" /> 販売再開
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => setSetSoldOut(st, true)} disabled={toggle.pending || !st.available}>
                    <Ban className="!size-4" /> 売り切れにする
                  </Button>
                ))}
              </Card>
            ))}
          </div>
          <p className="text-sm font-bold text-muted-foreground">単品</p>
        </section>
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 2xl:grid-cols-5">
        {items.map((p) => (
          <Card key={p.id} className={cn("flex flex-col gap-2 p-3", p.soldOut && "opacity-60")}>
            <button
              type="button"
              className="flex flex-col gap-2 text-left disabled:cursor-not-allowed"
              disabled={p.soldOut || p.salePrice === null}
              onClick={() => add({ productId: p.id }, 1)}
              aria-label={`${p.name}をカートに入れる`}
            >
              <p className="line-clamp-2 min-h-[2.5rem] text-sm font-bold leading-tight">{p.name}</p>
              <span className="flex items-center justify-between gap-2">
                <PriceView p={p} className="text-lg" />
                {inCart(p.id) > 0 ? <Badge>{inCart(p.id)}</Badge> : null}
              </span>
            </button>
            <div className="flex flex-wrap items-center gap-1.5">
              {p.soldOut && <Badge variant="destructive">{p.soldOutReason === "STOCK" ? "売り切れ(在庫なし)" : "売り切れ"}</Badge>}
              {!p.soldOut && p.trackStock && p.stockQty !== null && <Badge variant={p.stockQty <= 5 ? "warning" : "muted"}>残り{p.stockQty}</Badge>}
            </div>
            {manage && (p.manualSoldOut ? (
              <Button size="sm" variant="outline" onClick={() => setSoldOut(p, false)} disabled={toggle.pending}>
                <Check className="!size-4" /> 販売再開
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setSoldOut(p, true)} disabled={toggle.pending || p.soldOut}>
                <Ban className="!size-4" /> 売り切れにする
              </Button>
            ))}
          </Card>
        ))}
      </div>
      {picking && (
        <SetPicker
          set={picking}
          onClose={() => setPicking(null)}
          onAdd={(picks, q) => {
            add({ setId: picking.id, picks }, q);
            setPicking(null);
          }}
        />
      )}
    </div>
    <aside className="hidden w-96 shrink-0 lg:sticky lg:top-20 lg:block">
      <CartPanel cart={cart} products={catalog?.products ?? []} sets={catalog?.sets ?? []} onChange={change} onRemove={remove} onClear={clear} onCheckout={() => setCheckout(true)} />
    </aside>
    </div>
  );
  return (
    <>
      {!checkout && <CartBar count={count} total={total} onCheckout={() => setCheckout(true)} className="lg:hidden" />}
      <div className="pt-3">{body}</div>
    </>
  );
}
