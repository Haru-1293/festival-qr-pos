import { ChevronDown, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { ApplyScope, ConditionMode, DiscountConditionDto, ItemTarget, ProductDto, SetDto, TagDto } from "@shared/api";
import { Field } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

/** 商品の個数の条件(フォーム上の形。qty は入力中の文字) */
export interface CondForm {
  type: ItemTarget["type"];
  id: string;
  qty: string;
}
export interface AdvancedForm {
  conditions: CondForm[];
  condMode: ConditionMode;
  scope: ApplyScope;
}
export const emptyAdvanced = (): AdvancedForm => ({ conditions: [], condMode: "ALL", scope: "DEFAULT" });

/** 送信用に変換(個数が空・不正な行は除く) */
export const advancedBody = (a: AdvancedForm) => ({
  conditions: a.conditions.filter((c) => c.id && Number(c.qty) >= 1).map((c) => ({ type: c.type, id: c.id, minQty: Number(c.qty) })),
  conditionMode: a.condMode,
  applyScope: a.scope,
});

export const SCOPE_LABEL: Record<ApplyScope, string> = {
  DEFAULT: "ふつう(上で対象を選んでいればその商品だけ、選んでいなければ会計全体)",
  ORDER: "会計全体(対象の指定にかかわらず、すべての割引対象の商品)",
  CONDITION: "条件にあたった商品だけ",
};

/** 店舗の商品・タグ・セット(割引の対象や条件の選択肢) */
export function useShopItems(shopId: string | null) {
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
  return { products, tags, sets, err };
}

/** 条件・割引の範囲の説明(一覧に出す文) */
export function describeAdvanced(r: { conditions: DiscountConditionDto[]; conditionMode: ConditionMode; applyScope: ApplyScope; minOrderAmount: number | null }): string[] {
  const out: string[] = [];
  if (r.conditions.length > 0) {
    const parts = r.conditions.map((c) => `${c.type === "TAG" ? `タグ「${c.name}」` : c.type === "SET" ? `セット「${c.name}」` : c.name}を${c.minQty}個以上`);
    const join = r.conditionMode === "ANY" ? "、または" : "、かつ";
    out.push(`条件: ${parts.join(join)}${r.minOrderAmount ? `${join}会計金額が条件の金額以上` : ""}`);
  }
  if (r.applyScope === "ORDER") out.push("会計全体に割引");
  else if (r.applyScope === "CONDITION") out.push("条件にあたった商品だけに割引");
  return out;
}

/**
 * 詳細設定(既定では畳んである)。
 * 発動条件: 会計金額は「最低注文金額」、商品の個数はここで付ける。割引をかける範囲もここで選ぶ。
 */
export function AdvancedRuleSettings({ value, onChange, shopId, hasMinAmount }: { value: AdvancedForm; onChange: (v: AdvancedForm) => void; shopId: string | null; hasMinAmount: boolean }) {
  const [open, setOpen] = useState(false);
  const { products, tags, sets, err } = useShopItems(open ? shopId : null);
  const active = value.conditions.length + (value.scope !== "DEFAULT" ? 1 : 0);
  const options = [
    ...tags.map((t) => ({ key: `TAG:${t.id}`, label: `タグ: ${t.name}` })),
    ...products.map((p) => ({ key: `PRODUCT:${p.id}`, label: `商品: ${p.name}` })),
    ...sets.map((s) => ({ key: `SET:${s.id}`, label: `セット: ${s.name}` })),
  ];
  const setCond = (i: number, p: Partial<CondForm>) => onChange({ ...value, conditions: value.conditions.map((c, j) => (j === i ? { ...c, ...p } : c)) });
  const total = value.conditions.length + (hasMinAmount ? 1 : 0);
  return (
    <div className="rounded-xl border border-border">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex h-11 w-full items-center justify-between gap-2 px-3 text-sm font-semibold"
      >
        <span>
          詳細設定
          {active > 0 && <span className="ml-2 rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">設定あり</span>}
        </span>
        <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="flex flex-col gap-4 border-t border-border p-3">
          <p className="text-xs text-muted-foreground">
            割引が発動する条件と、割引をかける範囲を細かく決めます。会計金額の条件は、上の「最低注文金額」です。
          </p>
          <div className="flex flex-col gap-2">
            <p className="text-sm font-semibold">商品の個数の条件</p>
            {!shopId && <p className="text-xs text-muted-foreground">商品の条件を付けるには、上の「対象の店舗」を1つだけ選んでください。</p>}
            {err && <p className="text-xs text-destructive">{err}</p>}
            {shopId &&
              value.conditions.map((c, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  <Select value={c.id ? `${c.type}:${c.id}` : ""} onValueChange={(v) => setCond(i, { type: v.split(":")[0] as ItemTarget["type"], id: v.split(":")[1] })}>
                    <SelectTrigger className="min-w-0 flex-1 basis-48" aria-label="条件の商品">
                      <SelectValue placeholder="商品・タグ・セットを選ぶ" />
                    </SelectTrigger>
                    <SelectContent>
                      {options.map((o) => (
                        <SelectItem key={o.key} value={o.key}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    inputMode="numeric"
                    value={c.qty}
                    onChange={(e) => setCond(i, { qty: e.target.value.replace(/[^0-9]/g, "").slice(0, 4) })}
                    aria-label="個数"
                    className="w-20 text-center"
                  />
                  <span className="text-sm">個以上</span>
                  <Button type="button" size="icon" variant="ghost" aria-label="条件を消す" onClick={() => onChange({ ...value, conditions: value.conditions.filter((_x, j) => j !== i) })}>
                    <Trash2 />
                  </Button>
                </div>
              ))}
            {shopId && (
              <Button type="button" size="sm" variant="outline" className="self-start" onClick={() => onChange({ ...value, conditions: [...value.conditions, { type: "PRODUCT", id: "", qty: "2" }] })}>
                <Plus /> 条件を追加
              </Button>
            )}
          </div>
          {total >= 2 && (
            <Field label="条件が複数あるとき">
              <Select value={value.condMode} onValueChange={(v) => onChange({ ...value, condMode: v as ConditionMode })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">すべて満たしたとき(会計金額も含む)</SelectItem>
                  <SelectItem value="ANY">どれか1つ満たしたとき(会計金額も含む)</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          )}
          <Field label="割引をかける範囲">
            <Select value={value.scope} onValueChange={(v) => onChange({ ...value, scope: v as ApplyScope })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(SCOPE_LABEL) as ApplyScope[]).map((k) => (
                  <SelectItem key={k} value={k}>
                    {SCOPE_LABEL[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
      )}
    </div>
  );
}
