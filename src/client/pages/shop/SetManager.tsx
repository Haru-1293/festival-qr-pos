import { Archive, ChevronDown, ChevronUp, Pause, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { ProductDto, SetDto, SetInput } from "@shared/api";
import { ErrorText, Field } from "@/components/Shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction } from "@/lib/useAction";
import { useConfirm } from "@/lib/confirm";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";

interface SegDraft {
  id?: string;
  name: string;
  required: boolean;
  pickCount: string;
  allowDuplicate: boolean;
  items: { productId: string; surcharge: string }[];
}
interface Draft {
  id: string | null;
  name: string;
  price: string;
  description: string;
  discountable: boolean;
  sortOrder: string;
  segments: SegDraft[];
}
const digits = (s: string) => s.replace(/[^0-9]/g, "");
const newSeg = (): SegDraft => ({
  name: "",
  required: true,
  pickCount: "1",
  allowDuplicate: false,
  items: [],
});
const EMPTY: Draft = {
  id: null,
  name: "",
  price: "",
  description: "",
  discountable: true,
  sortOrder: "0",
  segments: [newSeg()],
};

/** 店舗責任者のセット管理。内訳(フード・ドリンクなど)ごとに選べる商品と追加料金を決める。変更はレジへすぐ反映される */
export function SetManager({ shopId }: { shopId: string }) {
  const confirm = useConfirm();
  const { money } = useAuth();
  const [sets, setSets] = useState<SetDto[]>([]);
  const [products, setProducts] = useState<ProductDto[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const form = useAction();
  const row = useAction();

  const load = useCallback(async () => {
    const [s, p] = await Promise.all([api<{ sets: SetDto[] }>(`/catalog/${shopId}/sets`), api<{ products: ProductDto[] }>(`/catalog/${shopId}/products`)]);
    setSets(s.sets);
    setProducts(p.products);
  }, [shopId]);
  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  // セットに入れられる商品: 単品のみ・アーカイブ済みは除く
  const usable = products.filter((p) => p.status !== "ARCHIVED" && p.saleMode !== "SINGLE_ONLY");

  const edit = (s: SetDto) =>
    setDraft({
      id: s.id,
      name: s.name,
      price: String(s.price),
      description: s.description ?? "",
      discountable: s.discountable,
      sortOrder: String(s.sortOrder),
      segments: s.segments.map((g) => ({
        id: g.id,
        name: g.name,
        required: g.required,
        pickCount: String(g.pickCount),
        allowDuplicate: g.allowDuplicate,
        items: g.items.map((i) => ({
          productId: i.productId,
          surcharge: String(i.surcharge),
        })),
      })),
    });

  const patchSeg = (i: number, f: (g: SegDraft) => SegDraft) => setDraft((d) => (d ? { ...d, segments: d.segments.map((g, k) => (k === i ? f(g) : g)) } : d));
  const moveSeg = (i: number, by: number) =>
    setDraft((d) => {
      if (!d) return d;
      const j = i + by;
      if (j < 0 || j >= d.segments.length) return d;
      const segs = [...d.segments];
      [segs[i], segs[j]] = [segs[j], segs[i]];
      return { ...d, segments: segs };
    });

  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    const body: SetInput = {
      name: draft.name,
      price: Number(draft.price || 0),
      description: draft.description.trim() || null,
      discountable: draft.discountable,
      sortOrder: Number(draft.sortOrder || 0),
      segments: draft.segments.map((g) => ({
        ...(g.id ? { id: g.id } : {}),
        name: g.name,
        required: g.required,
        pickCount: Number(g.pickCount || 1),
        allowDuplicate: g.allowDuplicate,
        items: g.items.map((i) => ({
          productId: i.productId,
          surcharge: Number(i.surcharge || 0),
        })),
      })),
    } as SetInput;
    void form.run(async () => {
      if (draft.id)
        await api(`/catalog/${shopId}/sets/${draft.id}`, {
          method: "PUT",
          body,
        });
      else await api(`/catalog/${shopId}/sets`, { body });
      setDraft(null);
      await load();
    });
  };

  const setStatus = async (s: SetDto, status: "ACTIVE" | "STOPPED" | "ARCHIVED") => {
    if (status === "ARCHIVED" && !(await confirm(`「${s.name}」をアーカイブしますか?(売った履歴は残ります)`, { destructive: true }))) return;
    void row.run(async () => {
      await api(`/catalog/${shopId}/sets/${s.id}/status`, { body: { status } });
      await load();
    });
  };

  if (draft) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{draft.id ? "セットを編集" : "セットを登録"}</CardTitle>
          <CardDescription>セット価格に、選んだ内訳の追加料金を足した金額になります。値下げはセット価格にだけ効き、追加料金は値下げされません。</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={save} className="flex flex-col gap-4">
            <Field label="セット名">
              <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={60} required />
            </Field>
            <Field label="セット価格(円)">
              <Input inputMode="numeric" value={draft.price} onChange={(e) => setDraft({ ...draft, price: digits(e.target.value) })} required />
            </Field>
            <Field label="説明(任意)">
              <Input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} maxLength={300} />
            </Field>
            <label className="flex items-center gap-2 text-sm font-medium">
              <Checkbox checked={draft.discountable} onCheckedChange={(c) => setDraft({ ...draft, discountable: c === true })} />
              一律値下げの対象にする
            </label>
            <Field label="表示順(小さいほど先)">
              <Input inputMode="numeric" value={draft.sortOrder} onChange={(e) => setDraft({ ...draft, sortOrder: digits(e.target.value) })} />
            </Field>

            <div className="flex flex-col gap-3">
              <p className="text-sm font-bold">内訳</p>
              {draft.segments.map((g, gi) => (
                <div key={gi} className="flex flex-col gap-2 rounded-xl border border-border p-3" role="group" aria-label={`内訳${gi + 1}`}>
                  <div className="flex items-end gap-2">
                    <div className="min-w-0 flex-1">
                      <Field label="内訳の名前(例: フード)">
                        <Input
                          value={g.name}
                          onChange={(e) =>
                            patchSeg(gi, (x) => ({
                              ...x,
                              name: e.target.value,
                            }))
                          }
                          maxLength={30}
                          required
                        />
                      </Field>
                    </div>
                    <Button type="button" size="icon" variant="ghost" aria-label="上へ" onClick={() => moveSeg(gi, -1)} disabled={gi === 0}>
                      <ChevronUp />
                    </Button>
                    <Button type="button" size="icon" variant="ghost" aria-label="下へ" onClick={() => moveSeg(gi, 1)} disabled={gi === draft.segments.length - 1}>
                      <ChevronDown />
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label="この内訳を削除"
                      disabled={draft.segments.length === 1}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          segments: draft.segments.filter((_, k) => k !== gi),
                        })
                      }
                    >
                      <Trash2 />
                    </Button>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
                    <label className="flex items-center gap-2">
                      選ぶ数
                      <Input
                        className="h-10 w-16"
                        inputMode="numeric"
                        value={g.pickCount}
                        onChange={(e) =>
                          patchSeg(gi, (x) => ({
                            ...x,
                            pickCount: digits(e.target.value),
                          }))
                        }
                      />
                    </label>
                    <label className="flex items-center gap-2">
                      <Checkbox
                        checked={g.required}
                        onCheckedChange={(c) =>
                          patchSeg(gi, (x) => ({
                            ...x,
                            required: c === true,
                          }))
                        }
                      />{" "}
                      必須
                    </label>
                    <label className="flex items-center gap-2">
                      <Checkbox
                        checked={g.allowDuplicate}
                        onCheckedChange={(c) =>
                          patchSeg(gi, (x) => ({
                            ...x,
                            allowDuplicate: c === true,
                          }))
                        }
                      />{" "}
                      同じ商品を重ねて選べる
                    </label>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {g.items.map((it, ii) => (
                      <div key={it.productId} className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{usable.find((p) => p.id === it.productId)?.name ?? "(使えない商品)"}</span>
                        <span className="text-xs text-muted-foreground">+</span>
                        <Input
                          className="h-10 w-20"
                          inputMode="numeric"
                          aria-label="追加料金"
                          value={it.surcharge}
                          onChange={(e) =>
                            patchSeg(gi, (x) => ({
                              ...x,
                              items: x.items.map((y, k) => (k === ii ? { ...y, surcharge: digits(e.target.value) } : y)),
                            }))
                          }
                        />
                        <span className="text-xs text-muted-foreground">円</span>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          aria-label="外す"
                          onClick={() =>
                            patchSeg(gi, (x) => ({
                              ...x,
                              items: x.items.filter((_, k) => k !== ii),
                            }))
                          }
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    ))}
                    <Select
                      value=""
                      onValueChange={(pid) => {
                        if (pid)
                          patchSeg(gi, (x) => ({
                            ...x,
                            items: [...x.items, { productId: pid, surcharge: "0" }],
                          }));
                      }}
                    >
                      <SelectTrigger className="h-11 text-sm" aria-label="商品を追加">
                        <SelectValue placeholder="＋ 選べる商品を追加…" />
                      </SelectTrigger>
                      <SelectContent>
                        {usable
                          .filter((p) => !g.items.some((i) => i.productId === p.id))
                          .map((p) => (
                            <SelectItem key={p.id} value={p.id}>
                              {p.name}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  setDraft({
                    ...draft,
                    segments: [...draft.segments, newSeg()],
                  })
                }
                disabled={draft.segments.length >= 8}
              >
                <Plus /> 内訳を追加
              </Button>
            </div>

            <ErrorText message={form.error} />
            <div className="flex gap-2">
              <Button type="submit" disabled={form.pending} className="flex-1">
                {form.pending ? "保存中…" : "保存する"}
              </Button>
              <Button type="button" variant="outline" onClick={() => setDraft(null)}>
                キャンセル
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    );
  }

  const shown = sets.filter((s) => s.status !== "ARCHIVED");
  return (
    <div className="flex flex-col gap-3">
      <Button onClick={() => setDraft(EMPTY)}>
        <Plus /> セットを登録
      </Button>
      <ErrorText message={row.error} />
      {shown.length === 0 && <p className="p-6 text-center text-sm text-muted-foreground">セットはまだありません</p>}
      {shown.map((s) => (
        <Card key={s.id} className="p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="font-bold">{s.name}</p>
              <p className="text-sm">
                {s.cutAmount > 0 && <span className="mr-1.5 text-xs text-muted-foreground line-through">{money(s.price)}</span>}
                <span className="font-bold">{money(s.salePrice)}</span>
              </p>
              <p className="text-xs text-muted-foreground">{s.segments.map((g) => `${g.name}(${g.items.length}種)`).join(" / ")}</p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              {s.status === "STOPPED" ? <Badge variant="warning">販売停止中</Badge> : s.available ? <Badge>販売中</Badge> : <Badge variant="destructive">売り切れ</Badge>}
              {!s.discountable && <Badge variant="muted">値下げ対象外</Badge>}
            </div>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => edit(s)}>
              <Pencil className="!size-4" /> 編集
            </Button>
            {s.status === "STOPPED" ? (
              <Button size="sm" variant="outline" disabled={row.pending} onClick={() => setStatus(s, "ACTIVE")}>
                <Play className="!size-4" /> 販売再開
              </Button>
            ) : (
              <Button size="sm" variant="outline" disabled={row.pending} onClick={() => setStatus(s, "STOPPED")}>
                <Pause className="!size-4" /> 販売停止
              </Button>
            )}
            <Button size="sm" variant="ghost" disabled={row.pending} onClick={() => setStatus(s, "ARCHIVED")}>
              <Archive className="!size-4" /> アーカイブ
            </Button>
          </div>
        </Card>
      ))}
    </div>
  );
}
