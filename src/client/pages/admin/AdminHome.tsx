import { useState } from "react";
import { Shell } from "@/components/Shell";
import { cn } from "@/lib/utils";
import { CardManager } from "./CardManager";
import { AdminSales } from "./AdminSales";
import { AuditLog } from "./AuditLog";
import { AdminRefunds } from "./AdminRefunds";
import { DiscountManager } from "./DiscountManager";
import { AdminCash } from "./AdminCash";
import { AdminSettings } from "./AdminSettings";
import { AdminShops } from "./AdminShops";
import { AdminUsers } from "./AdminUsers";

const TABS = [
  { id: "shops", label: "店舗" },
  { id: "users", label: "スタッフ・利用者" },
  { id: "cards", label: "カード" },
  { id: "sales", label: "売上" },
  { id: "refunds", label: "返金" },
  { id: "discounts", label: "割引" },
  { id: "cash", label: "現金" },
  { id: "audit", label: "監査ログ" },
  { id: "settings", label: "設定" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export function AdminHome() {
  const [tab, setTab] = useState<TabId>("shops");
  return (
    <Shell title="全体管理" wide>
      <div className="flex flex-col gap-4">
        <div role="tablist" className="flex gap-1 overflow-x-auto rounded-xl bg-accent p-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                "h-10 shrink-0 flex-1 whitespace-nowrap rounded-lg px-3 text-sm font-semibold transition-colors",
                tab === t.id ? "bg-card shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        {tab === "shops" && <AdminShops />}
        {tab === "users" && <AdminUsers />}
        {tab === "cards" && <CardManager />}
        {tab === "sales" && <AdminSales />}
        {tab === "refunds" && <AdminRefunds />}
        {tab === "discounts" && <DiscountManager />}
        {tab === "cash" && <AdminCash />}
        {tab === "audit" && <AuditLog />}
        {tab === "settings" && <AdminSettings />}
      </div>
    </Shell>
  );
}
