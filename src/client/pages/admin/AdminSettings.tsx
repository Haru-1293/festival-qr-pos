import { useEffect, useState, type FormEvent } from "react";
import type { ExpiryPolicy, OperationSettings } from "@shared/api";
import type { CurrencySettings } from "@shared/currency";
import { formatMoney } from "@shared/currency";
import { ErrorText, Field } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DatePicker } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction } from "@/lib/useAction";
import { useConfirm } from "@/lib/confirm";
import { GlobalExpiryCards } from "./GlobalExpiryCards";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** 緊急停止: お金が動く入口(レジの読み取り・確定、受付のチャージ・払戻し、顧客のQR発行)を止める */
function EmergencyCard() {
  const confirm = useConfirm();
  const { settings, refresh } = useAuth();
  const [message, setMessage] = useState(settings.emergency.message);
  const action = useAction();
  const on = settings.emergency.on;
  const set = async (next: boolean) => {
    if (next && !(await confirm("緊急停止すると、すべてのレジの決済と受付のチャージ・払戻しが止まります。よろしいですか?", { destructive: true }))) return;
    void action.run(async () => {
      await api("/admin/settings/emergency", {
        method: "PUT",
        body: { on: next, message },
      });
      await refresh();
    });
  };
  return (
    <Card className={on ? "border-destructive md:col-span-2" : "md:col-span-2"}>
      <CardHeader>
        <CardTitle>緊急停止</CardTitle>
        <CardDescription>
          障害や不正の疑いがあるときに、お金が動く操作だけを止めます。返金・訂正・途中回収・現金の締めと、この管理画面は使えます。いまは
          {on ? "停止中です" : "通常どおり動いています"}。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Field label="お知らせ(画面とエラーに表示します。任意)">
          <Input value={message} onChange={(e) => setMessage(e.target.value)} maxLength={100} placeholder="システム点検のため" />
        </Field>
        <ErrorText message={action.error} />
        {on ? (
          <div className="flex gap-2">
            <Button className="flex-1" disabled={action.pending} onClick={() => set(false)}>
              停止を解除する
            </Button>
            <Button variant="outline" disabled={action.pending} onClick={() => set(true)}>
              お知らせを更新
            </Button>
          </div>
        ) : (
          <Button variant="destructive" disabled={action.pending} onClick={() => set(true)}>
            緊急停止する
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

export function AdminSettings() {
  const { refresh, settings } = useAuth();
  const [c, setC] = useState<CurrencySettings>(settings.currency);
  const [festivalName, setFestivalName] = useState(settings.festivalName);
  const [saved, setSaved] = useState<string | null>(null);
  const currency = useAction();
  const festival = useAction();
  const [ops, setOps] = useState<OperationSettings>({
    closingMode: "DAY",
    qrTtlSeconds: 300,
    paymentSessionSeconds: 300,
  });
  const opsAction = useAction();
  const [expiry, setExpiry] = useState<ExpiryPolicy>({ mode: "DAYS", days: 180, date: null });
  const expiryAction = useAction();

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

  useEffect(() => {
    api<{ expiry: ExpiryPolicy }>("/admin/settings/expiry")
      .then((r) => setExpiry(r.expiry))
      .catch(() => undefined);
  }, []);

  const saveExpiry = (e: FormEvent) => {
    e.preventDefault();
    void expiryAction.run(async () => {
      await api("/admin/settings/expiry", { method: "PUT", body: expiry });
      setSaved("有効期限の設定を保存しました");
    });
  };

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
      await api("/admin/settings/festival-name", {
        method: "PUT",
        body: { name: festivalName },
      });
      await refresh();
      setSaved("学園祭名を保存しました");
    });
  };

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <EmergencyCard />
      <GlobalExpiryCards />
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
              <Select
                value={c.symbolPosition}
                onValueChange={(v) =>
                  setC({
                    ...c,
                    symbolPosition: v as CurrencySettings["symbolPosition"],
                  })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="after">数値の後(500pt)</SelectItem>
                  <SelectItem value="before">数値の前(pt500)</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="1単位あたりの円" hint="受付・利用者への案内用。既存の残高は自動で換算されません">
              <Input type="number" min={0.01} step="any" value={c.yenPerUnit} onChange={(e) => setC({ ...c, yenPerUnit: Number(e.target.value) })} required />
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
          <CardDescription>現金の締め方と、QR・決済の有効時間です。</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={saveOps} className="flex flex-col gap-3">
            <Field label="現金の締めの単位">
              <Select
                value={ops.closingMode}
                onValueChange={(v) =>
                  setOps({
                    ...ops,
                    closingMode: v as OperationSettings["closingMode"],
                  })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="DAY">日次(全受付をまとめて管理者が締める)</SelectItem>
                  <SelectItem value="SHIFT">担当者交代ごと(受付が自分で締める)</SelectItem>
                  <SelectItem value="MANUAL">手動(管理者が必要なときに締める)</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="提示用QRの有効時間(秒)" hint="60〜1800秒。既定は300秒(5分)">
              <Input type="number" min={60} max={1800} value={ops.qrTtlSeconds} onChange={(e) => setOps({ ...ops, qrTtlSeconds: Number(e.target.value) })} required />
            </Field>
            <Field label="決済セッションの有効時間(秒)" hint="お客様のQRを読み取ってから支払いを確定するまでの猶予。60〜1800秒。既定は300秒(5分)">
              <Input
                type="number"
                min={60}
                max={1800}
                value={ops.paymentSessionSeconds}
                onChange={(e) =>
                  setOps({
                    ...ops,
                    paymentSessionSeconds: Number(e.target.value),
                  })
                }
                required
              />
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
          <CardTitle>有効期限</CardTitle>
          <CardDescription>
            新しく発行するカードと、新規登録するお客様のウォレットの有効期限です。発行済みのものは変わりません。前払式支払手段の特例により、今日から184日(6か月)以内に限ります。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={saveExpiry} className="flex flex-col gap-3">
            <Field label="決め方">
              <Select value={expiry.mode} onValueChange={(v) => setExpiry({ ...expiry, mode: v as ExpiryPolicy["mode"] })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="DAYS">発行・登録から一定の日数</SelectItem>
                  <SelectItem value="DATE">全員同じ日付(固定日)</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            {expiry.mode === "DAYS" ? (
              <Field label="日数" hint="1〜184日。既定は180日">
                <Input type="number" min={1} max={184} value={expiry.days} onChange={(e) => setExpiry({ ...expiry, days: Number(e.target.value) })} required />
              </Field>
            ) : (
              <Field label="有効期限の日付" hint="その日の23:59まで使えます(日本時間)">
                <DatePicker
                  value={expiry.date ?? ""}
                  onChange={(v) => setExpiry({ ...expiry, date: v || null })}
                  min={new Date().toISOString().slice(0, 10)}
                  max={new Date(Date.now() + 184 * 86400000).toISOString().slice(0, 10)}
                />
              </Field>
            )}
            <p className="text-xs text-muted-foreground">期限が切れたウォレットは、支払い・チャージ・QR表示ができなくなります。残りの残高は受付で払戻しできます。</p>
            <ErrorText message={expiryAction.error} />
            <Button type="submit" disabled={expiryAction.pending}>
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
