import { useEffect, useState } from "react";
import type { ShopDto } from "@shared/api";
import { Field } from "@/components/Shell";
import { api } from "@/lib/api";
import { RefundManager } from "../shop/RefundManager";

/** 全体管理者の返金。店舗を選んで、店舗責任者と同じ画面で返金する(任意金額の返金は全体管理者だけ) */
export function AdminRefunds() {
  const [shops, setShops] = useState<ShopDto[]>([]);
  const [shopId, setShopId] = useState("");
  useEffect(() => {
    void api<{ shops: ShopDto[] }>("/admin/shops")
      .then((r) => {
        setShops(r.shops);
        setShopId((cur) => cur || r.shops[0]?.id || "");
      })
      .catch(() => undefined);
  }, []);
  if (shops.length === 0) return <p className="p-6 text-center text-sm text-muted-foreground">店舗がまだありません</p>;
  return (
    <div className="flex flex-col gap-4">
      <Field label="店舗">
        <select className="h-12 rounded-lg border border-input bg-card px-3 text-base" value={shopId} onChange={(e) => setShopId(e.target.value)}>
          {shops.map((s) => (
            <option key={s.id} value={s.id}>
              {s.displayName}
            </option>
          ))}
        </select>
      </Field>
      {shopId && <RefundManager key={shopId} shopId={shopId} />}
    </div>
  );
}
