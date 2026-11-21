import { useState } from "react";
import { Shell } from "@/components/Shell";
import { CardManager } from "./CardManager";
import { AdminSales } from "./AdminSales";
import { AuditLog } from "./AuditLog";
import { AdminRefunds } from "./AdminRefunds";
import { DiscountManager } from "./DiscountManager";
import { AdminCash } from "./AdminCash";
import { AdminSettings } from "./AdminSettings";
import { AdminShops } from "./AdminShops";
import { AdminUsers } from "./AdminUsers";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

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
        <Tabs value={tab} onValueChange={(v) => setTab(v as TabId)}>
          <TabsList aria-label="管理メニュー">
            {TABS.map((t) => (
              <TabsTrigger key={t.id} value={t.id}>
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
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
