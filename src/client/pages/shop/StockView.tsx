import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useCatalog } from "@/lib/useCatalog";

/** 在庫の閲覧(店員も見られる)。残数の変更は店舗責任者が「商品」画面で行う */
export function StockView({ shopId }: { shopId: string }) {
  const { catalog, offline } = useCatalog(shopId, 5000);
  const [q, setQ] = useState("");
  const rows = useMemo(() => (catalog?.products ?? []).filter((p) => !q || p.name.includes(q)), [catalog, q]);
  return (
    <div className="flex flex-col gap-3">
      {offline && <p role="status" className="rounded-xl bg-amber-100 px-3 py-2 text-sm font-medium text-amber-900">通信できません。表示は最新でない可能性があります</p>}
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="商品名で探す" className="pl-9" aria-label="商品名で探す" />
      </div>
      {!catalog && <p className="p-6 text-center text-sm text-muted-foreground">読み込み中…</p>}
      <Card className="divide-y divide-border">
        {rows.map((p) => (
          <div key={p.id} className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <p className="truncate font-semibold">{p.name}</p>
              <div className="mt-0.5 flex flex-wrap gap-1">
                {p.soldOut && <Badge variant="destructive">{p.soldOutReason === "STOCK" ? "在庫なし" : "売り切れ"}</Badge>}
                {!p.trackStock && <Badge variant="muted">数量は管理していません</Badge>}
              </div>
            </div>
            {p.trackStock && p.stockQty !== null ? (
              <span className={`shrink-0 text-2xl font-extrabold ${p.stockQty <= 5 ? "text-amber-600" : ""}`}>
                {p.stockQty}
                <span className="ml-0.5 text-xs font-medium text-muted-foreground">個</span>
              </span>
            ) : (
              <span className="shrink-0 text-muted-foreground">—</span>
            )}
          </div>
        ))}
        {catalog && rows.length === 0 && <p className="p-4 text-sm text-muted-foreground">該当する商品がありません</p>}
      </Card>
    </div>
  );
}
