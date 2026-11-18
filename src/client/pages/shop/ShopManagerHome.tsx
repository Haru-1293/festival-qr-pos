import { useState } from "react";
import { Shell } from "@/components/Shell";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { PosCatalog } from "../pos/PosCatalog";
import { PriceCutManager } from "./PriceCutManager";
import { ProductManager } from "./ProductManager";
import { StaffManager } from "./StaffManager";

const TABS = [
  { id: "products", label: "商品" },
  { id: "cut", label: "値下げ" },
  { id: "pos", label: "レジ" },
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
        <div role="tablist" className="grid grid-cols-4 gap-1 rounded-xl bg-accent p-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={cn("h-10 rounded-lg text-sm font-semibold", tab === t.id ? "bg-card shadow-sm" : "text-muted-foreground")}
            >
              {t.label}
            </button>
          ))}
        </div>
        {tab === "products" && <ProductManager shopId={shopId} />}
        {tab === "cut" && <PriceCutManager shopId={shopId} />}
        {tab === "pos" && <PosCatalog shopId={shopId} shopName="レジ画面のプレビュー" embedded />}
        {tab === "staff" && <StaffManager shopId={shopId} />}
      </div>
    </Shell>
  );
}
