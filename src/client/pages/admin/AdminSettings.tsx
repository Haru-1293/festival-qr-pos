import { useEffect, useState, type FormEvent } from "react";
import type { OperationSettings } from "@shared/api";
import type { CurrencySettings } from "@shared/currency";
import { formatMoney } from "@shared/currency";
import { ErrorText, Field } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction } from "@/lib/useAction";

export function AdminSettings() {
  const { refresh, settings } = useAuth();
  const [c, setC] = useState<CurrencySettings>(settings.currency);
  const [festivalName, setFestivalName] = useState(settings.festivalName);
  const [saved, setSaved] = useState<string | null>(null);
  const currency = useAction();
  const festival = useAction();
  const [ops, setOps] = useState<OperationSettings>({ closingMode: "DAY", qrTtlSeconds: 300 });
  const opsAction = useAction();

  useEffect(() => {
    api<{ currency: CurrencySettings }>("/admin/settings/currency")
      .then((r) => setC(r.currency))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    api<{ operations: OperationSettings }>("/admin/settings/operations")
      .then((r) => setOps(r.operations))
      .catch(() => undefined);
  }, []);

  const saveOps = (e: FormEvent) => {
    e.preventDefault();
    void opsAction.run(async () => {
      await api("/admin/settings/operations", { method: "PUT", body: ops });
      setSaved("運用設定を保存しました");
    });
  };

  const saveCurrency = (e: FormEvent) => {
    e.preventDefault();
    void currency.run(async () => {
      await api("/admin/settings/currency", { method: "PUT", body: c });
      await refresh();
      setSaved("通貨の表示を保存しました");
    });
  };
  const saveFestival = (e: FormEvent) => {
    e.preventDefault();
    void festival.run(async () => {
      await api("/admin/settings/festival-name", { method: "PUT", body: { name: festivalName } });
      await refresh();
      setSaved("学園祭名を保存しました");
    });
  };

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>通貨の表示</CardTitle>
          <CardDescription>名称を変えても、残高や過去の金額の数値は変わりません。</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={saveCurrency} className="flex flex-col gap-3">
            <Field label="正式名称">
              <Input value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} maxLength={20} required />
            </Field>
            <Field label="短縮名称" hint="金額の横に表示します(例: pt)">
              <Input value={c.shortName} onChange={(e) => setC({ ...c, shortName: e.target.value })} maxLength={8} required />
            </Field>
            <Field label="表示位置">
              <select
                className="h-12 rounded-lg border border-input bg-card px-3 text-base"
                value={c.symbolPosition}
                onChange={(e) => setC({ ...c, symbolPosition: e.target.value as CurrencySettings["symbolPosition"] })}
              >
                <option value="after">数値の後(500pt)</option>
                <option value="before">数値の前(pt500)</option>
              </select>
            </Field>
            <Field label="1単位あたりの円" hint="受付・利用者への案内用。既存の残高は自動で換算されません">
              <Input
                type="number"
                min={0.01}
                step="any"
                value={c.yenPerUnit}
                onChange={(e) => setC({ ...c, yenPerUnit: Number(e.target.value) })}
                required
              />
            </Field>
            <Field label="説明文">
              <Input value={c.description} onChange={(e) => setC({ ...c, description: e.target.value })} maxLength={200} />
            </Field>
            <p className="rounded-lg bg-muted px-3 py-2 text-sm">表示例: {formatMoney(500, c)}</p>
            <ErrorText message={currency.error} />
            <Button type="submit" disabled={currency.pending}>
              保存
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card className="h-fit">
        <CardHeader>
          <CardTitle>運用設定</CardTitle>
          <CardDescription>現金の締め方と、お客様の提示用QRの有効時間です。</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={saveOps} className="flex flex-col gap-3">
            <Field label="現金の締めの単位">
              <select
                className="h-12 rounded-lg border border-input bg-card px-3 text-base"
                value={ops.closingMode}
                onChange={(e) => setOps({ ...ops, closingMode: e.target.value as OperationSettings["closingMode"] })}
              >
                <option value="DAY">日次(全受付をまとめて管理者が締める)</option>
                <option value="SHIFT">担当者交代ごと(受付が自分で締める)</option>
                <option value="MANUAL">手動(管理者が必要なときに締める)</option>
              </select>
            </Field>
            <Field label="提示用QRの有効時間(秒)" hint="60〜1800秒。既定は300秒(5分)">
              <Input type="number" min={60} max={1800} value={ops.qrTtlSeconds} onChange={(e) => setOps({ ...ops, qrTtlSeconds: Number(e.target.value) })} required />
            </Field>
            <ErrorText message={opsAction.error} />
            <Button type="submit" disabled={opsAction.pending}>
              保存
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card className="h-fit">
        <CardHeader>
          <CardTitle>学園祭名</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={saveFestival} className="flex flex-col gap-3">
            <Field label="名称">
              <Input value={festivalName} onChange={(e) => setFestivalName(e.target.value)} maxLength={50} required />
            </Field>
            <ErrorText message={festival.error} />
            <Button type="submit" disabled={festival.pending}>
              保存
            </Button>
          </form>
          {saved && <p className="mt-3 text-sm font-medium text-secondary-foreground">{saved}</p>}
        </CardContent>
      </Card>
    </div>
  );
}
