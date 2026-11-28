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
      <div className="flex flex-wrap items-center">
        <button className="flex min-w-[11rem] flex-1 basis-44 items-center gap-3 p-4 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-secondary text-secondary-foreground">
            <Store className="size-5" />
          </span>
          <span className="min-w-0 flex-1 break-words text-base font-bold">{shop.name}</span>
          <ChevronDown className={cn("size-5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
        </button>
        {shop.callBoard && (
          <Button asChild variant="outline" size="sm" className="my-2 ml-auto mr-3 shrink-0">
            <Link to={`/board/${shop.id}`}>
              <Monitor className="!size-4" /> 呼び出し状況を見る
            </Link>
          </Button>
        )}
      </div>
      {open && (
        <CardContent className="flex flex-col gap-3 border-t border-border pt-3">
          {shop.description && <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{shop.description}</p>}
          {error && <p className="text-sm text-muted-foreground">メニューを読み込めませんでした</p>}
          {!items && !error && <p className="text-sm text-muted-foreground">読み込み中…</p>}
          {items?.length === 0 && <p className="text-sm text-muted-foreground">メニューは準備中です</p>}
          <ul className="flex flex-col gap-3">
            {items?.map((it, i) => (
              <li key={i} className={cn("flex items-start gap-3 text-sm", it.soldOut && "opacity-50")}>
                {it.imageUrl && <img src={it.imageUrl} alt="" width={64} height={64} loading="lazy" decoding="async" className="size-16 shrink-0 rounded-lg bg-muted object-cover" />}
                <div className="min-w-0 flex-1">
                  <p className="break-words font-semibold">
                    {it.name} {it.kind === "SET" && <Badge variant="muted">セット</Badge>} {it.soldOut && <Badge variant="destructive">売り切れ</Badge>}
                  </p>
                  {it.description && <p className="mt-0.5 whitespace-pre-wrap break-words text-xs text-muted-foreground">{it.description}</p>}
                </div>
                <p className="shrink-0 whitespace-nowrap font-bold">{it.price === null ? "" : money(it.price)}</p>
              </li>
            ))}
          </ul>
        </CardContent>
      )}
    </Card>
  );
}
