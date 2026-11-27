import { Store, UserPlus } from "lucide-react";
import { Link } from "react-router-dom";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { ShopDto } from "@shared/api";
import { ErrorText, Field } from "@/components/Shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useAction } from "@/lib/useAction";
import { useConfirm } from "@/lib/confirm";

const STATUS_LABEL: Record<ShopDto["status"], string> = {
  ACTIVE: "営業中",
  SUSPENDED: "停止中",
  CLOSED: "終了",
};

/** 既存の店舗に、店舗責任者を追加する(1つの店舗に何人でも置ける) */
function AddManagerDialog({ shop, onClose }: { shop: ShopDto; onClose: () => void }) {
  const [managers, setManagers] = useState<{ id: string; nickname: string; loginId: string | null; status: string }[] | null>(null);
  const [nick, setNick] = useState("");
  const [login, setLogin] = useState("");
  const [pass, setPass] = useState("");
  const [added, setAdded] = useState<string | null>(null);
  const act = useAction();
  const load = useCallback(async () => {
    setManagers((await api<{ managers: { id: string; nickname: string; loginId: string | null; status: string }[] }>(`/admin/shops/${shop.id}/managers`)).managers);
  }, [shop.id]);
  useEffect(() => {
    void load().catch(() => setManagers([]));
  }, [load]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setAdded(null);
    void act.run(async () => {
      await api("/admin/users/shop-manager", { body: { shopId: shop.id, loginId: login.trim(), password: pass, nickname: nick.trim() } });
      setAdded(`${nick.trim()} さんを追加しました。ログインIDとパスワードを本人に直接伝えてください`);
      setNick("");
      setLogin("");
      setPass("");
      await load();
    });
  };
  return (
    <Dialog open onOpenChange={(o) => !o && !act.pending && onClose()}>
      <DialogContent onInteractOutside={(e) => e.preventDefault()}>
        <DialogTitle>{shop.displayName} に店舗責任者を追加</DialogTitle>
        <DialogDescription>1つの店舗に、店舗責任者を何人でも置けます。</DialogDescription>
        <div className="rounded-lg bg-muted px-3 py-2 text-sm">
          <p className="mb-1 font-semibold">いまの店舗責任者</p>
          {managers === null ? (
            <p className="text-muted-foreground">読み込み中…</p>
          ) : managers.length === 0 ? (
            <p className="text-muted-foreground">まだいません</p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {managers.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-2">
                  <span className="truncate">{m.nickname}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {m.loginId ?? "IDなし"}
                    {m.status !== "ACTIVE" && "(停止中)"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <Field label="表示名">
            <Input value={nick} onChange={(e) => setNick(e.target.value)} maxLength={20} required />
          </Field>
          <Field label="ログインID">
            <Input value={login} onChange={(e) => setLogin(e.target.value)} autoCapitalize="none" required />
          </Field>
          <Field label="初期パスワード" hint="8文字以上。本人に直接伝えてください">
            <Input value={pass} onChange={(e) => setPass(e.target.value)} minLength={8} autoComplete="off" required />
          </Field>
          <ErrorText message={act.error} />
          {added && <p className="rounded-lg bg-secondary px-3 py-2 text-sm font-medium">{added}</p>}
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={act.pending}>
              閉じる
            </Button>
            <Button type="submit" className="flex-1" disabled={act.pending}>
              {act.pending ? "追加中…" : "責任者を追加"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function AdminShops() {
  const confirm = useConfirm();
  const [shops, setShops] = useState<ShopDto[]>([]);
  const [name, setName] = useState("");
  const [addFor, setAddFor] = useState<ShopDto | null>(null);
  const create = useAction();
  const row = useAction();

  const load = useCallback(async () => {
    setShops((await api<{ shops: ShopDto[] }>("/admin/shops")).shops);
  }, []);
  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void create.run(async () => {
      await api("/admin/shops", { body: { name, displayName: name } });
      setName("");
      await load();
    });
  };

  const setStatus = async (s: ShopDto, status: ShopDto["status"]) => {
    if (status !== "ACTIVE" && !(await confirm(`${s.displayName} を「${STATUS_LABEL[status]}」にしますか?`, { destructive: true }))) return;
    void row.run(async () => {
      await api(`/admin/shops/${s.id}`, { method: "PATCH", body: { status } });
      await load();
    });
  };

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Store className="size-5" /> 店舗(クラス・団体)を追加
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="flex flex-col gap-3">
            <Field label="店舗名" hint="例: 2年A組 焼きそば">
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={50} required />
            </Field>
            <ErrorText message={create.error} />
            <Button type="submit" disabled={create.pending}>
              {create.pending ? "追加中…" : "追加する"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>店舗一覧</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col divide-y divide-border">
          <ErrorText message={row.error} />
          {shops.length === 0 && <p className="py-2 text-sm text-muted-foreground">まだ店舗がありません</p>}
          {shops.map((s) => (
            <div key={s.id} className="flex items-center justify-between gap-2 py-3">
              <div className="min-w-0">
                <Link to={`/admin/shops/${s.id}`} className="block truncate font-semibold hover:underline">
                  {s.displayName}
                </Link>
                <Badge variant={s.status === "ACTIVE" ? "default" : "warning"} className="mt-1">
                  {STATUS_LABEL[s.status]}
                </Badge>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button size="sm" variant="outline" onClick={() => setAddFor(s)}>
                  <UserPlus className="!size-4" /> 責任者を追加
                </Button>
                <Button size="sm" variant="outline" disabled={row.pending} onClick={() => setStatus(s, s.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE")}>
                  {s.status === "ACTIVE" ? "停止" : "再開"}
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
      {addFor && <AddManagerDialog shop={addFor} onClose={() => setAddFor(null)} />}
    </div>
  );
}
