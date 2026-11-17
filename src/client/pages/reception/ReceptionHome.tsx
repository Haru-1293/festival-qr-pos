import { useState } from "react";
import { Shell } from "@/components/Shell";
import { cn } from "@/lib/utils";
import { CashPanel } from "./CashPanel";
import { ChargePanel } from "./ChargePanel";

const TABS = [
  { id: "desk", label: "チャージ・払い戻し" },
  { id: "cash", label: "現金" },
] as const;
type TabId = (typeof TABS)[number]["id"];

/** 受付担当者の画面。お客様の対応中の状態を失わないよう、会計タブは切り替えても保持する */
export function ReceptionHome() {
  const [tab, setTab] = useState<TabId>("desk");
  const [refreshKey, setRefreshKey] = useState(0);
  return (
    <Shell title="受付">
      <div className="flex flex-col gap-4">
        <div role="tablist" className="grid grid-cols-2 gap-1 rounded-xl bg-accent p-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={cn("h-11 rounded-lg text-sm font-semibold", tab === t.id ? "bg-card shadow-sm" : "text-muted-foreground")}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className={tab === "desk" ? "" : "hidden"}>
          <ChargePanel onChanged={() => setRefreshKey((k) => k + 1)} />
        </div>
        {tab === "cash" && <CashPanel refreshKey={refreshKey} onChanged={() => setRefreshKey((k) => k + 1)} />}
      </div>
    </Shell>
  );
}
