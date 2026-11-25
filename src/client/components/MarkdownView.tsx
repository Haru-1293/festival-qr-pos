import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Markdown の表示。HTML は解釈しない(react-markdown の既定)ので、管理者が書いた本文でも安全。リンクは別タブで開く */
export function MarkdownView({ source }: { source: string }) {
  return (
    <div className="legal-doc">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
