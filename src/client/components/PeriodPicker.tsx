import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";

export interface Period {
  from?: number;
  to?: number;
}

const DAY = 86_400_000;
const JST = 9 * 3_600_000;
/** 日本時間の「YYYY-MM-DD」の0時(ミリ秒) */
const dayStart = (d: string): number => Date.parse(`${d}T00:00:00+09:00`);
const todayJst = (): string => new Date(Date.now() + JST).toISOString().slice(0, 10);

/** 期間(日本時間の日付)の選択。終わりの日は、その日の終わりまで含む */
export function PeriodPicker({ onChange }: { onChange: (p: Period) => void }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const apply = (f: string, t: string) => {
    setFrom(f);
    setTo(t);
    onChange({ from: f ? dayStart(f) : undefined, to: t ? dayStart(t) + DAY : undefined });
  };
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="flex flex-col gap-1 text-xs text-muted-foreground">
        開始日
        <DatePicker value={from} onChange={(v) => apply(v, to)} clearable className="h-10 w-44" aria-label="開始日" />
      </div>
      <div className="flex flex-col gap-1 text-xs text-muted-foreground">
        終了日
        <DatePicker value={to} onChange={(v) => apply(from, v)} clearable className="h-10 w-44" aria-label="終了日" />
      </div>
      <Button type="button" variant="outline" size="sm" onClick={() => apply(todayJst(), todayJst())}>
        今日
      </Button>
      <Button type="button" variant="outline" size="sm" onClick={() => apply("", "")}>
        全期間
      </Button>
    </div>
  );
}

export function periodQuery(p: Period): string {
  const q = new URLSearchParams();
  if (p.from !== undefined) q.set("from", String(p.from));
  if (p.to !== undefined) q.set("to", String(p.to));
  const s = q.toString();
  return s ? `?${s}` : "";
}
