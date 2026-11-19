import { Delete } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  length?: number;
}

/**
 * 4桁PINの入力。伏せ字の丸と、大きな数字キーだけ(端末のキーボードを出さず、文字として画面や履歴に残さない)。
 * PINは入力欄の値ではなく状態として持ち、確定の通信にだけ使う。
 */
export function PinPad({ value, onChange, disabled, length = 4 }: Props) {
  const press = (d: string) => !disabled && value.length < length && onChange(value + d);
  return (
    <div className="mx-auto flex w-full max-w-[16rem] flex-col items-center gap-3" role="group" aria-label="PIN入力">
      <div className="flex gap-3" aria-live="polite" aria-label={`${value.length}桁入力済み`}>
        {Array.from({ length }, (_, i) => (
          <span key={i} className={cn("size-4 rounded-full border-2 border-primary", i < value.length && "bg-primary")} />
        ))}
      </div>
      <div className="grid w-full grid-cols-3 gap-2">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
          <button
            key={d}
            type="button"
            disabled={disabled}
            onClick={() => press(d)}
            className="h-14 rounded-xl bg-secondary text-xl font-bold active:bg-accent disabled:opacity-50"
          >
            {d}
          </button>
        ))}
        <span />
        <button type="button" disabled={disabled} onClick={() => press("0")} className="h-14 rounded-xl bg-secondary text-xl font-bold active:bg-accent disabled:opacity-50">
          0
        </button>
        <button
          type="button"
          disabled={disabled || value.length === 0}
          onClick={() => onChange(value.slice(0, -1))}
          aria-label="1文字消す"
          className="flex h-14 items-center justify-center rounded-xl bg-secondary active:bg-accent disabled:opacity-40"
        >
          <Delete />
        </button>
      </div>
    </div>
  );
}
