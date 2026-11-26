import { Paintbrush, Plus, Printer } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { defaultLayout, normalizeLayout, type PrintCardData, type PrintKind, type PrintTemplateFull, type PrintTemplateSummary } from "@shared/printDesign";
import { ErrorText, Field } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { PrintCard } from "./PrintCard";
import { TemplateEditor } from "./TemplateEditor";

const DEFAULT_ID = "default";
const storeKey = (kind: PrintKind) => `fqp.print.${kind}`;

function readStore(kind: PrintKind): { id: string; dx: number; dy: number } {
  try {
    const v = JSON.parse(localStorage.getItem(storeKey(kind)) ?? "{}") as Partial<{ id: string; dx: number; dy: number }>;
    return { id: typeof v.id === "string" ? v.id : DEFAULT_ID, dx: Number(v.dx) || 0, dy: Number(v.dy) || 0 };
  } catch {
    return { id: DEFAULT_ID, dx: 0, dy: 0 };
  }
}

/**
 * 印刷シート。表示中の内容がそのまま印刷される(画面の他の部分は印刷されない)。
 * デザイン(背景画像+位置)を選んで印刷でき、同じカードを別のデザインで刷り直せる。
 * 全体管理者(canEdit)は、ここからデザインを作る・直す。
 */
export function PrintSheet({
  kind,
  title,
  items,
  canEdit,
  onClose,
  notice,
  extra,
}: {
  kind: PrintKind;
  title: string;
  items: PrintCardData[];
  canEdit: boolean;
  onClose: () => void;
  notice?: ReactNode;
  extra?: ReactNode;
}) {
  const [templates, setTemplates] = useState<PrintTemplateSummary[]>([]);
  const [selId, setSelId] = useState<string>(() => readStore(kind).id);
  const [dx, setDx] = useState(() => readStore(kind).dx);
  const [dy, setDy] = useState(() => readStore(kind).dy);
  const [full, setFull] = useState<PrintTemplateFull | null>(null);
  const [editing, setEditing] = useState<"new" | "edit" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cache = useRef(new Map<string, PrintTemplateFull>());

  useEffect(() => {
    document.body.classList.add("print-sheet-open");
    return () => document.body.classList.remove("print-sheet-open");
  }, []);

  const loadList = useCallback(async () => {
    try {
      const r = await api<{ templates: PrintTemplateSummary[] }>(`/print-templates?kind=${kind}`);
      setTemplates(r.templates);
      return r.templates;
    } catch {
      setTemplates([]); // 権限がない・読み込めない: 標準デザインだけで印刷できる
      return [];
    }
  }, [kind]);
  useEffect(() => {
    void loadList();
  }, [loadList]);

  const selected = templates.find((t) => t.id === selId) ?? null;
  // 選んだデザインの画像を読み込む(画像つきは1回だけ取得して使い回す)
  useEffect(() => {
    if (!selected) {
      setFull(null);
      return;
    }
    const key = `${selected.id}:${selected.updatedAt}`;
    const hit = cache.current.get(key);
    if (hit) return setFull(hit);
    let alive = true;
    api<{ template: PrintTemplateFull }>(`/print-templates/${selected.id}`)
      .then((r) => {
        cache.current.set(key, r.template);
        if (alive) setFull(r.template);
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : "デザインを読み込めませんでした"));
    return () => {
      alive = false;
    };
  }, [selected]);

  // 選んだデザインと位置の微調整は、この端末に覚えておく
  useEffect(() => {
    try {
      localStorage.setItem(storeKey(kind), JSON.stringify({ id: selId, dx, dy }));
    } catch {
      /* 覚えられなくても印刷はできる */
    }
  }, [kind, selId, dx, dy]);

  const layout = normalizeLayout(kind, (selected ? full?.layout : null) ?? selected?.layout ?? defaultLayout(kind));
  const image = selected && full ? full.image : null;
  const loadingImage = !!selected?.hasImage && !full;
  const sample = items[0] ?? { qr: "FES1:SAMPLE" };
  const perPage = useMemo(() => {
    const usableW = 186;
    const usableH = 273;
    const cols = Math.max(1, Math.floor((usableW + layout.gapMm) / (layout.widthMm + layout.gapMm)));
    const rows = Math.max(1, Math.floor((usableH + layout.gapMm) / (layout.heightMm + layout.gapMm)));
    return cols * rows;
  }, [layout]);

  return createPortal(
    <div className="sheet-host fixed inset-0 z-50 overflow-auto bg-background p-4 print:block print:p-0" role="dialog" aria-label={title}>
      <div className="mx-auto max-w-5xl">
        <div className="mb-3 flex flex-col gap-3 print:hidden">
          <p className="text-lg font-bold">
            {title}({items.length}枚)
          </p>
          {notice}
          <div className="grid gap-3 rounded-xl border border-border bg-card p-3 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
            <Field label="印刷デザイン" hint={`A4に約${perPage}枚(${layout.widthMm}×${layout.heightMm}mm)。同じカードでも、デザインを変えて何度でも印刷できます`}>
              <Select value={selected ? selId : DEFAULT_ID} onValueChange={setSelId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_ID}>標準デザイン(画像なし)</SelectItem>
                  {templates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-2 sm:w-44">
              <Field label="右へ(mm)">
                <Input type="number" step="0.5" min={-20} max={20} value={dx} onChange={(e) => setDx(Math.max(-20, Math.min(20, Number(e.target.value) || 0)))} />
              </Field>
              <Field label="下へ(mm)">
                <Input type="number" step="0.5" min={-20} max={20} value={dy} onChange={(e) => setDy(Math.max(-20, Math.min(20, Number(e.target.value) || 0)))} />
              </Field>
            </div>
            {canEdit && (
              <div className="flex items-end gap-2">
                {selected && (
                  <Button variant="outline" onClick={() => full && setEditing("edit")} disabled={!full}>
                    <Paintbrush /> 編集
                  </Button>
                )}
                <Button variant="outline" onClick={() => setEditing("new")}>
                  <Plus /> 新しいデザイン
                </Button>
              </div>
            )}
          </div>
          <p className="text-xs text-muted-foreground">印刷のずれは「右へ・下へ」で直せます(この端末に覚えます)。印刷の設定は「倍率100%(実際のサイズ)」にしてください。</p>
          <ErrorText message={error} />
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => window.print()} disabled={loadingImage}>
              <Printer /> {loadingImage ? "画像を読み込み中…" : "印刷する"}
            </Button>
            {extra}
            <Button variant="outline" onClick={onClose}>
              閉じる
            </Button>
          </div>
          <p className="text-xs font-semibold text-muted-foreground">▼ プレビュー(用紙に出る見た目と大きさです)</p>
        </div>

        {/* 用紙に出る部分。画面ではA4の幅で見せ、印刷ではこの部分だけが出る */}
        <div className="overflow-x-auto rounded-lg bg-muted p-3 print:overflow-visible print:bg-transparent print:p-0">
          <div className="mx-auto bg-white print:bg-transparent" style={{ width: "186mm", maxWidth: "none" }}>
            <div className="flex flex-wrap" style={{ gap: `${layout.gapMm}mm`, position: "relative", left: `${dx}mm`, top: `${dy}mm` }}>
              {items.map((d, i) => (
                <PrintCard key={i} layout={layout} image={image} data={d} width={`${layout.widthMm}mm`} className="border border-neutral-300 print:border-transparent" />
              ))}
            </div>
          </div>
        </div>
      </div>

      {editing && (
        <TemplateEditor
          kind={kind}
          template={editing === "edit" ? full : null}
          sample={sample}
          onClose={() => setEditing(null)}
          onSaved={(id) => {
            setEditing(null);
            cache.current.clear();
            void loadList().then(() => setSelId(id || DEFAULT_ID));
          }}
        />
      )}
    </div>,
    document.body,
  );
}
