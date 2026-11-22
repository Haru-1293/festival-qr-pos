import { format, parse, isValid } from "date-fns";
import { CalendarDays, X } from "lucide-react";
import { useState } from "react";
import { Calendar } from "@/components/ui/calendar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

const DATE_FMT = "yyyy-MM-dd";
const DT_FMT = "yyyy-MM-dd'T'HH:mm";
const toDate = (s: string, fmt: string): Date | undefined => {
  if (!s) return undefined;
  const d = parse(s, fmt, new Date());
  return isValid(d) ? d : undefined;
};

const triggerClass =
  "flex h-12 w-full items-center gap-2 rounded-lg border border-input bg-card px-3 text-left text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

interface DatePickerProps {
  /** "YYYY-MM-DD"(空なら未選択) */
  value: string;
  onChange: (value: string) => void;
  /** "YYYY-MM-DD" */
  min?: string;
  max?: string;
  placeholder?: string;
  className?: string;
  /** 空にできる(×ボタンを出す) */
  clearable?: boolean;
  "aria-label"?: string;
}

/** 日付の選択。input[type=date] の代わりに、カレンダーのポップアップで選ぶ */
export function DatePicker({ value, onChange, min, max, placeholder = "日付を選ぶ", className, clearable, ...rest }: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const selected = toDate(value, DATE_FMT);
  const lo = min ? toDate(min, DATE_FMT) : undefined;
  const hi = max ? toDate(max, DATE_FMT) : undefined;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className={cn(triggerClass, className)} aria-label={rest["aria-label"]}>
        <CalendarDays className="size-4 shrink-0 text-muted-foreground" />
        <span className={cn("flex-1 truncate", !selected && "text-muted-foreground")}>{selected ? format(selected, "yyyy年M月d日") : placeholder}</span>
        {clearable && selected && (
          <span
            role="button"
            aria-label="日付を消す"
            className="rounded p-0.5 text-muted-foreground hover:bg-accent"
            onClick={(e) => {
              e.stopPropagation();
              onChange("");
            }}
          >
            <X className="size-4" />
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent>
        <Calendar
          mode="single"
          selected={selected}
          defaultMonth={selected ?? lo}
          disabled={[...(lo ? [{ before: lo }] : []), ...(hi ? [{ after: hi }] : [])]}
          onSelect={(d) => {
            if (d) {
              onChange(format(d, DATE_FMT));
              setOpen(false);
            }
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

interface DateTimePickerProps {
  /** "YYYY-MM-DDTHH:mm"(端末の時刻。空なら未選択) */
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 日時の選択(カレンダー+時・分)。input[type=datetime-local] の代わり */
export function DateTimePicker({ value, onChange, placeholder = "指定しない", className }: DateTimePickerProps) {
  const [open, setOpen] = useState(false);
  const selected = toDate(value, DT_FMT);
  const set = (d: Date, h: number, m: number) => onChange(format(new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m), DT_FMT));
  const hour = selected?.getHours() ?? 0;
  const minute = selected?.getMinutes() ?? 0;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className={cn(triggerClass, className)}>
        <CalendarDays className="size-4 shrink-0 text-muted-foreground" />
        <span className={cn("flex-1 truncate", !selected && "text-muted-foreground")}>{selected ? format(selected, "M月d日 HH:mm") : placeholder}</span>
        {selected && (
          <span
            role="button"
            aria-label="日時を消す"
            className="rounded p-0.5 text-muted-foreground hover:bg-accent"
            onClick={(e) => {
              e.stopPropagation();
              onChange("");
            }}
          >
            <X className="size-4" />
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent className="flex flex-col gap-3">
        <Calendar mode="single" selected={selected} defaultMonth={selected} onSelect={(d) => d && set(d, hour, minute)} />
        <div className="flex items-center justify-center gap-2 border-t border-border pt-3 text-sm">
          <span className="text-muted-foreground">時刻</span>
          <TimeSelect value={hour} max={23} label="時" onChange={(h) => set(selected ?? new Date(), h, minute)} />
          <span>:</span>
          <TimeSelect value={minute} max={59} step={5} label="分" onChange={(m) => set(selected ?? new Date(), hour, m)} />
        </div>
      </PopoverContent>
    </Popover>
  );
}

function TimeSelect({ value, max, step = 1, label, onChange }: { value: number; max: number; step?: number; label: string; onChange: (v: number) => void }) {
  const opts: number[] = [];
  for (let i = 0; i <= max; i += step) opts.push(i);
  if (!opts.includes(value)) opts.push(value);
  opts.sort((a, b) => a - b);
  return (
    <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
      <SelectTrigger aria-label={label} className="h-9 w-20 px-2 text-sm">
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="max-h-60">
        {opts.map((n) => (
          <SelectItem key={n} value={String(n)}>
            {pad(n)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
