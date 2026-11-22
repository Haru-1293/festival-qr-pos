import { ChevronsLeft, ChevronsRight, LogOut, Menu, QrCode, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { ROLE_LABELS } from "@shared/roles";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useAuth } from "@/lib/auth";
import { useLocalStorage } from "@/lib/useLocalStorage";
import { cn } from "@/lib/utils";

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** 末尾まで一致したときだけ選択中にする */
  end?: boolean;
}

function NavList({ items, collapsed, onNavigate }: { items: NavItem[]; collapsed: boolean; onNavigate?: () => void }) {
  return (
    <nav aria-label="メニュー" className="flex flex-col gap-1">
      {items.map((it) => (
        <NavLink
          key={it.to}
          to={it.to}
          end={it.end}
          onClick={onNavigate}
          title={collapsed ? it.label : undefined}
          aria-label={it.label}
          className={({ isActive }) =>
            cn(
              "flex h-11 items-center gap-3 rounded-lg px-3 text-sm font-semibold transition-colors",
              collapsed && "justify-center px-0",
              isActive ? "bg-secondary text-secondary-foreground" : "text-foreground/80 hover:bg-accent",
            )
          }
        >
          <it.icon className="size-5 shrink-0" />
          {!collapsed && <span className="truncate">{it.label}</span>}
        </NavLink>
      ))}
    </nav>
  );
}

/**
 * 管理・店舗・店員・受付の共通レイアウト。左側のメニューは格納でき、格納時はアイコンだけになる。
 * 狭い画面(スマホ)ではメニューを隠し、ヘッダーのボタンで開く。
 */
export function ConsoleLayout({ nav, brand }: { nav: NavItem[]; brand: string }) {
  const { me, logout, settings } = useAuth();
  const [collapsed, setCollapsed] = useLocalStorage("fqp.sidebar.collapsed", false);
  const [drawer, setDrawer] = useState(false);
  const loc = useLocation();
  const current = nav.find((n) => (n.end ? loc.pathname === n.to : loc.pathname === n.to || loc.pathname.startsWith(n.to + "/")));

  const user = me && (
    <div className={cn("flex items-center gap-2 text-xs", collapsed && "hidden")}>
      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold">{me.user.nickname}</p>
        <p className="truncate text-muted-foreground">
          {ROLE_LABELS[me.user.role]}
          {me.user.shopName ? ` / ${me.user.shopName}` : ""}
        </p>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-dvh">
      <aside
        className={cn(
          "sticky top-0 hidden h-dvh shrink-0 flex-col gap-3 border-r border-border bg-card p-2 transition-[width] duration-200 md:flex",
          collapsed ? "w-16" : "w-60",
        )}
      >
        <div className={cn("flex h-12 items-center gap-2 px-1", collapsed && "justify-center")}>
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <QrCode className="size-5" />
          </span>
          {!collapsed && (
            <div className="min-w-0">
              <p className="truncate text-sm font-bold leading-tight">{brand}</p>
              <p className="truncate text-xs text-muted-foreground">{settings.festivalName}</p>
            </div>
          )}
        </div>
        <div className="flex-1 overflow-y-auto">
          <NavList items={nav} collapsed={collapsed} />
        </div>
        <div className="flex flex-col gap-2 border-t border-border pt-2">
          {user}
          <button
            onClick={() => void logout()}
            title="ログアウト"
            aria-label="ログアウト"
            className={cn("flex h-10 items-center gap-3 rounded-lg px-3 text-sm font-semibold text-foreground/80 hover:bg-accent", collapsed && "justify-center px-0")}
          >
            <LogOut className="size-5 shrink-0" />
            {!collapsed && "ログアウト"}
          </button>
          <button
            onClick={() => setCollapsed(!collapsed)}
            title={collapsed ? "メニューを広げる" : "メニューをたたむ"}
            aria-label={collapsed ? "メニューを広げる" : "メニューをたたむ"}
            aria-expanded={!collapsed}
            className={cn("flex h-10 items-center gap-3 rounded-lg px-3 text-sm text-muted-foreground hover:bg-accent", collapsed && "justify-center px-0")}
          >
            {collapsed ? <ChevronsRight className="size-5" /> : <ChevronsLeft className="size-5" />}
            {!collapsed && "たたむ"}
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-2 bg-primary px-3 text-primary-foreground shadow-sm">
          <button className="rounded-lg p-2 hover:bg-white/15 md:hidden" onClick={() => setDrawer(true)} aria-label="メニューを開く">
            <Menu className="size-6" />
          </button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-base font-bold leading-tight">{current?.label ?? brand}</p>
            <p className="truncate text-xs opacity-90">
              {me?.user.shopName ? `${me.user.shopName} ・ ` : ""}
              {settings.festivalName}
            </p>
          </div>
          {me && <span className="hidden max-w-[12rem] truncate text-xs opacity-90 sm:inline">{me.user.nickname}</span>}
          <button onClick={() => void logout()} className="rounded-lg p-2 hover:bg-white/15 md:hidden" aria-label="ログアウト">
            <LogOut className="size-5" />
          </button>
        </header>
        {settings.emergency.on && (
          <div role="alert" className="sticky top-14 z-20 bg-destructive px-4 py-2 text-center text-sm font-bold text-destructive-foreground">
            緊急停止中です{settings.emergency.message ? `:${settings.emergency.message}` : ""}(決済・チャージ・払戻しを止めています)
          </div>
        )}
        <main className="mx-auto w-full max-w-[1600px] flex-1 p-3 pb-10 sm:p-5">
          <Outlet />
        </main>
      </div>

      <Dialog open={drawer} onOpenChange={setDrawer}>
        <DialogContent
          hideClose
          className="left-0 top-0 h-dvh max-h-dvh w-72 max-w-[85vw] translate-x-0 translate-y-0 justify-start gap-3 rounded-none rounded-r-2xl p-3"
        >
          <DialogTitle className="sr-only">メニュー</DialogTitle>
          <DialogDescription className="sr-only">ページを切り替えます</DialogDescription>
          <div className="flex h-12 items-center gap-2 px-1">
            <span className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <QrCode className="size-5" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-bold leading-tight">{brand}</p>
              <p className="truncate text-xs text-muted-foreground">{me?.user.nickname}</p>
            </div>
          </div>
          <NavList items={nav} collapsed={false} onNavigate={() => setDrawer(false)} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** 管理ページの本文の幅。フォームや一覧は読みやすい幅に、レジ・グラフは画面いっぱいに使う */
export function Page({ width = "md", children }: { width?: "md" | "lg" | "full"; children: React.ReactNode }) {
  return <div className={cn("mx-auto w-full", width === "md" && "max-w-3xl", width === "lg" && "max-w-5xl")}>{children}</div>;
}
