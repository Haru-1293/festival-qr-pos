import { LogOut } from "lucide-react";
import type { ReactNode } from "react";
import { ROLE_LABELS } from "@shared/roles";
import { useAuth } from "@/lib/auth";

/** LINE 風のヘッダー(緑)+ 中央寄せの本文。スマホ幅を基準に、PC では最大幅で中央に表示する */
export function Shell({ title, children, wide = false }: { title: string; children: ReactNode; wide?: boolean }) {
  const { me, logout, settings } = useAuth();
  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 bg-primary text-primary-foreground shadow-sm">
        <div className={`mx-auto flex h-14 items-center justify-between px-4 ${wide ? "max-w-4xl" : "max-w-md"}`}>
          <div className="min-w-0">
            <p className="truncate text-base font-bold leading-tight">{title}</p>
            <p className="truncate text-xs opacity-90">{settings.festivalName}</p>
          </div>
          {me && (
            <button
              onClick={() => void logout()}
              className="flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-semibold hover:bg-white/15"
              aria-label="ログアウト"
            >
              <span className="hidden max-w-[10rem] truncate text-xs font-normal opacity-90 sm:inline">
                {ROLE_LABELS[me.user.role]} / {me.user.nickname}
              </span>
              <LogOut className="size-5" />
            </button>
          )}
        </div>
      </header>
      <main className={`mx-auto w-full flex-1 px-4 py-4 pb-10 ${wide ? "max-w-4xl" : "max-w-md"}`}>{children}</main>
    </div>
  );
}

export function ErrorText({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
      {message}
    </p>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}
