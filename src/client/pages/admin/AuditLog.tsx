import { Download } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AUDIT_CATEGORIES, type AuditEntryDto, type ShopDto } from "@shared/api";
import { ROLE_LABELS, type Role } from "@shared/roles";
import { PeriodPicker, type Period } from "@/components/PeriodPicker";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ErrorText } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/utils";

const pretty = (j: string | null): string => {
  if (!j) return "";
  try {
    return JSON.stringify(JSON.parse(j), null, 1);
  } catch {
    return j;
  }
};

const ALL = "ALL";
const LIMITS = [10, 20, 50, 100];
const ROLES: Role[] = ["ADMIN", "SHOP_MANAGER", "CLERK", "RECEPTION", "CUSTOMER"];

interface Filters {
  category: string;
  shopId: string;
  role: string;
  q: string;
  action: string;
  period: Period;
  order: "desc" | "asc";
  limit: number;
}
const INITIAL: Filters = { category: ALL, shopId: ALL, role: ALL, q: "", action: "", period: {}, order: "desc", limit: 20 };

const toParams = (f: Filters): URLSearchParams => {
  const p = new URLSearchParams({ order: f.order, limit: String(f.limit) });
  if (f.category !== ALL) p.set("category", f.category);
  if (f.shopId !== ALL) p.set("shopId", f.shopId);
  if (f.role !== ALL) p.set("role", f.role);
  if (f.q.trim()) p.set("q", f.q.trim());
  if (f.action.trim()) p.set("action", f.action.trim());
  if (f.period.from !== undefined) p.set("from", String(f.period.from));
  if (f.period.to !== undefined) p.set("to", String(f.period.to));
  return p;
};

/**
 * 監査ログ(いつ・誰が・何をしたか)。開いただけでは読み込まず、条件を決めて「検索」を押したときだけ読む
 * (データベースの読み取り量を抑えるため)。1回に最大100件、続きは「さらに読み込む」。
 */
export function AuditLog() {
  const [f, setF] = useState<Filters>(INITIAL);
  const [applied, setApplied] = useState<Filters | null>(null); // 最後に検索した条件(続きの読み込み・CSVはこれを使う)
  const [shops, setShops] = useState<ShopDto[]>([]);
  const [entries, setEntries] = useState<AuditEntryDto[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api<{ shops: ShopDto[] }>("/admin/shops").then((r) => setShops(r.shops)).catch(() => undefined);
  }, []);

  const search = useCallback(async (cond: Filters, cursor?: string) => {
    setBusy(true);
    setError(null);
    try {
      const p = toParams(cond);
      if (cursor) p.set("cursor", cursor);
      const r = await api<{ entries: AuditEntryDto[]; next: string | null }>(`/reports/audit?${p}`);
      setEntries((cur) => (cursor && cur ? [...cur, ...r.entries] : r.entries));
      setNext(r.next);
      if (!cursor) {
        setApplied(cond);
        setOpen(null);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setF((cur) => ({ ...cur, [k]: v }));

  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex flex-col gap-3 rounded-xl bg-card p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void search(f);
        }}
      >
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            種類
            <Select value={f.category} onValueChange={(v) => set("category", v)}>
              <SelectTrigger aria-label="種類">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>すべて</SelectItem>
                {AUDIT_CATEGORIES.map((c) => (
                  <SelectItem key={c.key} value={c.key}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            店舗
            <Select value={f.shopId} onValueChange={(v) => set("shopId", v)}>
              <SelectTrigger aria-label="店舗">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>すべて</SelectItem>
                {shops.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            操作したアカウントの種別
            <Select value={f.role} onValueChange={(v) => set("role", v)}>
              <SelectTrigger aria-label="アカウント種別">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>すべて</SelectItem>
                {ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            並び順
            <Select value={f.order} onValueChange={(v) => set("order", v as "desc" | "asc")}>
              <SelectTrigger aria-label="並び順">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="desc">新しい順</SelectItem>
                <SelectItem value="asc">古い順</SelectItem>
              </SelectContent>
            </Select>
          </label>
        </div>
        <PeriodPicker withTime onChange={(period) => set("period", period)} />
        <div className="grid gap-2 sm:grid-cols-3">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            操作名(先頭一致。例: refund.full)
            <Input value={f.action} onChange={(e) => set("action", e.target.value)} maxLength={60} className="h-10" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            操作者名・対象ID
            <Input value={f.q} onChange={(e) => set("q", e.target.value)} maxLength={60} className="h-10" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            件数(1回に読む最大。直近n件はここと「新しい順」)
            <Select value={String(f.limit)} onValueChange={(v) => set("limit", Number(v))}>
              <SelectTrigger aria-label="件数">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LIMITS.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n}件
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy}>
            検索
          </Button>
          <Button type="button" variant="ghost" onClick={() => setF(INITIAL)} disabled={busy}>
            条件をリセット
          </Button>
          {applied && (
            <Button asChild variant="outline">
              <a href={`/api/reports/audit.csv?${(() => { const p = toParams(applied); p.delete("limit"); return p; })()}`} download>
                <Download className="size-4" /> この条件でCSV(最大1000件)
              </a>
            </Button>
          )}
        </div>
      </form>
      <ErrorText message={error} />
      {entries === null ? (
        <p className="p-6 text-center text-sm text-muted-foreground">条件を決めて「検索」を押してください(開いただけでは読み込みません)</p>
      ) : (
        <Card>
          <CardContent className="flex flex-col divide-y divide-border">
            {entries.length === 0 && !busy && <p className="py-2 text-sm text-muted-foreground">条件に合う記録がありません</p>}
            {entries.map((e) => (
              <div key={e.id} className="py-2.5 text-sm">
                <button type="button" className="flex w-full flex-col gap-0.5 text-left" onClick={() => setOpen(open === e.id ? null : e.id)} aria-expanded={open === e.id}>
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="font-mono text-xs font-bold">{e.action}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{formatDateTime(e.createdAt)}</span>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {e.actorNickname ?? "システム"}
                    {e.actorRole ? `(${ROLE_LABELS[e.actorRole as Role] ?? e.actorRole})` : ""}
                    {e.shopName ? ` ・ ${e.shopName}` : ""}{e.currentShopName ? `(現在の店舗名: ${e.currentShopName})` : ""}
                    {e.targetType ? ` ・ ${e.targetType}` : ""}
                    {e.reason ? ` ・ 理由: ${e.reason}` : ""}
                  </span>
                </button>
                {open === e.id && (
                  <div className="mt-2 grid gap-2 rounded-lg bg-muted p-2 text-xs sm:grid-cols-2">
                    {e.targetId && <p className="break-all sm:col-span-2">対象ID: {e.targetId}</p>}
                    {e.before && (
                      <pre className="overflow-x-auto whitespace-pre-wrap break-all">
                        変更前{"\n"}
                        {pretty(e.before)}
                      </pre>
                    )}
                    {e.after && (
                      <pre className="overflow-x-auto whitespace-pre-wrap break-all">
                        変更後{"\n"}
                        {pretty(e.after)}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            ))}
            {next !== null && applied && (
              <Button variant="outline" className="mt-3" disabled={busy} onClick={() => void search(applied, next)}>
                {busy ? "読み込み中…" : `さらに読み込む(最大${applied.limit}件)`}
              </Button>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
