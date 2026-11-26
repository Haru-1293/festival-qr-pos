import { ArrowDown, ArrowUp, Download, Eye, EyeOff, ImagePlus, Trash2, Upload } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { defaultLayout, ELEMENT_LABEL, IMAGE_BOX_FULL, IMAGE_LAYER, normalizeLayout, type DesignElement, type ImageBox, type PrintCardData, type PrintKind, type PrintLayout, type PrintTemplateFull } from "@shared/printDesign";
import { ErrorText, Field } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { useConfirm } from "@/lib/confirm";
import { designToXml, downloadText, safeFileName, xmlToDesign } from "@/lib/designXml";
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

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));


type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
const HANDLES: { id: Handle; left: string; top: string; cursor: string }[] = [
  { id: "nw", left: "0%", top: "0%", cursor: "nwse-resize" },
  { id: "n", left: "50%", top: "0%", cursor: "ns-resize" },
  { id: "ne", left: "100%", top: "0%", cursor: "nesw-resize" },
  { id: "e", left: "100%", top: "50%", cursor: "ew-resize" },
  { id: "se", left: "100%", top: "100%", cursor: "nwse-resize" },
  { id: "s", left: "50%", top: "100%", cursor: "ns-resize" },
  { id: "sw", left: "0%", top: "100%", cursor: "nesw-resize" },
  { id: "w", left: "0%", top: "50%", cursor: "ew-resize" },
];

/** カードに対する%の矩形 */
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface DragState {
  mode: "move" | "resize";
  handle?: Handle;
  key: string;
  px: number;
  py: number;
  start: Box;
  fontMm0: number;
  cardW: number;
  cardH: number;
  tx: number[];
  ty: number[];
}

const SNAP_PX = 6;

/** 候補(cands)のうち、目標(targets)にいちばん近いものへ吸着する量と、そろった目標の線 */
function snapAxis(cands: number[], targets: number[], thr: number): { delta: number; lines: number[] } {
  let best: number | null = null;
  for (const c of cands) for (const t of targets) {
    const d = t - c;
    if (Math.abs(d) <= thr && (best === null || Math.abs(d) < Math.abs(best))) best = d;
  }
  if (best === null) return { delta: 0, lines: [] };
  const lines = new Set<number>();
  for (const c of cands) for (const t of targets) if (Math.abs(t - (c + best)) < 0.05) lines.add(t);
  return { delta: best, lines: [...lines] };
}

/**
 * 印刷デザインの編集(Word風): 背景画像・QR・文字をドラッグで動かし、周りの点で大きさを変える。
 * 中央・端・ほかの要素にそろうと吸着してガイド線が出る(Altキーを押している間は吸着しない)。
 * 重なり(レイヤー)の順番も変えられる。保存すると、あとの印刷でもう一度選べる。XMLの書き出し・読み込みもできる。
 */
export function TemplateEditor({
  kind,
  template,
  initial,
  sample,
  onClose,
  onSaved,
}: {
  kind: PrintKind;
  /** 編集するデザイン。null なら新しく作る */
  template: PrintTemplateFull | null;
  /** 新しく作るときの出発点(XML読み込みなど) */
  initial?: { name: string; layout: PrintLayout; image: string | null };
  /** プレビューに使う内容(印刷するカードの1枚目) */
  sample: PrintCardData;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const confirm = useConfirm();
  const [name, setName] = useState(template?.name ?? initial?.name ?? "新しいデザイン");
  const [layout, setLayout] = useState<PrintLayout>(() => normalizeLayout(kind, template?.layout ?? initial?.layout ?? defaultLayout(kind)));
  const [image, setImage] = useState<string | null>(template?.image ?? initial?.image ?? null);
  const [sel, setSel] = useState<string>("qr");
  const [selBox, setSelBox] = useState<Box | null>(null);
  const [guides, setGuides] = useState<{ x: number[]; y: number[] }>({ x: [], y: [] });
  const [imgError, setImgError] = useState<string | null>(null);
  const [xmlError, setXmlError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const xmlFile = useRef<HTMLInputElement>(null);
  const cardBox = useRef<HTMLDivElement>(null);
  const save = useAction();
  const del = useAction();
  const drag = useRef<DragState | null>(null);
  const live = useRef({ layout, sel });
  live.current = { layout, sel };

  const imageBox = layout.imageBox ?? IMAGE_BOX_FULL;
  const isImage = sel === IMAGE_LAYER;
  const el = isImage ? null : (layout.elements.find((e) => e.key === sel) ?? layout.elements[0]!);
  const patchEl = (key: string, p: Partial<DesignElement>) => setLayout((l) => ({ ...l, elements: l.elements.map((e) => (e.key === key ? { ...e, ...p } : e)) }));
  const setBox = (b: Partial<ImageBox>) => setLayout((l) => ({ ...l, imageBox: { ...(l.imageBox ?? IMAGE_BOX_FULL), ...b } }));

  // 画面上の実際の枠(文字は内容で高さが変わるので、DOMから測る)
  const measure = useCallback((key: string): Box | null => {
    const root = cardBox.current;
    if (!root) return null;
    const node = root.querySelector<HTMLElement>(`[data-key="${key}"]`);
    if (!node) return null;
    const r = root.getBoundingClientRect();
    const b = node.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return { x: ((b.left - r.left) / r.width) * 100, y: ((b.top - r.top) / r.height) * 100, w: (b.width / r.width) * 100, h: (b.height / r.height) * 100 };
  }, []);

  useLayoutEffect(() => {
    const b = measure(sel);
    setSelBox((cur) => (cur && b && Math.abs(cur.x - b.x) < 0.01 && Math.abs(cur.y - b.y) < 0.01 && Math.abs(cur.w - b.w) < 0.01 && Math.abs(cur.h - b.h) < 0.01 ? cur : b));
  }, [layout, sel, image, sample, measure]);
  useEffect(() => {
    const root = cardBox.current;
    if (!root) return;
    const re = () => setSelBox(measure(live.current.sel));
    const ro = new ResizeObserver(re);
    ro.observe(root);
    void document.fonts?.ready.then(re);
    return () => ro.disconnect();
  }, [measure]);

  const begin = (key: string, mode: DragState["mode"], e: { clientX: number; clientY: number }, handle?: Handle) => {
    const root = cardBox.current?.getBoundingClientRect();
    const start = measure(key);
    if (!root || !start) return;
    const cur = live.current.layout.elements.find((x) => x.key === key);
    // 吸着の目標: カードの端・中央と、ほかの要素の端・中央
    const tx = [0, 50, 100];
    const ty = [0, 50, 100];
    for (const o of live.current.layout.elements) {
      if (o.key === key || !o.visible) continue;
      const m = measure(o.key);
      if (!m) continue;
      tx.push(m.x, m.x + m.w / 2, m.x + m.w);
      ty.push(m.y, m.y + m.h / 2, m.y + m.h);
    }
    drag.current = { mode, handle, key, px: e.clientX, py: e.clientY, start, fontMm0: cur?.fontMm ?? 0, cardW: root.width, cardH: root.height, tx, ty };
  };

  const onDown = (key: string, e: ReactPointerEvent<HTMLElement>) => {
    e.preventDefault();
    cardBox.current?.focus({ preventScroll: true });
    setSel(key);
    begin(key, "move", e);
  };

  useEffect(() => {
    const apply = (key: string, box: Box, fontMm: number | null) => {
      const r1 = (v: number) => Math.round(v * 10) / 10;
      if (key === IMAGE_LAYER) {
        setLayout((l) => ({ ...l, imageBox: { x: r1(box.x), y: r1(box.y), w: Math.max(1, r1(box.w)), h: Math.max(1, r1(box.h)) } }));
        return;
      }
      setLayout((l) => ({
        ...l,
        elements: l.elements.map((x) => (x.key === key ? { ...x, x: r1(box.x), y: r1(box.y), ...(key === "qr" ? { w: Math.max(2, r1(box.w)) } : { w: Math.max(2, r1(box.w)), fontMm: fontMm ?? x.fontMm }) } : x)),
      }));
    };
    const move = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const dx = ((e.clientX - d.px) / d.cardW) * 100;
      const dy = ((e.clientY - d.py) / d.cardH) * 100;
      const thrX = (SNAP_PX / d.cardW) * 100;
      const thrY = (SNAP_PX / d.cardH) * 100;
      const snapOn = !e.altKey;
      const s = d.start;
      const gx = new Set<number>();
      const gy = new Set<number>();

      if (d.mode === "move") {
        let x = s.x + dx;
        let y = s.y + dy;
        if (snapOn) {
          const sx = snapAxis([x, x + s.w / 2, x + s.w], d.tx, thrX);
          const sy = snapAxis([y, y + s.h / 2, y + s.h], d.ty, thrY);
          x += sx.delta;
          y += sy.delta;
          sx.lines.forEach((v) => gx.add(v));
          sy.lines.forEach((v) => gy.add(v));
        }
        apply(d.key, { x, y, w: s.w, h: s.h }, null);
        setGuides({ x: [...gx], y: [...gy] });
        return;
      }

      const h = d.handle!;
      const hasW = h.includes("w");
      const hasE = h.includes("e");
      const hasN = h.includes("n");
      const hasS = h.includes("s");
      let l = s.x;
      let t = s.y;
      let r = s.x + s.w;
      let b = s.y + s.h;
      if (hasW) l += dx;
      if (hasE) r += dx;
      if (hasN) t += dy;
      if (hasS) b += dy;
      if (snapOn) {
        const edge = (v: number, targets: number[], thr: number, into: Set<number>) => {
          const q = snapAxis([v], targets, thr);
          q.lines.forEach((z) => into.add(z));
          return v + q.delta;
        };
        if (hasW) l = edge(l, d.tx, thrX, gx);
        if (hasE) r = edge(r, d.tx, thrX, gx);
        if (hasN) t = edge(t, d.ty, thrY, gy);
        if (hasS) b = edge(b, d.ty, thrY, gy);
      }
      let w = r - l;
      let ht = b - t;
      const corner = h.length === 2;
      const isQr = d.key === "qr";
      const lock = corner || isQr;
      let scale = 1;
      if (lock) {
        scale = corner ? Math.max(w / s.w, ht / s.h) : hasW || hasE ? w / s.w : ht / s.h;
        scale = Math.max(scale, 2 / s.w, 1 / s.h);
        w = s.w * scale;
        ht = s.h * scale;
        l = hasW ? s.x + s.w - w : hasE ? s.x : s.x + (s.w - w) / 2;
        t = hasN ? s.y + s.h - ht : hasS ? s.y : s.y + (s.h - ht) / 2;
      } else {
        w = Math.max(w, 2);
        ht = Math.max(ht, 1);
        if (hasW) l = s.x + s.w - w;
        if (hasN) t = s.y + s.h - ht;
      }
      const vertical = hasN || hasS;
      const font = d.key === IMAGE_LAYER || isQr ? null : Math.min(40, Math.max(1, d.fontMm0 * (vertical ? ht / s.h : 1)));
      apply(d.key, { x: l, y: t, w, h: ht }, font);
      setGuides({ x: [...gx], y: [...gy] });
    };
    const up = () => {
      if (!drag.current) return;
      drag.current = null;
      setGuides({ x: [], y: [] });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, []);

  // キーボード: 矢印で0.5%(Shiftで2%)ずつ動かす
  const onKey = (e: React.KeyboardEvent) => {
    const k = e.key;
    if (!k.startsWith("Arrow")) return;
    e.preventDefault();
    const step = e.shiftKey ? 2 : 0.5;
    const dx = k === "ArrowLeft" ? -step : k === "ArrowRight" ? step : 0;
    const dy = k === "ArrowUp" ? -step : k === "ArrowDown" ? step : 0;
    const r1 = (v: number) => Math.round(v * 10) / 10;
    if (isImage) setBox({ x: r1(imageBox.x + dx), y: r1(imageBox.y + dy) });
    else if (el) patchEl(el.key, { x: r1(el.x + dx), y: r1(el.y + dy) });
  };

  // レイヤー(重なり): 配列の後ろほど手前
  const moveLayer = (key: string, dir: "front" | "back") =>
    setLayout((l) => {
      const i = l.elements.findIndex((e) => e.key === key);
      const j = dir === "front" ? i + 1 : i - 1;
      if (i < 0 || j < 0 || j >= l.elements.length) return l;
      const next = [...l.elements];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return { ...l, elements: next };
    });

  const centerSel = (axis: "x" | "y") => {
    if (!selBox) return;
    if (axis === "x") {
      const nx = Math.round((50 - selBox.w / 2) * 10) / 10;
      if (isImage) setBox({ x: nx });
      else if (el) patchEl(el.key, { x: nx });
    } else {
      const ny = Math.round((50 - selBox.h / 2) * 10) / 10;
      if (isImage) setBox({ y: ny });
      else if (el) patchEl(el.key, { y: ny });
    }
  };

  const pickImage = async (f: File | undefined) => {
    if (!f) return;
    setImgError(null);
    try {
      setImage(await imageToDataUrl(f));
      setLayout((l) => ({ ...l, imageBox: undefined }));
      setSel(IMAGE_LAYER);
    } catch (e) {
      setImgError(e instanceof Error ? e.message : "画像を読み込めませんでした");
    }
  };
  const removeImage = () => {
    setImage(null);
    setLayout((l) => ({ ...l, imageBox: undefined }));
    if (sel === IMAGE_LAYER) setSel("qr");
  };

  const setSize = (w: number, h: number) => setLayout((l) => ({ ...l, widthMm: w, heightMm: h }));
  const preset = SIZE_PRESETS.find((p) => p.w === layout.widthMm && p.h === layout.heightMm)?.id ?? "custom";

  const exportXml = () => {
    const xml = designToXml({ kind, name: name.trim() || "design", layout, image });
    downloadText(`${safeFileName(name)}.xml`, xml);
  };
  const importXml = async (f: File | undefined) => {
    if (!f) return;
    setXmlError(null);
    try {
      const d = xmlToDesign(await f.text());
      if (d.kind !== kind) throw new Error(`このXMLは${d.kind === "LOGIN" ? "ログインカード" : "QRカード"}用です。${kind === "LOGIN" ? "ログインカード" : "QRカード"}のデザインを選んでください`);
      if (!(await confirm("いま編集中の内容を、XMLの内容で置き換えます。よろしいですか?(保存するまでは、元のデザインは変わりません)", { action: "置き換える", destructive: true }))) return;
      setName(d.name);
      setLayout(d.layout);
      setImage(d.image);
      setSel(d.layout.elements[0]?.key ?? "qr");
    } catch (e) {
      setXmlError(e instanceof Error ? e.message : "XMLを読み込めませんでした");
    }
  };

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

  const layers = [...layout.elements].reverse();
  const label = (k: string) => (k === IMAGE_LAYER ? "背景画像" : (ELEMENT_LABEL[k] ?? k));

  return (
    <Dialog open onOpenChange={(o) => !o && !save.pending && onClose()}>
      <DialogContent className="max-w-5xl" onInteractOutside={(e) => e.preventDefault()}>
        <DialogTitle>{kind === "LOGIN" ? "ログインカード" : "QRカード"}のデザイン</DialogTitle>
        <DialogDescription>背景の画像・QR・文字をドラッグで動かし、周りの点で大きさを変えます。中央や端にそろうと吸着します(Altキーで吸着オフ)。矢印キーで少しずつ動かせます。</DialogDescription>

        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,21rem)]">
          {/* プレビュー(ドラッグ・リサイズできる) */}
          <div className="flex flex-col items-center gap-2 rounded-xl bg-muted p-3">
            <div
              ref={cardBox}
              tabIndex={0}
              onKeyDown={onKey}
              aria-label="デザインのプレビュー。矢印キーで選んだものを動かせます"
              className="relative w-full shadow-md outline-none focus-visible:ring-2 focus-visible:ring-primary"
              style={{ maxWidth: `min(100%, ${Math.round((layout.widthMm / layout.heightMm) * 62)}vh)` }}
            >
              <PrintCard layout={layout} image={image} data={sample} selectedKey={sel} onElementPointerDown={onDown} />
              {/* ガイド線・選択枠・ハンドル(カードの外にはみ出して見える) */}
              <div className="pointer-events-none absolute inset-0">
                {guides.x.map((g) => (
                  <div key={`gx${g}`} className="absolute inset-y-0 w-px bg-fuchsia-500" style={{ left: `${g}%` }} />
                ))}
                {guides.y.map((g) => (
                  <div key={`gy${g}`} className="absolute inset-x-0 h-px bg-fuchsia-500" style={{ top: `${g}%` }} />
                ))}
                {selBox && (
                  <div className="absolute border border-primary" style={{ left: `${selBox.x}%`, top: `${selBox.y}%`, width: `${selBox.w}%`, height: `${selBox.h}%` }}>
                    {HANDLES.map((h) => (
                      <span
                        key={h.id}
                        role="presentation"
                        onPointerDown={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          begin(sel, "resize", e, h.id);
                        }}
                        className="pointer-events-auto absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-sm border-2 border-primary bg-white shadow"
                        style={{ left: h.left, top: h.top, cursor: h.cursor, touchAction: "none" }}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
            <p className="text-center text-xs text-muted-foreground">
              実寸 {layout.widthMm}×{layout.heightMm}mm ・ ピンクの線は中央・端・ほかの要素にそろった印
            </p>
          </div>

          <div className="flex flex-col gap-3">
            <Field label="デザインの名前">
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
            </Field>

            {/* レイヤー */}
            <div className="flex flex-col gap-1.5 rounded-xl border border-border p-3">
              <p className="text-sm font-semibold">レイヤー(上ほど手前)</p>
              <ul className="flex flex-col gap-1" aria-label="レイヤー">
                {layers.map((e, idx) => (
                  <li key={e.key} className={cn("flex items-center gap-1 rounded-lg border px-1.5 py-1", sel === e.key ? "border-primary bg-secondary" : "border-border")}>
                    <button type="button" className="flex-1 truncate text-left text-sm font-medium" onClick={() => setSel(e.key)} aria-pressed={sel === e.key}>
                      <span className={cn(!e.visible && "line-through opacity-50")}>{label(e.key)}</span>
                    </button>
                    <button type="button" aria-label={e.visible ? `${label(e.key)}を隠す` : `${label(e.key)}を表示`} className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-accent" onClick={() => patchEl(e.key, { visible: !e.visible })}>
                      {e.visible ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
                    </button>
                    <button type="button" aria-label={`${label(e.key)}を手前へ`} disabled={idx === 0} className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-accent disabled:opacity-30" onClick={() => moveLayer(e.key, "front")}>
                      <ArrowUp className="size-4" />
                    </button>
                    <button type="button" aria-label={`${label(e.key)}を奥へ`} disabled={idx === layers.length - 1} className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-accent disabled:opacity-30" onClick={() => moveLayer(e.key, "back")}>
                      <ArrowDown className="size-4" />
                    </button>
                  </li>
                ))}
                {image && (
                  <li className={cn("flex items-center gap-1 rounded-lg border px-1.5 py-1", isImage ? "border-primary bg-secondary" : "border-border")}>
                    <button type="button" className="flex-1 truncate text-left text-sm font-medium" onClick={() => setSel(IMAGE_LAYER)} aria-pressed={isImage}>
                      背景画像 <span className="text-xs text-muted-foreground">(いちばん奥)</span>
                    </button>
                    <button type="button" aria-label="背景画像を外す" className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-accent" onClick={removeImage}>
                      <Trash2 className="size-4" />
                    </button>
                  </li>
                )}
              </ul>
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">背景の画像</span>
              <div className="flex gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => file.current?.click()}>
                  <ImagePlus className="!size-4" /> {image ? "画像を変える" : "画像を選ぶ"}
                </Button>
                {image && (
                  <Button type="button" variant="ghost" size="sm" onClick={removeImage}>
                    画像を外す
                  </Button>
                )}
              </div>
              <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { void pickImage(e.target.files?.[0]); e.target.value = ""; }} />
              <ErrorText message={imgError} />
              <p className="text-xs text-muted-foreground">PNG・JPEG・WebP。自動で縮小・圧縮して保存します。選ぶと全面に敷かれます。ドラッグで動かし、周りの点で拡大・縮小できます。</p>
            </div>

            {/* 選んだものの数値 */}
            <div className="flex flex-col gap-2 rounded-xl border border-border p-3">
              <p className="text-sm font-semibold">{label(sel)}の位置・大きさ</p>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => centerSel("x")} disabled={!selBox}>
                  左右の中央へ
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => centerSel("y")} disabled={!selBox}>
                  上下の中央へ
                </Button>
              </div>
              {isImage ? (
                <div className="grid grid-cols-2 gap-2">
                  <Field label="左からの位置(%)">
                    <Input type="number" step="0.5" value={imageBox.x} onChange={(e) => setBox({ x: clamp(Number(e.target.value) || 0, -300, 400) })} />
                  </Field>
                  <Field label="上からの位置(%)">
                    <Input type="number" step="0.5" value={imageBox.y} onChange={(e) => setBox({ y: clamp(Number(e.target.value) || 0, -300, 400) })} />
                  </Field>
                  <Field label="幅(%)">
                    <Input type="number" step="0.5" value={imageBox.w} onChange={(e) => setBox({ w: clamp(Number(e.target.value) || 1, 1, 500) })} />
                  </Field>
                  <Field label="高さ(%)">
                    <Input type="number" step="0.5" value={imageBox.h} onChange={(e) => setBox({ h: clamp(Number(e.target.value) || 1, 1, 500) })} />
                  </Field>
                  <Button type="button" variant="outline" size="sm" className="col-span-2" onClick={() => setLayout((l) => ({ ...l, imageBox: undefined }))}>
                    カード全面に戻す
                  </Button>
                </div>
              ) : (
                el && (
                  <>
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
                    {el.key === "pin" && <p className="text-xs text-muted-foreground">発行時にPINを決めたカードには4桁のPINが、お客様が決めるカードにはPINの記入欄(□□□□)が印刷されます。</p>}
                  </>
                )
              )}
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
              <Field label="画像のはめ方(枠の中)">
                <Select value={layout.fit} onValueChange={(v) => setLayout({ ...layout, fit: v as PrintLayout["fit"] })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cover">枠いっぱい(はみ出しは切る)</SelectItem>
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

            <div className="flex flex-col gap-1.5 rounded-xl border border-border p-3">
              <p className="text-sm font-semibold">XMLで書き出し・読み込み</p>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" size="sm" onClick={exportXml}>
                  <Download className="!size-4" /> XMLを書き出す
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => xmlFile.current?.click()}>
                  <Upload className="!size-4" /> XMLを読み込む
                </Button>
              </div>
              <input ref={xmlFile} type="file" accept=".xml,application/xml,text/xml" hidden onChange={(e) => { void importXml(e.target.files?.[0]); e.target.value = ""; }} />
              <ErrorText message={xmlError} />
              <p className="text-xs text-muted-foreground">背景画像・各要素の位置・大きさ・重なりを含みます。仕様は docs/spec/card-design-xml.md にあります。</p>
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
          <Button type="button" onClick={() => void saveOver()} disabled={save.pending || !name.trim()}>
            {save.pending ? "保存中…" : template ? "上書き保存" : "保存"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
