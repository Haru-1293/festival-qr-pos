import { useState } from "react";
import { Shell } from "@/components/Shell";
import { cn } from "@/lib/utils";
import { AdminSettings } from "./AdminSettings";
import { AdminShops } from "./AdminShops";
import { AdminUsers } from "./AdminUsers";

const TABS = [
  { id: "shops", label: "店舗" },
  { id: "users", label: "スタッフ・利用者" },
  { id: "settings", label: "設定" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export function AdminHome() {
  const [tab, setTab] = useState<TabId>("shops");
  return (
    <Shell title="全体管理" wide>
      <div className="flex flex-col gap-4">
        <div role="tablist" className="flex gap-1 rounded-xl bg-accent p-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                "h-10 flex-1 rounded-lg text-sm font-semibold transition-colors",
                tab === t.id ? "bg-card shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        {tab === "shops" && <AdminShops />}
        {tab === "users" && <AdminUsers />}
        {tab === "settings" && <AdminSettings />}
      </div>
    </Shell>
  );
}
