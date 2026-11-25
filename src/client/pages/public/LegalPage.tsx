import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { LEGAL_LABEL, type LegalDocumentDto, type LegalKind } from "@shared/api";
import { MarkdownView } from "@/components/MarkdownView";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/utils";

/** 利用規約・プライバシーポリシーの公開ページ(未ログインでも読める) */
export function LegalPage({ kind }: { kind: LegalKind }) {
  const [doc, setDoc] = useState<LegalDocumentDto | null | undefined>(undefined);
  const [error, setError] = useState(false);
  useEffect(() => {
    setDoc(undefined);
    api<{ document: LegalDocumentDto | null }>(`/settings/legal/${kind}`)
      .then((r) => setDoc(r.document))
      .catch(() => setError(true));
  }, [kind]);
  const other: LegalKind = kind === "TERMS" ? "PRIVACY" : "TERMS";
  return (
    <div className="mx-auto min-h-full max-w-2xl px-4 py-8">
      <Link to="/" className="text-sm text-muted-foreground underline-offset-2 hover:underline">
        ← トップへ
      </Link>
      <h1 className="sr-only">{LEGAL_LABEL[kind]}</h1>
      <div className="mt-4 rounded-2xl border border-border bg-card p-5">
        {error ? (
          <p className="text-sm text-muted-foreground">読み込めませんでした。時間をおいてもう一度お試しください。</p>
        ) : doc === undefined ? (
          <p className="text-sm text-muted-foreground">読み込み中…</p>
        ) : doc === null ? (
          <p className="text-sm text-muted-foreground">{LEGAL_LABEL[kind]}は準備中です。</p>
        ) : (
          <>
            <MarkdownView source={doc.bodyMd} />
            <p className="mt-6 text-xs text-muted-foreground">
              第{doc.version}版 ・ {formatDateTime(doc.createdAt)} 改定
            </p>
          </>
        )}
      </div>
      <p className="mt-4 text-center text-sm">
        <Link to={other === "TERMS" ? "/terms" : "/privacy"} className="text-muted-foreground underline-offset-2 hover:underline">
          {LEGAL_LABEL[other]}を見る
        </Link>
      </p>
    </div>
  );
}
