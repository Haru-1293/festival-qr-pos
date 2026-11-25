import { FileText, Upload } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { LEGAL_LABEL, type LegalDocumentDto, type LegalKind, type LegalVersionItem } from "@shared/api";
import { MarkdownView } from "@/components/MarkdownView";
import { ErrorText } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import { useConfirm } from "@/lib/confirm";
import { useAction } from "@/lib/useAction";
import { formatDateTime } from "@/lib/utils";

const MarkdownEditor = lazy(() => import("@/components/MarkdownEditor").then((m) => ({ default: m.MarkdownEditor })));

const MAX_CHARS = 100_000;

function LegalEditor({ kind }: { kind: LegalKind }) {
  const confirm = useConfirm();
  const [saved, setSaved] = useState<LegalDocumentDto | null>(null);
  const [versions, setVersions] = useState<LegalVersionItem[]>([]);
  const [text, setText] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [preview, setPreview] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const act = useAction();

  const load = useCallback(async () => {
    const r = await api<{ document: LegalDocumentDto | null; versions: LegalVersionItem[] }>(`/admin/system/legal/${kind}`);
    setSaved(r.document);
    setVersions(r.versions);
    setText(r.document?.bodyMd ?? "");
    setLoaded(true);
  }, [kind]);

  useEffect(() => {
    setLoaded(false);
    setNote(null);
    act.setError(null);
    load().catch((e) => act.setError(e instanceof Error ? e.message : "読み込めませんでした"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const dirty = text !== (saved?.bodyMd ?? "");

  const save = () =>
    act.run(async () => {
      if (!(await confirm(`${LEGAL_LABEL[kind]}を新しい版として公開します。これ以降に登録する利用者は、この版に同意することになります。`, { action: "公開する" }))) return;
      const r = await api<{ document: LegalDocumentDto }>(`/admin/system/legal/${kind}`, { method: "PUT", body: { bodyMd: text } });
      setNote(`第${r.document.version}版として保存しました`);
      await load();
    });

  const upload = async (f: File | undefined) => {
    if (!f) return;
    act.setError(null);
    if (!/\.(md|markdown|txt)$/i.test(f.name)) return act.setError("Markdown(.md)のファイルを選んでください");
    if (f.size > 400_000) return act.setError("ファイルが大きすぎます(400KBまで)");
    const body = (await f.text()).replace(/^﻿/, "").replace(/\r\n/g, "\n");
    if (body.trim().length === 0) return act.setError("ファイルが空です");
    if (body.length > MAX_CHARS) return act.setError(`本文は${MAX_CHARS.toLocaleString()}文字以内にしてください`);
    // いま編集中の内容(未保存を含む)があるときは、上書きしてよいか確認する
    if (text.trim() !== "" && !(await confirm(`いまの本文(${text.length.toLocaleString()}文字)を「${f.name}」の内容で上書きします。保存するまで公開はされません。よろしいですか?`, { title: "上書きの確認", action: "上書きする", destructive: true }))) return;
    setText(body);
    setNote(`「${f.name}」を読み込みました。内容を確認して「公開する」を押してください`);
  };

  const viewVersion = async (v: number) => {
    await act.run(async () => {
      const r = await api<{ document: LegalDocumentDto }>(`/admin/system/legal/${kind}/${v}`);
      if (dirty && !(await confirm("編集中の内容を、この版の内容で置き換えます。よろしいですか?", { action: "置き換える", destructive: true }))) return;
      setText(r.document.bodyMd);
      setNote(`第${v}版を読み込みました(保存すると新しい版になります)`);
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => file.current?.click()}>
          <Upload className="!size-4" /> mdをアップロード
        </Button>
        <input ref={file} type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" hidden onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ""; }} />
        <Button variant="outline" size="sm" onClick={() => setPreview((p) => !p)}>
          <FileText className="!size-4" /> {preview ? "編集に戻る" : "利用者への見え方"}
        </Button>
        <span className="ml-auto text-xs text-muted-foreground">
          {saved ? `公開中: 第${saved.version}版(${formatDateTime(saved.createdAt)})` : "まだ公開していません"}
        </span>
      </div>
      {!loaded ? (
        <p className="text-sm text-muted-foreground">読み込み中…</p>
      ) : preview ? (
        <div className="rounded-xl border border-border bg-card p-4">{text.trim() ? <MarkdownView source={text} /> : <p className="text-sm text-muted-foreground">本文が空です</p>}</div>
      ) : (
        <Suspense fallback={<p className="text-sm text-muted-foreground">エディタを読み込み中…</p>}>
          <MarkdownEditor value={text} onChange={setText} />
        </Suspense>
      )}
      <p className="text-xs text-muted-foreground">
        {text.length.toLocaleString()} / {MAX_CHARS.toLocaleString()}文字 ・ 保存のたびに新しい版になり、古い版も残ります。HTMLタグは表示されません。
      </p>
      {note && <p className="text-sm font-medium text-secondary-foreground">{note}</p>}
      <ErrorText message={act.error} />
      <Button disabled={act.pending || !dirty || text.trim() === ""} onClick={() => void save()}>
        {dirty ? "公開する(新しい版として保存)" : "変更はありません"}
      </Button>
      {versions.length > 1 && (
        <details className="rounded-xl border border-border p-3 text-sm">
          <summary className="cursor-pointer font-semibold">過去の版</summary>
          <ul className="mt-2 flex flex-col gap-1">
            {versions.map((v) => (
              <li key={v.version} className="flex items-center justify-between gap-2">
                <span>
                  第{v.version}版 ・ {formatDateTime(v.createdAt)} ・ {v.chars.toLocaleString()}文字
                </span>
                <Button variant="ghost" size="sm" onClick={() => void viewVersion(v.version)}>
                  編集欄に読み込む
                </Button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** 利用規約・プライバシーポリシーの編集(全体管理者) */
export function AdminLegal() {
  const [kind, setKind] = useState<LegalKind>("TERMS");
  return (
    <Card>
      <CardHeader>
        <CardTitle>利用規約・プライバシーポリシー</CardTitle>
        <CardDescription>
          公開すると、トップの案内(/terms と /privacy)と新規登録の同意に使われます。本文は、この画面のエディタで書くか、Markdownファイルをアップロードして用意します。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Tabs value={kind} onValueChange={(v) => setKind(v as LegalKind)}>
          <TabsList>
            <TabsTrigger value="TERMS">{LEGAL_LABEL.TERMS}</TabsTrigger>
            <TabsTrigger value="PRIVACY">{LEGAL_LABEL.PRIVACY}</TabsTrigger>
          </TabsList>
        </Tabs>
        <LegalEditor key={kind} kind={kind} />
      </CardContent>
    </Card>
  );
}
