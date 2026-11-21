import { useState } from "react";
import { Shell } from "@/components/Shell";
import { useAuth } from "@/lib/auth";
import { PosCatalog } from "../pos/PosCatalog";
import { PriceCutManager } from "./PriceCutManager";
import { ProductManager } from "./ProductManager";
import { SetManager } from "./SetManager";
import { RefundManager } from "./RefundManager";
import { ShopSales } from "./ShopSales";
import { StaffManager } from "./StaffManager";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

const TABS = [
  { id: "products", label: "商品" },
  { id: "sets", label: "セット" },
  { id: "cut", label: "値下げ" },
  { id: "pos", label: "レジ" },
  { id: "refund", label: "返金" },
  { id: "sales", label: "売上" },
  { id: "staff", label: "スタッフ" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export function ShopManagerHome() {
  const { me } = useAuth();
  const [tab, setTab] = useState<TabId>("products");
  if (!me?.user.shopId) return null;
  const shopId = me.user.shopId;
  return (
    <Shell title={me.user.shopName ?? "店舗"}>
      <div className="flex flex-col gap-4">
        <Tabs value={tab} onValueChange={(v) => setTab(v as TabId)}>
          <TabsList aria-label="店舗メニュー" className="grid grid-cols-7">
            {TABS.map((t) => (
              <TabsTrigger key={t.id} value={t.id} className="h-10 px-0.5 text-xs">
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {tab === "products" && <ProductManager shopId={shopId} />}
        {tab === "sets" && <SetManager shopId={shopId} />}
        {tab === "cut" && <PriceCutManager shopId={shopId} />}
        {tab === "pos" && <PosCatalog shopId={shopId} shopName="レジ画面のプレビュー" embedded />}
        {tab === "refund" && <RefundManager shopId={shopId} />}
        {tab === "sales" && <ShopSales shopId={shopId} />}
        {tab === "staff" && <StaffManager shopId={shopId} />}
      </div>
    </Shell>
  );
}
