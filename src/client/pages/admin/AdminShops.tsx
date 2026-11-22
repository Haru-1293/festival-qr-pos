import { Store } from "lucide-react";
import { Link } from "react-router-dom";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { ShopDto } from "@shared/api";
import { ErrorText, Field } from "@/components/Shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useAction } from "@/lib/useAction";
import { useConfirm } from "@/lib/confirm";

const STATUS_LABEL: Record<ShopDto["status"], string> = {
  ACTIVE: "営業中",
  SUSPENDED: "停止中",
  CLOSED: "終了",
};

export function AdminShops() {
  const confirm = useConfirm();
  const [shops, setShops] = useState<ShopDto[]>([]);
  const [name, setName] = useState("");
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
              <Button size="sm" variant="outline" disabled={row.pending} onClick={() => setStatus(s, s.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE")}>
                {s.status === "ACTIVE" ? "停止" : "再開"}
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
