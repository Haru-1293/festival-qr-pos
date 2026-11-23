import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";

export interface Period {
  from?: number;
  to?: number;
}

const DAY = 86_400_000;
const JST = 9 * 3_600_000;
/** 日本時間の「YYYY-MM-DD」の0時(ミリ秒) */
const dayStart = (d: string): number => Date.parse(`${d}T00:00:00+09:00`);
const todayJst = (): string => new Date(Date.now() + JST).toISOString().slice(0, 10);

const minutes = (t: string): number => {
  const m = /^(\d{2}):(\d{2})$/.exec(t);
  return m ? (Number(m[1]) * 60 + Number(m[2])) * 60_000 : 0;
};

/**
 * 期間(日本時間の日付)の選択。終わりの日は、その日の終わりまで含む。
 * withTime のときは時刻も指定できる(開始は「日付の 開始時刻 から」、終了は「日付の 終了時刻 まで」。時刻が空なら日の始め・終わり)。
 */
export function PeriodPicker({ onChange, withTime }: { onChange: (p: Period) => void; withTime?: boolean }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [ft, setFt] = useState("");
  const [tt, setTt] = useState("");
  const apply = (f: string, t: string, fT = ft, tT = tt) => {
    setFrom(f);
    setTo(t);
    setFt(fT);
    setTt(tT);
    onChange({
      from: f ? dayStart(f) + (withTime ? minutes(fT) : 0) : undefined,
      // 終了時刻を入れたときは、その分の終わり(その分を含む)まで
      to: t ? (withTime && tT ? dayStart(t) + minutes(tT) + 60_000 : dayStart(t) + DAY) : undefined,
    });
  };
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="flex flex-col gap-1 text-xs text-muted-foreground">
        開始日
        <DatePicker value={from} onChange={(v) => apply(v, to)} clearable className="h-10 w-44" aria-label="開始日" />
      </div>
      {withTime && (
        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
          開始時刻
          <Input type="time" value={ft} onChange={(e) => apply(from, to, e.target.value, tt)} className="h-10 w-28" aria-label="開始時刻" />
        </div>
      )}
      <div className="flex flex-col gap-1 text-xs text-muted-foreground">
        終了日
        <DatePicker value={to} onChange={(v) => apply(from, v)} clearable className="h-10 w-44" aria-label="終了日" />
      </div>
      {withTime && (
        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
          終了時刻
          <Input type="time" value={tt} onChange={(e) => apply(from, to, ft, e.target.value)} className="h-10 w-28" aria-label="終了時刻" />
        </div>
      )}
      <Button type="button" variant="outline" size="sm" onClick={() => apply(todayJst(), todayJst(), "", "")}>
        今日
      </Button>
      <Button type="button" variant="outline" size="sm" onClick={() => apply("", "", "", "")}>
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
