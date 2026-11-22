import { Percent, Ticket } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { AutoDiscountDto, AutoDiscountInput, CouponDto, CouponInput, DiscountMethod, ShopDto } from "@shared/api";
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
import { Checkbox } from "@/components/ui/checkbox";
import { DateTimePicker } from "@/components/ui/date-picker";

const STATE_LABEL: Record<string, string> = {
  RUNNING: "有効",
  SCHEDULED: "開始前",
  ENDED: "終了",
  STOPPED: "停止中",
  USED_UP: "上限到達",
};
const digits = (s: string) => s.replace(/[^0-9]/g, "");
const toMs = (v: string): number | null => {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
};
const num = (s: string): number | null => (s === "" ? null : Number(s));

/** 共通の割引設定フォーム(全ユーザー割引・クーポンで共有) */
interface RuleForm {
  name: string;
  method: DiscountMethod;
  value: string;
  min: string;
  max: string;
  startsAt: string;
  endsAt: string;
  shopIds: string[];
}
const emptyRule = (name: string): RuleForm => ({
  name,
  method: "PERCENT",
  value: "10",
  min: "",
  max: "",
  startsAt: "",
  endsAt: "",
  shopIds: [],
});

function RuleFields({ f, set, shops }: { f: RuleForm; set: (p: Partial<RuleForm>) => void; shops: ShopDto[] }) {
  return (
    <>
      <Field label="名前(お客様の確認画面に表示されます)">
        <Input value={f.name} onChange={(e) => set({ name: e.target.value })} maxLength={40} required />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="割引のしかた">
          <Select value={f.method} onValueChange={(v) => set({ method: v as DiscountMethod })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="PERCENT">割合(○%引き)</SelectItem>
              <SelectItem value="FIXED">金額(○引き)</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label={f.method === "PERCENT" ? "割合(%)" : "割引額"}>
          <Input inputMode="numeric" value={f.value} onChange={(e) => set({ value: digits(e.target.value) })} required className="h-12 text-lg font-bold" />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="最低注文金額(空欄=なし)">
          <Input inputMode="numeric" value={f.min} onChange={(e) => set({ min: digits(e.target.value) })} />
        </Field>
        <Field label="最大割引額(空欄=なし)">
          <Input inputMode="numeric" value={f.max} onChange={(e) => set({ max: digits(e.target.value) })} />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="開始(空欄=すぐ)">
          <DateTimePicker value={f.startsAt} onChange={(v) => set({ startsAt: v })} />
        </Field>
        <Field label="終了(空欄=止めるまで)">
          <DateTimePicker value={f.endsAt} onChange={(v) => set({ endsAt: v })} />
        </Field>
      </div>
      <Field label="対象の店舗" hint="選ばなければ全店舗が対象です">
        <div className="flex flex-wrap gap-2">
          {shops.map((s) => {
            const on = f.shopIds.includes(s.id);
            return (
              <button
                type="button"
                key={s.id}
                aria-pressed={on}
                onClick={() =>
                  set({
                    shopIds: on ? f.shopIds.filter((x) => x !== s.id) : [...f.shopIds, s.id],
                  })
                }
                className={`h-9 rounded-full border px-3 text-sm font-semibold ${on ? "border-primary bg-primary text-primary-foreground" : "border-input bg-card"}`}
              >
                {s.displayName}
              </button>
            );
          })}
        </div>
      </Field>
      <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
        「値下げ対象外」の商品と、セットの追加料金は割引されません。割引は店舗の値下げ後の価格に対して、全ユーザー割引 → クーポンの順に計算します。
      </p>
    </>
  );
}

const ruleBody = (f: RuleForm) => ({
  name: f.name,
  method: f.method,
  value: Number(f.value || 0),
  minOrderAmount: num(f.min),
  maxDiscountAmount: num(f.max),
  startsAt: toMs(f.startsAt),
  endsAt: toMs(f.endsAt),
  shopIds: f.shopIds,
});

/** 全体管理者の「割引・クーポン」管理(仕様 v0.2 §14) */
export function DiscountManager() {
  const confirm = useConfirm();
  const { money } = useAuth();
  const [autos, setAutos] = useState<AutoDiscountDto[]>([]);
  const [coupons, setCoupons] = useState<CouponDto[]>([]);
  const [shops, setShops] = useState<ShopDto[]>([]);
  const [af, setAf] = useState<RuleForm>(emptyRule("全品10%引き"));
  const [aCombine, setACombine] = useState(true);
  const [cf, setCf] = useState<RuleForm>(emptyRule("クーポン"));
  const [kind, setKind] = useState<"COMMON" | "ONE_TIME">("COMMON");
  const [code, setCode] = useState("");
  const [count, setCount] = useState("10");
  const [totalLimit, setTotalLimit] = useState("");
  const [perWallet, setPerWallet] = useState("1");
  const [cCombine, setCCombine] = useState(true);
  const [note, setNote] = useState("");
  const [made, setMade] = useState<string[] | null>(null);
  const createAuto = useAction();
  const createCoupon = useAction();
  const row = useAction();

  const load = useCallback(async () => {
    const [d, s] = await Promise.all([api<{ autos: AutoDiscountDto[]; coupons: CouponDto[] }>("/discounts"), api<{ shops: ShopDto[] }>("/admin/shops")]);
    setAutos(d.autos);
    setCoupons(d.coupons);
    setShops(s.shops);
  }, []);
  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  const shopNames = (ids: string[]) => (ids.length === 0 ? "全店舗" : ids.map((i) => shops.find((s) => s.id === i)?.displayName ?? "?").join("、"));
  const desc = (r: { method: DiscountMethod; value: number; minOrderAmount: number | null; maxDiscountAmount: number | null }) =>
    `${r.method === "PERCENT" ? `${r.value}%引き` : `${money(r.value)}引き`}${r.minOrderAmount ? ` ・ ${money(r.minOrderAmount)}以上` : ""}${r.maxDiscountAmount ? ` ・ 最大${money(r.maxDiscountAmount)}` : ""}`;
  const period = (r: { startsAt: number | null; endsAt: number | null }) => `${r.startsAt ? formatDateTime(r.startsAt) : "すぐ"} 〜 ${r.endsAt ? formatDateTime(r.endsAt) : "止めるまで"}`;

  const submitAuto = (e: FormEvent) => {
    e.preventDefault();
    void createAuto.run(async () => {
      const body: AutoDiscountInput = {
        ...ruleBody(af),
        combinableWithCoupon: aCombine,
      };
      await api("/discounts/auto", { body });
      await load();
    });
  };
  const submitCoupon = (e: FormEvent) => {
    e.preventDefault();
    setMade(null);
    void createCoupon.run(async () => {
      const body: CouponInput = {
        ...ruleBody(cf),
        kind,
        code: code || undefined,
        count: kind === "ONE_TIME" && !code ? Number(count || 1) : undefined,
        totalLimit: kind === "COMMON" ? num(totalLimit) : 1,
        perWalletLimit: kind === "COMMON" ? num(perWallet) : null,
        combinableWithAuto: cCombine,
        note: note || null,
      };
      const r = await api<{ codes: string[] }>("/discounts/coupons", { body });
      setMade(r.codes);
      setCode("");
      await load();
    });
  };
  const setAutoStatus = async (a: AutoDiscountDto, status: "ACTIVE" | "STOPPED") => {
    if (status === "STOPPED" && !(await confirm(`「${a.name}」を停止しますか?\nレジの会計からすぐに外れます。`, { destructive: true }))) return;
    void row.run(async () => {
      await api(`/discounts/auto/${a.id}/status`, { body: { status } });
      await load();
    });
  };
  const setCouponStatus = (c: CouponDto, status: "ACTIVE" | "STOPPED") => {
    void row.run(async () => {
      await api(`/discounts/coupons/${c.id}/status`, { body: { status } });
      await load();
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Percent className="size-5" /> 全ユーザー対象割引
            </CardTitle>
            <CardDescription>条件を満たす会計に自動で適用されます(コード入力は不要)。</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={submitAuto} className="flex flex-col gap-3">
              <RuleFields f={af} set={(p) => setAf({ ...af, ...p })} shops={shops} />
              <label className="flex items-center gap-2 text-sm">
                <Checkbox className="size-4" checked={aCombine} onCheckedChange={(c) => setACombine(c === true)} />
                クーポンと併用できる
              </label>
              <ErrorText message={createAuto.error} />
              <Button type="submit" disabled={createAuto.pending || !af.value}>
                {createAuto.pending ? "作成中…" : "割引を開始する"}
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Ticket className="size-5" /> クーポンを作る
            </CardTitle>
            <CardDescription>お客様が提示したコードを、レジで店員が入力します。ウォレットやカードには紐づきません。</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={submitCoupon} className="flex flex-col gap-3">
              <Field label="種類">
                <Select value={kind} onValueChange={(v) => setKind(v as "COMMON" | "ONE_TIME")}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="COMMON">共通コード(みんなが同じコードを使う)</SelectItem>
                    <SelectItem value="ONE_TIME">使い捨てコード(1回使うと無効)</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <RuleFields f={cf} set={(p) => setCf({ ...cf, ...p })} shops={shops} />
              <Field label={kind === "COMMON" ? "コード(英数字・ハイフン)" : "コード(空欄なら自動で作ります)"}>
                <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={24} required={kind === "COMMON"} placeholder="SPRING100" autoCapitalize="characters" />
              </Field>
              {kind === "ONE_TIME" && !code && (
                <Field label="作る枚数(最大100)">
                  <Input inputMode="numeric" value={count} onChange={(e) => setCount(digits(e.target.value))} />
                </Field>
              )}
              {kind === "COMMON" && (
                <div className="grid grid-cols-2 gap-3">
                  <Field label="全体の利用上限(空欄=なし)">
                    <Input inputMode="numeric" value={totalLimit} onChange={(e) => setTotalLimit(digits(e.target.value))} />
                  </Field>
                  <Field label="1人あたりの上限(空欄=なし)">
                    <Input inputMode="numeric" value={perWallet} onChange={(e) => setPerWallet(digits(e.target.value))} />
                  </Field>
                </div>
              )}
              <Field label="メモ(任意)">
                <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={100} />
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox className="size-4" checked={cCombine} onCheckedChange={(c) => setCCombine(c === true)} />
                全ユーザー割引と併用できる
              </label>
              <ErrorText message={createCoupon.error} />
              {made && (
                <div className="rounded-lg bg-secondary px-3 py-2 text-sm">
                  <p className="font-semibold">作成しました({made.length}件)</p>
                  <p className="mt-1 break-all font-mono text-xs">{made.join("  ")}</p>
                </div>
              )}
              <Button type="submit" disabled={createCoupon.pending || !cf.value}>
                {createCoupon.pending ? "作成中…" : "クーポンを作る"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>全ユーザー対象割引の一覧</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col divide-y divide-border">
          <ErrorText message={row.error} />
          {autos.length === 0 && <p className="py-2 text-sm text-muted-foreground">まだありません</p>}
          {autos.map((a) => (
            <div key={a.id} className="flex flex-col gap-1 py-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <p className="font-semibold">
                  {a.name}:{desc(a)}
                </p>
                <Badge variant={a.state === "RUNNING" ? "destructive" : "muted"}>{STATE_LABEL[a.state]}</Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                {shopNames(a.shopIds)} ・ {period(a)} ・ {a.combinableWithCoupon ? "クーポン併用可" : "クーポン併用不可"} ・ 利用 {a.usedCount}回 / 計 {money(a.usedAmount)}
              </p>
              {a.status !== "ENDED" && (
                <Button size="sm" variant="outline" className="self-start" disabled={row.pending} onClick={() => setAutoStatus(a, a.status === "ACTIVE" ? "STOPPED" : "ACTIVE")}>
                  {a.status === "ACTIVE" ? "停止する" : "再開する"}
                </Button>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>クーポンの一覧</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col divide-y divide-border">
          {coupons.length === 0 && <p className="py-2 text-sm text-muted-foreground">まだありません</p>}
          {coupons.map((c) => (
            <div key={c.id} className="flex flex-col gap-1 py-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <p className="font-mono font-bold">{c.code}</p>
                <Badge variant={c.state === "RUNNING" ? "destructive" : "muted"}>{STATE_LABEL[c.state]}</Badge>
              </div>
              <p>
                {c.name}:{desc(c)}
              </p>
              <p className="text-xs text-muted-foreground">
                {c.kind === "COMMON" ? "共通" : "使い捨て"} ・ {shopNames(c.shopIds)} ・ {period(c)} ・ 使用 {c.usedCount}
                {c.totalLimit !== null ? ` / ${c.totalLimit}` : ""}回{c.perWalletLimit !== null ? ` ・ 1人${c.perWalletLimit}回まで` : ""} ・{" "}
                {c.combinableWithAuto ? "全ユーザー割引と併用可" : "併用不可"}
                {c.note ? ` ・ ${c.note}` : ""}
              </p>
              {c.status !== "ENDED" && (
                <Button size="sm" variant="outline" className="self-start" disabled={row.pending} onClick={() => setCouponStatus(c, c.status === "ACTIVE" ? "STOPPED" : "ACTIVE")}>
                  {c.status === "ACTIVE" ? "停止する" : "再開する"}
                </Button>
              )}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
