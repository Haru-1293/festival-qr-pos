import { Download, FilePlus2, Paintbrush, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PrintCardData, PrintKind, PrintLayout, PrintTemplateFull, PrintTemplateSummary } from "@shared/printDesign";
import { ErrorText } from "@/components/Shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";
import { designToXml, downloadText, safeFileName, xmlToDesign } from "@/lib/designXml";
import { cn } from "@/lib/utils";
import { TemplateEditor } from "./TemplateEditor";

const SAMPLE: Record<PrintKind, PrintCardData> = {
  CARD: { qr: "FES1:C:SAMPLE-SAMPLE-SAMPLE", displayNo: "C000123", expiry: "2027-05-31", festival: "文化祭", pin: "4821" },
  LOGIN: { qr: "FES1:C:SAMPLE-SAMPLE-SAMPLE", name: "サンプル 太郎", loginId: "taro-sample", role: "店員", festival: "文化祭", shop: "3年A組 焼きそば" },
};
const KIND_LABEL: Record<PrintKind, string> = { CARD: "QRカード", LOGIN: "ログインカード" };

/**
 * カード・ログインカードのデザインを、発行(印刷)の前に作る・直す画面。
 * 作ったデザインは、印刷のときに選べる。XMLの書き出し・読み込みもここからできる。
 */
export function TemplateManager({ kind: initialKind = "CARD" }: { kind?: PrintKind }) {
  const [kind, setKind] = useState<PrintKind>(initialKind);
  const [list, setList] = useState<PrintTemplateSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ template: PrintTemplateFull | null; initial?: { name: string; layout: PrintLayout; image: string | null } } | null>(null);
  const xml = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setList(null);
    try {
      setList((await api<{ templates: PrintTemplateSummary[] }>(`/print-templates?kind=${kind}`)).templates);
    } catch (e) {
      setError(e instanceof Error ? e.message : "読み込めませんでした");
      setList([]);
    }
  }, [kind]);
  useEffect(() => {
    void load();
  }, [load]);

  const full = async (id: string) => (await api<{ template: PrintTemplateFull }>(`/print-templates/${id}`)).template;
  const edit = async (id: string) => {
    setError(null);
    try {
      setEditing({ template: await full(id) });
    } catch (e) {
      setError(e instanceof Error ? e.message : "デザインを開けませんでした");
    }
  };
  const exportXml = async (id: string) => {
    setError(null);
    try {
      const t = await full(id);
      downloadText(`${safeFileName(t.name)}.xml`, designToXml({ kind: t.kind, name: t.name, layout: t.layout, image: t.image }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "書き出せませんでした");
    }
  };
  const importXml = async (f: File | undefined) => {
    if (!f) return;
    setError(null);
    try {
      const d = xmlToDesign(await f.text());
      if (d.kind !== kind) setKind(d.kind);
      setEditing({ template: null, initial: { name: d.name, layout: d.layout, image: d.image } });
    } catch (e) {
      setError(e instanceof Error ? e.message : "XMLを読み込めませんでした");
    }
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>カードのデザイン</CardTitle>
          <CardDescription>背景画像と、QR・文字の位置を決めておきます。印刷のときにデザインを選べます(カードを発行する前に作れます)。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex gap-2" role="tablist" aria-label="デザインの種類">
            {(Object.keys(KIND_LABEL) as PrintKind[]).map((k) => (
              <button key={k} type="button" role="tab" aria-selected={kind === k} onClick={() => setKind(k)} className={cn("h-9 rounded-full border px-4 text-sm font-semibold", kind === k ? "border-primary bg-secondary" : "border-border text-muted-foreground")}>
                {KIND_LABEL[k]}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setEditing({ template: null })}>
              <FilePlus2 /> 新しいデザインを作る
            </Button>
            <Button variant="outline" onClick={() => xml.current?.click()}>
              <Upload /> XMLから作る
            </Button>
            <input ref={xml} type="file" accept=".xml,application/xml,text/xml" hidden onChange={(e) => { void importXml(e.target.files?.[0]); e.target.value = ""; }} />
          </div>
          <ErrorText message={error} />
          {list === null ? (
            <p className="text-sm text-muted-foreground">読み込み中…</p>
          ) : list.length === 0 ? (
            <p className="rounded-lg bg-muted px-3 py-4 text-center text-sm text-muted-foreground">{KIND_LABEL[kind]}のデザインはまだありません。「新しいデザインを作る」から作れます(作らなくても、標準デザインで印刷できます)。</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {list.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold">{t.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {t.layout.widthMm}×{t.layout.heightMm}mm {t.hasImage && <Badge variant="muted">背景画像あり</Badge>}
                    </p>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => void edit(t.id)}>
                    <Paintbrush className="!size-4" /> 編集
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void exportXml(t.id)} aria-label={`${t.name}をXMLで書き出す`}>
                    <Download className="!size-4" /> XML
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      {editing && (
        <TemplateEditor
          kind={kind}
          template={editing.template}
          initial={editing.initial}
          sample={SAMPLE[kind]}
          onClose={() => setEditing(null)}
          onSaved={(id) => {
            setEditing(null);
            if (id) {
              try {
                localStorage.setItem(`fqp.print.${kind}`, JSON.stringify({ id, dx: 0, dy: 0 })); // 印刷のとき、いま作ったデザインが選ばれた状態にする
              } catch {
                /* 覚えられなくても使える */
              }
            }
            void load();
          }}
        />
      )}
    </>
  );
}
