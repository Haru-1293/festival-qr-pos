import { useEffect, useState } from "react";
import type { ShopDto } from "@shared/api";
import { Field } from "@/components/Shell";
import { api } from "@/lib/api";
import { RefundManager } from "../shop/RefundManager";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

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
        <Select value={shopId} onValueChange={(v) => setShopId(v)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {shops.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.displayName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {shopId && <RefundManager key={shopId} shopId={shopId} />}
    </div>
  );
}
