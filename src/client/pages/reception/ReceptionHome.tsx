import { useState } from "react";
import { Shell } from "@/components/Shell";
import { CashPanel } from "./CashPanel";
import { ChargePanel } from "./ChargePanel";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

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
        <Tabs value={tab} onValueChange={(v) => setTab(v as TabId)}>
          <TabsList aria-label="受付メニュー" className="grid grid-cols-2">
            {TABS.map((t) => (
              <TabsTrigger key={t.id} value={t.id} className="h-11">
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className={tab === "desk" ? "" : "hidden"}>
          <ChargePanel onChanged={() => setRefreshKey((k) => k + 1)} />
        </div>
        {tab === "cash" && <CashPanel refreshKey={refreshKey} onChanged={() => setRefreshKey((k) => k + 1)} />}
      </div>
    </Shell>
  );
}
