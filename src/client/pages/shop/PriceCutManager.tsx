import { Tag } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { PriceCutDto, PriceCutState } from "@shared/api";
import type { PriceCutMethod } from "@shared/pricing";
import { cutAmount } from "@shared/pricing";
import { ErrorText, Field } from "@/components/Shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction } from "@/lib/useAction";
import { formatDateTime } from "@/lib/utils";
import { useConfirm } from "@/lib/confirm";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DateTimePicker } from "@/components/ui/date-picker";

const STATE_LABEL: Record<PriceCutState, string> = {
  RUNNING: "実施中",
  SCHEDULED: "開始前",
  ENDED: "終了",
  STOPPED: "停止済み",
};
const digits = (s: string) => s.replace(/[^0-9]/g, "");

/** `datetime-local` の値(端末の現地時刻)をミリ秒へ。空なら null */
function toMs(v: string): number | null {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
}

/** 店舗責任者による「定価の一律値下げ」(タイムセールなど)。設定するとレジ画面へすぐ反映される */
export function PriceCutManager({ shopId }: { shopId: string }) {
  const confirm = useConfirm();
  const { money } = useAuth();
  const [cuts, setCuts] = useState<PriceCutDto[]>([]);
  const [name, setName] = useState("タイムセール");
  const [method, setMethod] = useState<PriceCutMethod>("PERCENT");
  const [value, setValue] = useState("10");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const create = useAction();
  const stop = useAction();

  const load = useCallback(async () => {
    setCuts((await api<{ cuts: PriceCutDto[] }>(`/catalog/${shopId}/price-cuts`)).cuts);
  }, [shopId]);
  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  const active = cuts.find((c) => c.state === "RUNNING" || c.state === "SCHEDULED") ?? null;
  const v = Number(value || 0);
  const example = cutAmount(150, { method, value: v });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void create.run(async () => {
      await api(`/catalog/${shopId}/price-cuts`, {
        body: {
          name,
          method,
          value: v,
          startsAt: toMs(startsAt),
          endsAt: toMs(endsAt),
        },
      });
      setStartsAt("");
      setEndsAt("");
      await load();
    });
  };

  const stopCut = async (c: PriceCutDto) => {
    if (!(await confirm(`「${c.name}」を止めますか?\n価格はすぐに元へ戻ります。`, { destructive: true }))) return;
    void stop.run(async () => {
      await api(`/catalog/${shopId}/price-cuts/${c.id}/stop`, { body: {} });
      await load();
    });
  };

  const desc = (c: PriceCutDto) => (c.method === "PERCENT" ? `${c.value}%引き` : `${money(c.value)}引き`);
  const period = (c: PriceCutDto) => `${c.startsAt ? formatDateTime(c.startsAt) : "設定した時点"} 〜 ${c.endsAt ? formatDateTime(c.endsAt) : "手動で止めるまで"}`;

  return (
    <div className="flex flex-col gap-4">
      {active ? (
        <Card className="overflow-hidden">
          <div className="bg-red-50 px-4 py-4">
            <p className="flex items-center gap-1.5 text-sm font-bold text-red-700">
              <Tag className="size-4" /> {STATE_LABEL[active.state]}
            </p>
            <p className="mt-1 text-2xl font-extrabold">
              {active.name}:{desc(active)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">{period(active)}</p>
          </div>
          <CardContent className="pt-3">
            <ErrorText message={stop.error} />
            <Button variant="outline" onClick={() => stopCut(active)} disabled={stop.pending}>
              この値下げを止める
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>値下げを設定</CardTitle>
            <CardDescription>自店舗の商品の定価を一律に下げます。設定するとレジ画面にすぐ反映されます。</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={submit} className="flex flex-col gap-3">
              <Field label="名前(レジに表示されます)">
                <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required />
              </Field>
              <Field label="下げ方">
                <Select value={method} onValueChange={(v) => setMethod(v as PriceCutMethod)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PERCENT">割合(○%引き)</SelectItem>
                    <SelectItem value="FIXED">金額(1点につき○引き)</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label={method === "PERCENT" ? "割合(%)" : "1点あたりの値下げ額"} hint={`例: 150の商品は ${money(150 - example)} になります`}>
                <Input inputMode="numeric" value={value} onChange={(e) => setValue(digits(e.target.value))} required className="h-12 text-lg font-bold" />
              </Field>
              <Field label="開始(空欄なら設定した時点から)">
                <DateTimePicker value={startsAt} onChange={setStartsAt} />
              </Field>
              <Field label="終了(空欄なら手動で止めるまで)">
                <DateTimePicker value={endsAt} onChange={setEndsAt} />
              </Field>
              <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
                「値下げ対象外」にした商品は下がりません。端数は値下げ額を切り捨てます。全体管理者の割引・クーポンとは併用でき、値下げ後の価格に適用されます。
              </p>
              <ErrorText message={create.error} />
              <Button type="submit" size="lg" disabled={create.pending || v < 1}>
                {create.pending ? "設定中…" : "値下げを開始する"}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>履歴</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col divide-y divide-border">
          {cuts.length === 0 && <p className="py-2 text-sm text-muted-foreground">まだ値下げの設定がありません</p>}
          {cuts.map((c) => (
            <div key={c.id} className="flex flex-col gap-0.5 py-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <p className="font-semibold">
                  {c.name}:{desc(c)}
                </p>
                <Badge variant={c.state === "RUNNING" ? "destructive" : "muted"}>{STATE_LABEL[c.state]}</Badge>
              </div>
              <p className="text-xs text-muted-foreground">{period(c)}</p>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
