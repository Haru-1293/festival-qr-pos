import Editor from "@toast-ui/editor";
import "@toast-ui/editor/dist/toastui-editor.css";
import "@toast-ui/editor/dist/i18n/ja-jp";
import { useEffect, useRef } from "react";

export interface MarkdownEditorHandle {
  getMarkdown: () => string;
  setMarkdown: (md: string) => void;
}

/**
 * Toast UI Editor(日本語)。本文は Markdown で読み書きする。
 * 画面のフォントは index.css で Noto Sans JP にそろえている。
 * `value` が変わったとき(版の切り替え・アップロード)だけ中身を置き換える。入力中の変更は onChange で親へ渡す。
 */
export function MarkdownEditor({ value, onChange, handleRef }: { value: string; onChange: (md: string) => void; handleRef?: { current: MarkdownEditorHandle | null } }) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<Editor | null>(null);
  const changeRef = useRef(onChange);
  changeRef.current = onChange;

  useEffect(() => {
    if (!host.current) return;
    const ed = new Editor({
      el: host.current,
      height: "560px",
      initialEditType: "wysiwyg",
      previewStyle: "tab",
      language: "ja-JP",
      usageStatistics: false,
      hideModeSwitch: false,
      initialValue: value,
      placeholder: "ここに本文を書きます(見出し・リスト・表・リンクが使えます)",
      toolbarItems: [
        ["heading", "bold", "italic", "strike"],
        ["hr", "quote"],
        ["ul", "ol"],
        ["table", "link"],
        ["code"],
      ],
      events: { change: () => changeRef.current(ed.getMarkdown()) },
    });
    editor.current = ed;
    if (handleRef) handleRef.current = { getMarkdown: () => ed.getMarkdown(), setMarkdown: (md) => ed.setMarkdown(md, false) };
    return () => {
      ed.destroy();
      editor.current = null;
      if (handleRef) handleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const ed = editor.current;
    if (ed && ed.getMarkdown() !== value) ed.setMarkdown(value, false);
  }, [value]);

  return <div ref={host} className="overflow-hidden rounded-xl border border-border" />;
}
