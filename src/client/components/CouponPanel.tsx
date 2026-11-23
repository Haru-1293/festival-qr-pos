import { Printer, QrCode, Ticket } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import type { CouponDto, CouponInput, DiscountMethod, ItemTarget, ProductDto, SetDto, ShopDto, TagDto } from "@shared/api";
import { QrCodeView } from "@/components/QrCodeView";
import { ErrorText, Field } from "@/components/Shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { DateTimePicker } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction } from "@/lib/useAction";
import { formatDateTime } from "@/lib/utils";

/** クーポンのQRの中身。レジで読み取るとコード入力欄に入る */
export const couponQrValue = (code: string) => `FES1:K:${code}`;

export const STATE_LABEL: Record<string, string> = {
  RUNNING: "有効",
  SCHEDULED: "開始前",
  ENDED: "終了",
  STOPPED: "停止中",
  USED_UP: "上限到達",
};
export const digits = (s: string) => s.replace(/[^0-9]/g, "");
export const toMs = (v: string): number | null => {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
};
export const num = (s: string): number | null => (s === "" ? null : Number(s));

/** 共通の割引設定フォーム(全ユーザー割引・クーポンで共有) */
export interface RuleForm {
  name: string;
  method: DiscountMethod;
  value: string;
  min: string;
  max: string;
  startsAt: string;
  endsAt: string;
  shopIds: string[];
  items: ItemTarget[];
}
export const emptyRule = (name: string): RuleForm => ({
  name,
  method: "PERCENT",
  value: "10",
  min: "",
  max: "",
  startsAt: "",
  endsAt: "",
  shopIds: [],
  items: [],
});

/** 割引の対象を、商品・タグ・セットで絞る(店舗を1つに決めたときだけ選べる)。何も選ばなければ、割引対象の全商品 */
function ItemTargetPicker({ shopId, value, onChange }: { shopId: string | null; value: ItemTarget[]; onChange: (v: ItemTarget[]) => void }) {
  const [products, setProducts] = useState<ProductDto[]>([]);
  const [tags, setTags] = useState<TagDto[]>([]);
  const [sets, setSets] = useState<SetDto[]>([]);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setProducts([]);
    setTags([]);
    setSets([]);
    setErr(null);
    if (!shopId) return;
    Promise.all([api<{ products: ProductDto[] }>(`/catalog/${shopId}/products`), api<{ tags: TagDto[] }>(`/catalog/${shopId}/tags`), api<{ sets: SetDto[] }>(`/catalog/${shopId}/sets`)])
      .then(([p, t, st]) => {
        setProducts(p.products.filter((x) => x.status !== "ARCHIVED"));
        setTags(t.tags.filter((x) => x.active));
        setSets(st.sets.filter((x) => x.status !== "ARCHIVED"));
      })
      .catch(() => setErr("商品の一覧を読み込めませんでした"));
  }, [shopId]);
  if (!shopId) return <p className="text-xs text-muted-foreground">特定の商品・タグ・セットだけを対象にするには、対象の店舗を1つだけ選んでください(選ばなければ割引対象の全商品が対象です)。</p>;
  const has = (type: ItemTarget["type"], id: string) => value.some((v) => v.type === type && v.id === id);
  const toggle = (type: ItemTarget["type"], id: string) => onChange(has(type, id) ? value.filter((v) => !(v.type === type && v.id === id)) : [...value, { type, id }]);
  const group = (title: string, type: ItemTarget["type"], list: { id: string; name: string }[]) =>
    list.length === 0 ? null : (
      <div className="flex flex-col gap-1.5">
        <p className="text-xs font-semibold text-muted-foreground">{title}</p>
        <div className="flex flex-wrap gap-2">
          {list.map((x) => (
            <label
              key={x.id}
              className={`flex h-9 cursor-pointer items-center gap-2 rounded-full border px-3 text-sm font-semibold ${has(type, x.id) ? "border-primary bg-secondary" : "border-input bg-card"}`}
            >
              <Checkbox className="size-4" checked={has(type, x.id)} onCheckedChange={() => toggle(type, x.id)} />
              {x.name}
            </label>
          ))}
        </div>
      </div>
    );
  return (
    <Field label="対象の商品・タグ・セット(任意)" hint={value.length === 0 ? "選ばなければ、割引対象の全商品が対象です" : `${value.length}件を選択中。選んだものだけが割引されます`}>
      <div className="flex flex-col gap-3 rounded-xl border border-border p-3">
        {err && <ErrorText message={err} />}
        {group("タグ", "TAG", tags)}
        {group("商品", "PRODUCT", products)}
        {group("セット", "SET", sets)}
        {!err && products.length + tags.length + sets.length === 0 && <p className="text-sm text-muted-foreground">この店舗にはまだ商品がありません</p>}
      </div>
    </Field>
  );
}

export function RuleFields({ f, set, shops, fixedShop }: { f: RuleForm; set: (p: Partial<RuleForm>) => void; shops: ShopDto[]; fixedShop?: ShopDto }) {
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
      {fixedShop ? (
        <p className="rounded-lg bg-secondary px-3 py-2 text-sm font-semibold">対象の店舗: {fixedShop.displayName}(この店舗だけで使えます)</p>
      ) : (
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
                      items: [],
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
      )}
      <ItemTargetPicker shopId={fixedShop?.id ?? (f.shopIds.length === 1 ? f.shopIds[0] : null)} value={f.items} onChange={(items) => set({ items })} />
      <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
        「値下げ対象外」の商品と、セットの追加料金は割引されません。割引は店舗の値下げ後の価格に対して、全ユーザー割引 → クーポンの順に計算します。
      </p>
    </>
  );
}

export const ruleBody = (f: RuleForm) => ({
  name: f.name,
  method: f.method,
  value: Number(f.value || 0),
  minOrderAmount: num(f.min),
  maxDiscountAmount: num(f.max),
  startsAt: toMs(f.startsAt),
  endsAt: toMs(f.endsAt),
  shopIds: f.shopIds,
  items: f.items,
});

type Kind = "COMMON" | "ONE_TIME" | "FIRST_COME";

/** クーポンのQR(と、コード)を並べた表示・印刷用のシート */
function CouponQrSheet({ codes, title, onClose }: { codes: { code: string; label?: string }[]; title: string; onClose: () => void }) {
  useEffect(() => {
    document.body.classList.add("print-sheet-open");
    return () => document.body.classList.remove("print-sheet-open");
  }, []);
  return createPortal(
    <div className="sheet-host fixed inset-0 z-50 overflow-auto bg-background p-4" role="dialog" aria-label={title}>
      <div className="mx-auto max-w-3xl">
        <div className="mb-3 flex flex-col gap-2 print:hidden">
          <p className="text-lg font-bold">
            {title}({codes.length}件)
          </p>
          <p className="text-sm text-muted-foreground">お客様がこのQRを提示したら、レジの「クーポン」欄でQRを読み取ります。コードを手入力することもできます。</p>
          <div className="flex gap-2">
            <Button onClick={() => window.print()}>
              <Printer /> 印刷する
            </Button>
            <Button variant="outline" onClick={onClose}>
              閉じる
            </Button>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 print:grid-cols-3">
          {codes.map((c) => (
            <div key={c.code} className="flex break-inside-avoid flex-col items-center gap-1 rounded-xl border border-border bg-white p-3 text-black">
              <QrCodeView value={couponQrValue(c.code)} size={150} />
              <p className="font-mono text-lg font-extrabold tracking-wider">{c.code}</p>
              {c.label && <p className="text-center text-xs">{c.label}</p>}
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** クーポンを作るフォーム。全体管理者は対象の店舗を選べて、店舗責任者(fixedShop)は自店舗に固定される */
export function CouponForm({
  shops,
  fixedShop,
  create,
  onCreated,
}: {
  shops: ShopDto[];
  fixedShop?: ShopDto;
  create: (body: CouponInput) => Promise<string[]>;
  onCreated: () => Promise<void> | void;
}) {
  const [cf, setCf] = useState<RuleForm>(emptyRule("クーポン"));
  const [kind, setKind] = useState<Kind>("COMMON");
  const [code, setCode] = useState("");
  const [count, setCount] = useState("10");
  const [totalLimit, setTotalLimit] = useState("");
  const [firstN, setFirstN] = useState("20");
  const [perWallet, setPerWallet] = useState("1");
  const [cCombine, setCCombine] = useState(true);
  const [note, setNote] = useState("");
  const [made, setMade] = useState<string[] | null>(null);
  const [sheet, setSheet] = useState(false);
  const act = useAction();
  const oneTime = kind === "ONE_TIME";

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setMade(null);
    void act.run(async () => {
      const body: CouponInput = {
        ...ruleBody(cf),
        kind: oneTime ? "ONE_TIME" : "COMMON",
        firstCome: kind === "FIRST_COME" ? true : undefined,
        code: code || undefined,
        count: oneTime && !code ? Number(count || 1) : undefined,
        totalLimit: oneTime ? 1 : kind === "FIRST_COME" ? num(firstN) : num(totalLimit),
        perWalletLimit: kind === "COMMON" ? num(perWallet) : null,
        combinableWithAuto: cCombine,
        note: note || null,
      };
      setMade(await create(body));
      setCode("");
      await onCreated();
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Ticket className="size-5" /> クーポンを作る
        </CardTitle>
        <CardDescription>お客様がQRまたはコードを提示し、レジで店員が読み取り・入力します。ウォレットやカードには紐づきません。</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <Field label="種類">
            <Select value={kind} onValueChange={(v) => setKind(v as Kind)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="COMMON">共通コード(みんなが同じコードを使う)</SelectItem>
                <SelectItem value="FIRST_COME">先着N人(N人が使うと終了・1人1回)</SelectItem>
                <SelectItem value="ONE_TIME">使い捨てコード(1回使うと無効)</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <RuleFields f={cf} set={(p) => setCf({ ...cf, ...p })} shops={shops} fixedShop={fixedShop} />
          <Field label={oneTime ? "コード(空欄なら自動で作ります)" : "コード(英数字・ハイフン)"}>
            <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={24} required={!oneTime} placeholder="SPRING100" autoCapitalize="characters" />
          </Field>
          {oneTime && !code && (
            <Field label="作る枚数(最大100)">
              <Input inputMode="numeric" value={count} onChange={(e) => setCount(digits(e.target.value))} />
            </Field>
          )}
          {kind === "FIRST_COME" && (
            <Field label="先着の人数" hint="この人数が使い終わると、このクーポンは使えなくなります(1人1回)">
              <Input inputMode="numeric" value={firstN} onChange={(e) => setFirstN(digits(e.target.value))} required className="h-12 text-lg font-bold" />
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
          <ErrorText message={act.error} />
          {made && (
            <div className="rounded-lg bg-secondary px-3 py-2 text-sm">
              <p className="font-semibold">作成しました({made.length}件)</p>
              <p className="mt-1 break-all font-mono text-xs">{made.join("  ")}</p>
              <Button type="button" size="sm" variant="outline" className="mt-2" onClick={() => setSheet(true)}>
                <QrCode /> QRを表示・印刷
              </Button>
            </div>
          )}
          <Button type="submit" disabled={act.pending || !cf.value}>
            {act.pending ? "作成中…" : "クーポンを作る"}
          </Button>
        </form>
        {sheet && made && <CouponQrSheet codes={made.map((c) => ({ code: c, label: cf.name }))} title="クーポンのQR" onClose={() => setSheet(false)} />}
      </CardContent>
    </Card>
  );
}

const describe = (r: { method: DiscountMethod; value: number; minOrderAmount: number | null; maxDiscountAmount: number | null }, money: (n: number) => string) =>
  `${r.method === "PERCENT" ? `${r.value}%引き` : `${money(r.value)}引き`}${r.minOrderAmount ? ` ・ ${money(r.minOrderAmount)}以上` : ""}${r.maxDiscountAmount ? ` ・ 最大${money(r.maxDiscountAmount)}` : ""}`;

/** クーポンの一覧(停止・再開、QRの表示) */
export function CouponList({
  coupons,
  shops,
  setStatus,
  onChanged,
  title = "クーポンの一覧",
  showShops = true,
}: {
  coupons: CouponDto[];
  shops: ShopDto[];
  setStatus: (id: string, status: "ACTIVE" | "STOPPED") => Promise<void>;
  onChanged: () => Promise<void> | void;
  title?: string;
  showShops?: boolean;
}) {
  const { money } = useAuth();
  const row = useAction();
  const [qr, setQr] = useState<string | null>(null);
  const shopNames = (ids: string[]) => (ids.length === 0 ? "全店舗" : ids.map((i) => shops.find((s) => s.id === i)?.displayName ?? "?").join("、"));
  const period = (r: { startsAt: number | null; endsAt: number | null }) => `${r.startsAt ? formatDateTime(r.startsAt) : "すぐ"} 〜 ${r.endsAt ? formatDateTime(r.endsAt) : "止めるまで"}`;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col divide-y divide-border">
        <ErrorText message={row.error} />
        {coupons.length === 0 && <p className="py-2 text-sm text-muted-foreground">まだありません</p>}
        {coupons.map((c) => (
          <div key={c.id} className="flex flex-col gap-1 py-3 text-sm">
            <div className="flex items-center justify-between gap-2">
              <p className="font-mono font-bold">{c.code}</p>
              <Badge variant={c.state === "RUNNING" ? "destructive" : "muted"}>{STATE_LABEL[c.state]}</Badge>
            </div>
            <p>
              {c.name}:{describe(c, money)}
            </p>
            {c.items.length > 0 && (
              <p className="text-xs font-semibold text-primary">対象: {c.items.map((i) => (i.type === "TAG" ? `タグ「${i.name}」` : i.type === "SET" ? `セット「${i.name}」` : i.name)).join("、")}</p>
            )}
            <p className="text-xs text-muted-foreground">
              {c.firstCome ? "先着" : c.kind === "COMMON" ? "共通" : "使い捨て"} ・ {showShops ? `${shopNames(c.shopIds)} ・ ` : ""}
              {period(c)} ・{" "}
              {c.firstCome && c.totalLimit !== null
                ? `先着 ${c.usedCount} / ${c.totalLimit}人(残り${Math.max(0, c.totalLimit - c.usedCount)}人)`
                : `使用 ${c.usedCount}${c.totalLimit !== null ? ` / ${c.totalLimit}` : ""}回`}
              {!c.firstCome && c.perWalletLimit !== null ? ` ・ 1人${c.perWalletLimit}回まで` : ""} ・ {c.combinableWithAuto ? "全ユーザー割引と併用可" : "併用不可"}
              {c.note ? ` ・ ${c.note}` : ""}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => setQr(qr === c.id ? null : c.id)} aria-expanded={qr === c.id}>
                <QrCode /> QR
              </Button>
              {c.status !== "ENDED" && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={row.pending}
                  onClick={() =>
                    void row.run(async () => {
                      await setStatus(c.id, c.status === "ACTIVE" ? "STOPPED" : "ACTIVE");
                      await onChanged();
                    })
                  }
                >
                  {c.status === "ACTIVE" ? "停止する" : "再開する"}
                </Button>
              )}
            </div>
            {qr === c.id && (
              <div className="flex flex-col items-center gap-1 rounded-xl border border-border bg-white p-3 text-black">
                <QrCodeView value={couponQrValue(c.code)} size={180} />
                <p className="font-mono text-lg font-extrabold tracking-wider">{c.code}</p>
              </div>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
