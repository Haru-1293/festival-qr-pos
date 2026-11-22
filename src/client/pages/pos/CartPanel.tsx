import { Minus, Plus, ShoppingCart, Trash2 } from "lucide-react";
import type { ProductDto, SetDto } from "@shared/api";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { viewCartLine } from "@/lib/cartView";
import type { Cart } from "@/lib/useCart";
import { cn } from "@/lib/utils";

/** カートの合計(点数と金額)。画面上部の常時表示と、右側のカート欄の両方で使う */
export function cartTotals(cart: Cart, products: ProductDto[], sets: SetDto[]) {
  return {
    count: cart.reduce((a, l) => a + l.quantity, 0),
    total: cart.reduce((sum, l) => sum + viewCartLine(l, products, sets).unit * l.quantity, 0),
  };
}

/** 画面の上に付いたままになるカートの要約。いつでも点数と金額が見え、押すと会計に進む */
export function CartBar({ count, total, onCheckout, className }: { count: number; total: number; onCheckout: () => void; className?: string }) {
  const { money } = useAuth();
  return (
    <div className={cn("sticky top-14 z-10 -mx-3 border-b border-border bg-background/95 px-3 py-2 backdrop-blur sm:-mx-5 sm:px-5", className)}>
      <Button size="lg" className="h-12 w-full justify-between" onClick={onCheckout} disabled={count === 0} aria-label={`カート ${count}点 ${money(total)} 会計へ`}>
        <span className="flex items-center gap-2">
          <ShoppingCart /> カート <b className="rounded-full bg-white/25 px-2 py-0.5 text-sm">{count}</b>点
        </span>
        <span className="text-lg font-extrabold">{money(total)}</span>
      </Button>
    </div>
  );
}

/** 広い画面(タブレット・PC)で右に出すカート欄。数量をその場で増減できる */
export function CartPanel({
  cart,
  products,
  sets,
  onChange,
  onRemove,
  onClear,
  onCheckout,
}: {
  cart: Cart;
  products: ProductDto[];
  sets: SetDto[];
  onChange: (key: string, by: number) => void;
  onRemove: (key: string) => void;
  onClear: () => void;
  onCheckout: () => void;
}) {
  const { money } = useAuth();
  const { count, total } = cartTotals(cart, products, sets);
  return (
    <section aria-label="カート" className="flex max-h-[calc(100dvh-6.5rem)] flex-col rounded-2xl bg-card shadow-sm">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="flex items-center gap-2 font-bold">
          <ShoppingCart className="size-5" /> カート <span className="rounded-full bg-secondary px-2 text-sm text-secondary-foreground">{count}点</span>
        </h2>
        {cart.length > 0 && (
          <button className="text-xs text-muted-foreground underline" onClick={onClear}>
            すべて消す
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto px-4">
        {cart.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">商品をタップすると、ここに入ります</p>}
        {cart.map((l) => {
          const v = viewCartLine(l, products, sets);
          return (
            <div key={l.key} className="flex flex-col gap-1 border-b border-border py-3 last:border-0">
              <div className="flex items-start justify-between gap-2">
                <p className="min-w-0 text-sm font-bold">{v.name}</p>
                <p className="shrink-0 text-sm font-bold">{money(v.unit * l.quantity)}</p>
              </div>
              {v.details.map((d) => (
                <p key={d} className="text-xs text-muted-foreground">
                  {d}
                </p>
              ))}
              {v.problem && <p className="text-xs font-semibold text-destructive">{v.problem}</p>}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1">
                  <Button size="sm" variant="outline" className="size-8 px-0" aria-label="1つ減らす" onClick={() => onChange(l.key, -1)}>
                    <Minus className="!size-4" />
                  </Button>
                  <span className="w-8 text-center font-bold">{l.quantity}</span>
                  <Button size="sm" variant="outline" className="size-8 px-0" aria-label="1つ増やす" onClick={() => onChange(l.key, 1)}>
                    <Plus className="!size-4" />
                  </Button>
                </div>
                <button className="rounded p-1.5 text-muted-foreground hover:bg-accent" aria-label="削除" onClick={() => onRemove(l.key)}>
                  <Trash2 className="size-4" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex flex-col gap-2 border-t border-border p-4">
        <div className="flex items-baseline justify-between">
          <span className="text-sm text-muted-foreground">合計</span>
          <span className="text-2xl font-extrabold">{money(total)}</span>
        </div>
        <Button size="lg" onClick={onCheckout} disabled={count === 0}>
          会計へ進む
        </Button>
      </div>
    </section>
  );
}
