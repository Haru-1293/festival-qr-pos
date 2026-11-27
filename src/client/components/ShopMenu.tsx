import { ChevronDown, Monitor, Store } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { PublicMenuItem, PublicShopDto } from "@shared/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";

/** 店舗名をタップするとメニュー(画像つき)が開く。トップページとマイページで共用 */
export function ShopMenu({ shop }: { shop: PublicShopDto }) {
  const { money } = useAuth();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<PublicMenuItem[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!open || items) return;
    api<{ items: PublicMenuItem[] }>(`/public/shops/${shop.id}/menu`)
      .then((r) => setItems(r.items))
      .catch(() => setError(true));
  }, [open, items, shop.id]);
  return (
    <Card className="overflow-hidden">
      <button className="flex w-full items-center gap-3 p-4 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="flex size-10 items-center justify-center rounded-xl bg-secondary text-secondary-foreground">
          <Store className="size-5" />
        </span>
        <span className="min-w-0 flex-1 truncate text-base font-bold">{shop.name}</span>
        {shop.callBoard && <Badge variant="muted">呼び出しあり</Badge>}
        <ChevronDown className={cn("size-5 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <CardContent className="flex flex-col gap-2 border-t border-border pt-3">
          {error && <p className="text-sm text-muted-foreground">メニューを読み込めませんでした</p>}
          {!items && !error && <p className="text-sm text-muted-foreground">読み込み中…</p>}
          {items?.length === 0 && <p className="text-sm text-muted-foreground">メニューは準備中です</p>}
          {items?.map((it, i) => (
            <div key={i} className={cn("flex items-center justify-between gap-3 text-sm", it.soldOut && "opacity-50")}>
              {it.imageUrl && <img src={it.imageUrl} alt="" loading="lazy" className="size-16 shrink-0 rounded-lg object-cover" />}
              <div className="min-w-0 flex-1">
                <p className="font-semibold">
                  {it.name} {it.kind === "SET" && <Badge variant="muted">セット</Badge>} {it.soldOut && <Badge variant="destructive">売り切れ</Badge>}
                </p>
                {it.description && <p className="text-xs text-muted-foreground">{it.description}</p>}
              </div>
              <p className="shrink-0 font-bold">{it.price === null ? "" : money(it.price)}</p>
            </div>
          ))}
          {shop.callBoard && (
            <Button asChild variant="outline" size="sm" className="mt-1 self-start">
              <Link to={`/board/${shop.id}`}>
                <Monitor className="!size-4" /> 呼び出し状況を見る
              </Link>
            </Button>
          )}
        </CardContent>
      )}
    </Card>
  );
}

