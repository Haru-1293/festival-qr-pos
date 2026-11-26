import { ImagePlus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { defaultLayout, ELEMENT_LABEL, type DesignElement, type PrintCardData, type PrintKind, type PrintLayout, type PrintTemplateFull } from "@shared/printDesign";
import { ErrorText, Field } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { useConfirm } from "@/lib/confirm";
import { useAction } from "@/lib/useAction";
import { cn } from "@/lib/utils";
import { PrintCard } from "./PrintCard";
import { imageToDataUrl } from "./imageUtil";

const SIZE_PRESETS: { id: string; label: string; w: number; h: number }[] = [
  { id: "meishi", label: "名刺(91×55mm)", w: 91, h: 55 },
  { id: "card", label: "カード縦(55×91mm)", w: 55, h: 91 },
  { id: "tag", label: "ログインカード(90×120mm)", w: 90, h: 120 },
  { id: "a6", label: "A6縦(105×148mm)", w: 105, h: 148 },
  { id: "a6l", label: "A6横(148×105mm)", w: 148, h: 105 },
  { id: "a5", label: "A5縦(148×210mm)", w: 148, h: 210 },
];

const round1 = (n: number) => Math.round(n * 10) / 10;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * 印刷デザインの編集: 背景画像をアップロードし、QR・表示名などをドラッグ(または数値)で位置合わせする。
 * 保存すると、あとの印刷でもう一度選べる。「別のデザインとして保存」で、同じカードを違うデザインで刷り直せる。
 */
export function TemplateEditor({
  kind,
  template,
  sample,
  onClose,
  onSaved,
}: {
  kind: PrintKind;
  /** 編集するデザイン。null なら新しく作る */
  template: PrintTemplateFull | null;
  /** プレビューに使う内容(印刷するカードの1枚目) */
  sample: PrintCardData;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const confirm = useConfirm();
  const [name, setName] = useState(template?.name ?? "新しいデザイン");
  const [layout, setLayout] = useState<PrintLayout>(template?.layout ?? defaultLayout(kind));
  const [image, setImage] = useState<string | null>(template?.image ?? null);
  const [sel, setSel] = useState<string>("qr");
  const [imgError, setImgError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const cardBox = useRef<HTMLDivElement>(null);
  const save = useAction();
  const del = useAction();
  const drag = useRef<{ key: string; px: number; py: number; ex: number; ey: number } | null>(null);

  const el = layout.elements.find((e) => e.key === sel) ?? layout.elements[0]!;
  const patchEl = (key: string, p: Partial<DesignElement>) => setLayout((l) => ({ ...l, elements: l.elements.map((e) => (e.key === key ? { ...e, ...p } : e)) }));

  const onDown = (key: string, e: PointerEvent<HTMLElement>) => {
    e.preventDefault();
    setSel(key);
    const cur = layout.elements.find((x) => x.key === key);
    if (!cur) return;
    drag.current = { key, px: e.clientX, py: e.clientY, ex: cur.x, ey: cur.y };
  };
  useEffect(() => {
    const move = (e: globalThis.PointerEvent) => {
      const d = drag.current;
      const box = cardBox.current?.getBoundingClientRect();
      if (!d || !box) return;
      const x = clamp(round1(d.ex + ((e.clientX - d.px) / box.width) * 100), -20, 120);
      const y = clamp(round1(d.ey + ((e.clientY - d.py) / box.height) * 100), -20, 120);
      patchEl(d.key, { x, y });
    };
    const up = () => (drag.current = null);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickImage = async (f: File | undefined) => {
    if (!f) return;
    setImgError(null);
    try {
      setImage(await imageToDataUrl(f));
    } catch (e) {
      setImgError(e instanceof Error ? e.message : "画像を読み込めませんでした");
    }
  };

  const setSize = (w: number, h: number) => setLayout((l) => ({ ...l, widthMm: w, heightMm: h }));
  const preset = SIZE_PRESETS.find((p) => p.w === layout.widthMm && p.h === layout.heightMm)?.id ?? "custom";

  const body = () => ({ name: name.trim(), layout, image });
  const saveOver = () =>
    save.run(async () => {
      if (!template) {
        const r = await api<{ id: string }>("/print-templates", { method: "POST", body: { kind, ...body() } });
        onSaved(r.id);
      } else {
        await api(`/print-templates/${template.id}`, { method: "PUT", body: body() });
        onSaved(template.id);
      }
    });
  const saveNew = () =>
    save.run(async () => {
      const r = await api<{ id: string }>("/print-templates", { method: "POST", body: { kind, ...body(), name: template && name.trim() === template.name ? `${name.trim()}(コピー)`.slice(0, 40) : name.trim() } });
      onSaved(r.id);
    });
  const remove = async () => {
    if (!template) return;
    if (!(await confirm(`デザイン「${template.name}」を削除します。よろしいですか?`, { action: "削除する", destructive: true }))) return;
    await del.run(async () => {
      await api(`/print-templates/${template.id}`, { method: "DELETE" });
      onSaved("");
    });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !save.pending && onClose()}>
      <DialogContent className="max-w-4xl" onInteractOutside={(e) => e.preventDefault()}>
        <DialogTitle>{kind === "LOGIN" ? "ログインカード" : "QRカード"}の印刷デザイン</DialogTitle>
        <DialogDescription>背景の画像を選び、QRや文字をドラッグして位置を合わせます。右側で大きさや色を細かく直せます。</DialogDescription>

        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
          {/* プレビュー(ドラッグで動かせる) */}
          <div className="flex flex-col items-center gap-2 rounded-xl bg-muted p-3">
            <div ref={cardBox} className="w-full shadow-md" style={{ maxWidth: `min(100%, ${Math.round((layout.widthMm / layout.heightMm) * 62)}vh)` }}>
              <PrintCard layout={layout} image={image} data={sample} selectedKey={sel} onElementPointerDown={onDown} />
            </div>
            <p className="text-center text-xs text-muted-foreground">
              実寸 {layout.widthMm}×{layout.heightMm}mm ・ 点線の枠をドラッグして動かします
            </p>
          </div>

          <div className="flex flex-col gap-3">
            <Field label="デザインの名前">
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
            </Field>

            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">背景の画像</span>
              <div className="flex gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => file.current?.click()}>
                  <ImagePlus className="!size-4" /> {image ? "画像を変える" : "画像を選ぶ"}
                </Button>
                {image && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setImage(null)}>
                    画像を外す
                  </Button>
                )}
              </div>
              <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { void pickImage(e.target.files?.[0]); e.target.value = ""; }} />
              <ErrorText message={imgError} />
              <p className="text-xs text-muted-foreground">PNG・JPEG・WebP。自動で縮小・圧縮して保存します。デザインの完成画像(QRを置く場所は空けておく)を選んでください。</p>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <Field label="用紙(カード)の大きさ">
                <Select value={preset} onValueChange={(v) => { const p = SIZE_PRESETS.find((x) => x.id === v); if (p) setSize(p.w, p.h); }}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SIZE_PRESETS.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.label}
                      </SelectItem>
                    ))}
                    <SelectItem value="custom">自分で指定</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label="画像のはめ方">
                <Select value={layout.fit} onValueChange={(v) => setLayout({ ...layout, fit: v as PrintLayout["fit"] })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cover">全面に敷く(はみ出しは切る)</SelectItem>
                    <SelectItem value="contain">全体を収める</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label="幅(mm)">
                <Input type="number" min={30} max={300} step="0.5" value={layout.widthMm} onChange={(e) => setSize(clamp(Number(e.target.value) || 30, 30, 300), layout.heightMm)} />
              </Field>
              <Field label="高さ(mm)">
                <Input type="number" min={30} max={400} step="0.5" value={layout.heightMm} onChange={(e) => setSize(layout.widthMm, clamp(Number(e.target.value) || 30, 30, 400))} />
              </Field>
              <Field label="地の色(画像がないとき)">
                <Input type="color" value={layout.bg} onChange={(e) => setLayout({ ...layout, bg: e.target.value })} className="h-10 p-1" />
              </Field>
              <Field label="複数枚の間隔(mm)">
                <Input type="number" min={0} max={30} step="0.5" value={layout.gapMm} onChange={(e) => setLayout({ ...layout, gapMm: clamp(Number(e.target.value) || 0, 0, 30) })} />
              </Field>
            </div>

            <div className="flex flex-col gap-2 rounded-xl border border-border p-3">
              <p className="text-sm font-semibold">載せるもの</p>
              <div className="flex flex-wrap gap-1.5">
                {layout.elements.map((e) => (
                  <button
                    key={e.key}
                    type="button"
                    onClick={() => setSel(e.key)}
                    aria-pressed={sel === e.key}
                    className={cn("rounded-full border px-3 py-1 text-xs font-semibold", sel === e.key ? "border-primary bg-secondary" : "border-border text-muted-foreground", !e.visible && "line-through opacity-60")}
                  >
                    {ELEMENT_LABEL[e.key] ?? e.key}
                  </button>
                ))}
              </div>
              <label className="flex items-center justify-between gap-2 text-sm">
                <span>{ELEMENT_LABEL[el.key] ?? el.key} を印刷する</span>
                <Switch checked={el.visible} onCheckedChange={(v) => patchEl(el.key, { visible: v })} />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <Field label="左からの位置(%)">
                  <Input type="number" step="0.5" value={el.x} onChange={(e) => patchEl(el.key, { x: clamp(Number(e.target.value) || 0, -20, 120) })} />
                </Field>
                <Field label="上からの位置(%)">
                  <Input type="number" step="0.5" value={el.y} onChange={(e) => patchEl(el.key, { y: clamp(Number(e.target.value) || 0, -20, 120) })} />
                </Field>
                <Field label={el.key === "qr" ? "QRの大きさ(幅に対する%)" : "文字枠の幅(%)"}>
                  <Input type="number" step="0.5" value={el.w} onChange={(e) => patchEl(el.key, { w: clamp(Number(e.target.value) || 2, 2, 150) })} />
                </Field>
                {el.key !== "qr" && (
                  <Field label="文字の大きさ(mm)">
                    <Input type="number" step="0.2" value={el.fontMm} onChange={(e) => patchEl(el.key, { fontMm: clamp(Number(e.target.value) || 1, 1, 40) })} />
                  </Field>
                )}
                {el.key !== "qr" && (
                  <>
                    <Field label="文字の色">
                      <Input type="color" value={el.color} onChange={(e) => patchEl(el.key, { color: e.target.value })} className="h-10 p-1" />
                    </Field>
                    <Field label="そろえ">
                      <Select value={el.align} onValueChange={(v) => patchEl(el.key, { align: v as DesignElement["align"] })}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="left">左</SelectItem>
                          <SelectItem value="center">中央</SelectItem>
                          <SelectItem value="right">右</SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                  </>
                )}
              </div>
              {el.key !== "qr" && (
                <label className="flex items-center justify-between gap-2 text-sm">
                  <span>太字</span>
                  <Switch checked={el.bold} onCheckedChange={(v) => patchEl(el.key, { bold: v })} />
                </label>
              )}
              {el.key === "qr" && <p className="text-xs text-muted-foreground">QRは白い地の上に印刷されます。読み取れなくなるので、小さくしすぎない(2.5cm以上)・色をつけないでください。</p>}
            </div>
          </div>
        </div>

        <ErrorText message={save.error ?? del.error} />
        <div className="flex flex-wrap gap-2">
          {template && (
            <Button type="button" variant="ghost" className="text-destructive" onClick={() => void remove()} disabled={save.pending || del.pending}>
              <Trash2 /> 削除
            </Button>
          )}
          <span className="flex-1" />
          <Button type="button" variant="outline" onClick={onClose} disabled={save.pending}>
            閉じる
          </Button>
          {template && (
            <Button type="button" variant="outline" onClick={() => void saveNew()} disabled={save.pending || !name.trim()}>
              別のデザインとして保存
            </Button>
          )}
          <Button type="button" onClick={() => void (template ? saveOver() : saveOver())} disabled={save.pending || !name.trim()}>
            {save.pending ? "保存中…" : template ? "上書き保存" : "保存"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
