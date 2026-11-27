import { UtensilsCrossed } from "lucide-react";
import { useEffect, useState } from "react";
import type { PublicShopDto } from "@shared/api";
import { ShopMenu } from "@/components/ShopMenu";
import { Page } from "@/components/layout/ConsoleLayout";
import { api } from "@/lib/api";

/** マイページの「店舗・メニュー」。参加店舗とメニューを見られる */
export function CustomerShops() {
  const [shops, setShops] = useState<PublicShopDto[] | null>(null);
  useEffect(() => {
    api<{ shops: PublicShopDto[] }>("/public/shops")
      .then((r) => setShops(r.shops))
      .catch(() => setShops([]));
  }, []);
  return (
    <Page>
      <h2 className="flex items-center gap-2 text-lg font-bold">
        <UtensilsCrossed className="size-5" /> 参加店舗とメニュー
      </h2>
      {shops === null && <p className="text-sm text-muted-foreground">読み込み中…</p>}
      {shops?.length === 0 && <p className="text-sm text-muted-foreground">まだ店舗が登録されていません</p>}
      <div className="grid gap-3 md:grid-cols-2">{shops?.map((s) => <ShopMenu key={s.id} shop={s} />)}</div>
    </Page>
  );
}
