import { Minus, Plus, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { SetDto } from "@shared/api";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";

interface Props {
  set: SetDto;
  onAdd: (picks: Record<string, string[]>, quantity: number) => void;
  onClose: () => void;
}

/** セットの内訳を選ぶ画面(下から出るシート)。必須の内訳がすべて選ばれるまで追加できない */
export function SetPicker({ set, onAdd, onClose }: Props) {
  const { money } = useAuth();
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const [qty, setQty] = useState(1);

  const toggle = (segId: string, pid: string, count: number, dup: boolean) =>
    setPicks((cur) => {
      const arr = cur[segId] ?? [];
      if (count === 1) return { ...cur, [segId]: arr[0] === pid ? [] : [pid] }; // 1つ選ぶ内訳は、押し直すと選び直し/解除
      if (dup) return { ...cur, [segId]: arr.length < count ? [...arr, pid] : arr }; // 重複可は押すたびに追加
      if (arr.includes(pid)) return { ...cur, [segId]: arr.filter((x) => x !== pid) };
      return { ...cur, [segId]: arr.length < count ? [...arr, pid] : arr };
    });

  const state = useMemo(() => {
    let surcharge = 0;
    const missing: string[] = [];
    for (const g of set.segments) {
      const arr = picks[g.id] ?? [];
      for (const pid of arr) surcharge += g.items.find((i) => i.productId === pid)?.surcharge ?? 0;
      if (g.required ? arr.length !== g.pickCount : arr.length !== 0 && arr.length !== g.pickCount) missing.push(g.name);
    }
    return { surcharge, missing };
  }, [picks, set]);

  const unit = set.salePrice + state.surcharge;
  const ok = state.missing.length === 0 && Object.values(picks).some((a) => a.length > 0);

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/40" role="dialog" aria-modal="true" aria-label={`${set.name}の内訳を選ぶ`}>
      <div className="mx-auto flex max-h-[92vh] w-full max-w-md flex-col rounded-t-3xl bg-background">
        <div className="flex items-start justify-between gap-2 px-4 pt-4">
          <div className="min-w-0">
            <p className="text-lg font-extrabold leading-tight">{set.name}</p>
            <p className="text-sm text-muted-foreground">
              {set.cutAmount > 0 && <span className="mr-1.5 line-through">{money(set.price)}</span>}
              <span className="font-bold text-foreground">{money(set.salePrice)}</span>
              {set.description ? ` ・ ${set.description}` : ""}
            </p>
          </div>
          <Button size="icon" variant="ghost" aria-label="閉じる" onClick={onClose}>
            <X />
          </Button>
        </div>
        <div className="flex flex-col gap-4 overflow-y-auto px-4 py-3">
          {set.segments.map((g) => {
            const arr = picks[g.id] ?? [];
            return (
              <section key={g.id} aria-label={g.name}>
                <p className="mb-1.5 text-sm font-bold">
                  {g.name}
                  <span className="ml-2 text-xs font-medium text-muted-foreground">
                    {g.required ? "必須" : "お好みで"}・{g.pickCount}つ選ぶ{g.pickCount > 1 ? `(${arr.length}/${g.pickCount})` : ""}
                  </span>
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {g.items.map((i) => {
                    const n = arr.filter((x) => x === i.productId).length;
                    return (
                      <button
                        key={i.productId}
                        type="button"
                        disabled={i.disabled}
                        aria-pressed={n > 0}
                        onClick={() => toggle(g.id, i.productId, g.pickCount, g.allowDuplicate)}
                        className={cn(
                          "flex min-h-14 flex-col items-start justify-center rounded-xl border-2 px-3 py-2 text-left text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50",
                          n > 0 ? "border-primary bg-secondary" : "border-border bg-card",
                        )}
                      >
                        <span className="flex w-full items-center justify-between gap-1">
                          <span className="line-clamp-2">{i.name}</span>
                          {n > 0 && g.pickCount > 1 && <span className="rounded-full bg-primary px-1.5 text-xs text-primary-foreground">×{n}</span>}
                        </span>
                        <span className="text-xs font-medium text-muted-foreground">
                          {i.disabled ? "売り切れ" : i.surcharge > 0 ? `+${money(i.surcharge)}` : "追加料金なし"}
                        </span>
                      </button>
                    );
                  })}
                </div>
                {g.pickCount > 1 && arr.length > 0 && (
                  <button className="mt-1 text-xs text-muted-foreground underline" onClick={() => setPicks((c) => ({ ...c, [g.id]: [] }))}>
                    選び直す
                  </button>
                )}
              </section>
            );
          })}
        </div>
        <div className="flex flex-col gap-2 border-t border-border px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Button size="icon" variant="outline" aria-label="セット数を減らす" onClick={() => setQty((q) => Math.max(1, q - 1))}>
                <Minus />
              </Button>
              <span className="w-8 text-center text-lg font-bold">{qty}</span>
              <Button size="icon" variant="outline" aria-label="セット数を増やす" onClick={() => setQty((q) => Math.min(99, q + 1))}>
                <Plus />
              </Button>
            </div>
            <p className="text-2xl font-extrabold tracking-tight">{money(unit * qty)}</p>
          </div>
          {state.missing.length > 0 && Object.values(picks).some((a) => a.length > 0) && (
            <p className="text-xs font-semibold text-destructive">「{state.missing.join("」「")}」を選んでください</p>
          )}
          <Button size="lg" disabled={!ok} onClick={() => onAdd(picks, qty)}>
            カートに入れる
          </Button>
        </div>
      </div>
    </div>
  );
}
