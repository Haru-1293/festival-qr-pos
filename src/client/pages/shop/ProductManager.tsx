import { Archive, Pencil, Plus, Warehouse } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { PriceCutDto, ProductDto, SaleMode, TagDto } from "@shared/api";
import { PriceView } from "@/components/PriceView";
import { ErrorText, Field } from "@/components/Shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction } from "@/lib/useAction";
import { cn } from "@/lib/utils";
import { useConfirm } from "@/lib/confirm";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";

const MODE_LABEL: Record<SaleMode, string> = {
  BOTH: "単品・セット両方",
  SINGLE_ONLY: "単品のみ",
  SET_ONLY: "セット限定(非売品)",
};

interface Draft {
  id: string | null;
  name: string;
  price: string;
  description: string;
  saleMode: SaleMode;
  discountable: boolean;
  sortOrder: string;
  tagIds: string[];
  trackStock: boolean;
  stockQty: string;
}
const EMPTY: Draft = {
  id: null,
  name: "",
  price: "",
  description: "",
  saleMode: "BOTH",
  discountable: true,
  sortOrder: "0",
  tagIds: [],
  trackStock: false,
  stockQty: "",
};
const digits = (s: string) => s.replace(/[^0-9]/g, "");

/** 店舗責任者の商品管理。登録・編集・タグ・在庫・アーカイブ。変更はレジ画面へすぐ反映される */
export function ProductManager({ shopId }: { shopId: string }) {
  const confirm = useConfirm();
  const { money } = useAuth();
  const [products, setProducts] = useState<ProductDto[]>([]);
  const [tags, setTags] = useState<TagDto[]>([]);
  const [cut, setCut] = useState<PriceCutDto | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [newTag, setNewTag] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const form = useAction();
  const row = useAction();
  const tagAction = useAction();

  const load = useCallback(async () => {
    const [p, t] = await Promise.all([api<{ products: ProductDto[]; cut: PriceCutDto | null }>(`/catalog/${shopId}/products`), api<{ tags: TagDto[] }>(`/catalog/${shopId}/tags`)]);
    setProducts(p.products);
    setCut(p.cut);
    setTags(t.tags);
  }, [shopId]);
  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  const edit = (p: ProductDto) =>
    setDraft({
      id: p.id,
      name: p.name,
      price: p.price === null ? "" : String(p.price),
      description: p.description ?? "",
      saleMode: p.saleMode,
      discountable: p.discountable,
      sortOrder: String(p.sortOrder),
      tagIds: p.tags.map((t) => t.id),
      trackStock: p.trackStock,
      stockQty: p.stockQty === null ? "" : String(p.stockQty),
    });

  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    void form.run(async () => {
      const base = {
        name: draft.name,
        price: draft.price === "" ? null : Number(draft.price),
        description: draft.description || null,
        saleMode: draft.saleMode,
        discountable: draft.discountable,
        sortOrder: Number(draft.sortOrder || 0),
        tagIds: draft.tagIds,
      };
      if (draft.id) {
        await api(`/catalog/${shopId}/products/${draft.id}`, {
          method: "PATCH",
          body: base,
        });
      } else {
        await api(`/catalog/${shopId}/products`, {
          body: {
            ...base,
            trackStock: draft.trackStock,
            stockQty: draft.trackStock ? Number(draft.stockQty || 0) : null,
          },
        });
      }
      setDraft(null);
      await load();
    });
  };

  const adjustStock = (p: ProductDto) => {
    const v = window.prompt(`${p.name} の残数は ${p.stockQty} です。増減を入力してください(例: 追加は 10、廃棄は -3)`);
    if (v === null || v.trim() === "") return;
    const delta = Number(v);
    if (!Number.isInteger(delta) || delta === 0) return void window.alert("0以外の整数で入力してください");
    const note = window.prompt("理由(任意。例: 追加で仕込んだ / 落とした)") ?? undefined;
    void row.run(async () => {
      await api(`/catalog/${shopId}/products/${p.id}/stock`, {
        body: {
          delta,
          reason: delta > 0 ? "RESTOCK" : "DISCARD",
          expectedQty: p.stockQty,
          note: note || undefined,
        },
      });
      await load();
    });
  };

  const setStatus = async (p: ProductDto, status: "ACTIVE" | "STOPPED" | "ARCHIVED") => {
    if (status === "ARCHIVED" && !(await confirm(`${p.name} をアーカイブしますか?\n販売の一覧から外れます(過去の売上の記録は残ります)。`, { destructive: true }))) return;
    void row.run(async () => {
      await api(`/catalog/${shopId}/products/${p.id}`, {
        method: "PATCH",
        body: { status },
      });
      await load();
    });
  };

  const addTag = (e: FormEvent) => {
    e.preventDefault();
    void tagAction.run(async () => {
      await api(`/catalog/${shopId}/tags`, { body: { name: newTag } });
      setNewTag("");
      await load();
    });
  };

  const shown = products.filter((p) => showArchived || p.status !== "ARCHIVED");

  return (
    <div className="flex flex-col gap-4">
      {draft ? (
        <Card>
          <CardHeader>
            <CardTitle>{draft.id ? "商品を編集" : "商品を登録"}</CardTitle>
            {cut && <CardDescription>いま「{cut.name}」の値下げ中です。ここで入力するのは定価です。</CardDescription>}
          </CardHeader>
          <CardContent>
            <form onSubmit={save} className="flex flex-col gap-3">
              <Field label="商品名">
                <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={60} required />
              </Field>
              <Field label="販売形態">
                <Select value={draft.saleMode} onValueChange={(v) => setDraft({ ...draft, saleMode: v as SaleMode })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(MODE_LABEL).map(([k, v]) => (
                      <SelectItem key={k} value={k}>
                        {v}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="定価" hint={draft.saleMode === "SET_ONLY" ? "セット限定は空欄でもかまいません" : undefined}>
                <Input
                  inputMode="numeric"
                  value={draft.price}
                  onChange={(e) => setDraft({ ...draft, price: digits(e.target.value) })}
                  required={draft.saleMode !== "SET_ONLY"}
                  className="h-12 text-lg font-bold"
                />
              </Field>
              <Field label="説明(任意)">
                <Input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} maxLength={300} />
              </Field>
              {tags.filter((t) => t.active).length > 0 && (
                <Field label="タグ">
                  <div className="flex flex-wrap gap-2">
                    {tags
                      .filter((t) => t.active)
                      .map((t) => {
                        const on = draft.tagIds.includes(t.id);
                        return (
                          <button
                            type="button"
                            key={t.id}
                            onClick={() =>
                              setDraft({
                                ...draft,
                                tagIds: on ? draft.tagIds.filter((x) => x !== t.id) : [...draft.tagIds, t.id],
                              })
                            }
                            className={cn("h-9 rounded-full px-4 text-sm font-semibold", on ? "bg-primary text-primary-foreground" : "bg-accent")}
                          >
                            {t.name}
                          </button>
                        );
                      })}
                  </div>
                </Field>
              )}
              {!draft.id && (
                <>
                  <label className="flex items-center gap-2 text-sm font-medium">
                    <Checkbox checked={draft.trackStock} onCheckedChange={(c) => setDraft({ ...draft, trackStock: c === true })} />
                    数量を管理する(売れた数だけ残数が減り、0で自動的に売り切れ)
                  </label>
                  {draft.trackStock && (
                    <Field label="準備数量">
                      <Input
                        inputMode="numeric"
                        value={draft.stockQty}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            stockQty: digits(e.target.value),
                          })
                        }
                        required
                        className="h-12 text-lg font-bold"
                      />
                    </Field>
                  )}
                </>
              )}
              <label className="flex items-center gap-2 text-sm font-medium">
                <Checkbox checked={draft.discountable} onCheckedChange={(c) => setDraft({ ...draft, discountable: c === true })} />
                割引・値下げの対象にする
              </label>
              <Field label="表示順(小さいほど上)">
                <Input inputMode="numeric" value={draft.sortOrder} onChange={(e) => setDraft({ ...draft, sortOrder: digits(e.target.value) })} />
              </Field>
              <ErrorText message={form.error} />
              <div className="flex gap-2">
                <Button type="button" variant="outline" className="flex-1" onClick={() => setDraft(null)}>
                  やめる
                </Button>
                <Button type="submit" className="flex-1" disabled={form.pending}>
                  {form.pending ? "保存中…" : "保存する"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : (
        <Button size="lg" onClick={() => setDraft({ ...EMPTY })}>
          <Plus /> 商品を登録する
        </Button>
      )}

      <Card>
        <CardHeader>
          <CardTitle>タグ</CardTitle>
          <CardDescription>商品をレジで絞り込むための分類です(例: 主食、ドリンク)。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            {tags.length === 0 && <p className="text-sm text-muted-foreground">まだタグがありません</p>}
            {tags.map((t) => (
              <Badge key={t.id} variant={t.active ? "default" : "muted"}>
                {t.name}
                {!t.active && "(無効)"}
              </Badge>
            ))}
          </div>
          <form onSubmit={addTag} className="flex gap-2">
            <Input value={newTag} onChange={(e) => setNewTag(e.target.value)} placeholder="新しいタグ" maxLength={20} required />
            <Button type="submit" variant="outline" disabled={tagAction.pending}>
              追加
            </Button>
          </form>
          <ErrorText message={tagAction.error} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>商品一覧</CardTitle>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Checkbox checked={showArchived} onCheckedChange={(c) => setShowArchived(c === true)} /> アーカイブ済みも表示
          </label>
        </CardHeader>
        <CardContent className="flex flex-col divide-y divide-border">
          <ErrorText message={row.error} />
          {shown.length === 0 && <p className="py-2 text-sm text-muted-foreground">まだ商品がありません</p>}
          {shown.map((p) => (
            <div key={p.id} className={cn("flex flex-col gap-2 py-3", p.status === "ARCHIVED" && "opacity-50")}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-semibold">{p.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {MODE_LABEL[p.saleMode]}
                    {p.tags.length > 0 && ` ・ ${p.tags.map((t) => t.name).join("、")}`}
                  </p>
                </div>
                <PriceView p={p} />
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {p.status === "STOPPED" && <Badge variant="warning">販売停止</Badge>}
                {p.status === "ARCHIVED" && <Badge variant="muted">アーカイブ</Badge>}
                {p.soldOut && <Badge variant="destructive">{p.soldOutReason === "STOCK" ? "売り切れ(在庫なし)" : "売り切れ(手動)"}</Badge>}
                {p.trackStock && <Badge variant="muted">残り {p.stockQty}</Badge>}
                {!p.discountable && <Badge variant="muted">値下げ対象外</Badge>}
                {p.cutAmount > 0 && <Badge variant="destructive">{money(p.cutAmount)}引き</Badge>}
              </div>
              {p.status !== "ARCHIVED" && (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => edit(p)} disabled={row.pending}>
                    <Pencil className="!size-4" /> 編集
                  </Button>
                  {p.trackStock && (
                    <Button size="sm" variant="outline" onClick={() => adjustStock(p)} disabled={row.pending}>
                      <Warehouse className="!size-4" /> 在庫を増減
                    </Button>
                  )}
                  <Button size="sm" variant="outline" onClick={() => setStatus(p, p.status === "ACTIVE" ? "STOPPED" : "ACTIVE")} disabled={row.pending}>
                    {p.status === "ACTIVE" ? "販売停止" : "販売再開"}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setStatus(p, "ARCHIVED")} disabled={row.pending}>
                    <Archive className="!size-4" /> アーカイブ
                  </Button>
                </div>
              )}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
