import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export interface ConfirmOptions {
  title?: string;
  /** 実行ボタンの文言(既定「実行する」) */
  action?: string;
  /** 取り返しのつかない操作は赤いボタンにする */
  destructive?: boolean;
}
type Ask = (message: string, opts?: ConfirmOptions) => Promise<boolean>;

export interface PromptOptions {
  title?: string;
  defaultValue?: string;
  placeholder?: string;
  inputType?: "text" | "password" | "number";
  action?: string;
  /** true のとき、空のままでは実行できない */
  required?: boolean;
}
type PromptFn = (message: string, opts?: PromptOptions) => Promise<string | null>;
type NotifyFn = (message: string, title?: string) => Promise<void>;

const ConfirmContext = createContext<Ask | null>(null);
const PromptContext = createContext<PromptFn | null>(null);
const NotifyContext = createContext<NotifyFn | null>(null);

/** window.prompt の代わり。入力した文字列を返す(やめたら null) */
export function usePrompt(): PromptFn {
  const f = useContext(PromptContext);
  if (!f) throw new Error("ConfirmProvider の外では使えません");
  return f;
}

/** window.alert の代わり */
export function useNotify(): NotifyFn {
  const f = useContext(NotifyContext);
  if (!f) throw new Error("ConfirmProvider の外では使えません");
  return f;
}

/** window.confirm の代わり。`if (!(await confirm("…"))) return;` の形で使う */
export function useConfirm(): Ask {
  const ask = useContext(ConfirmContext);
  if (!ask) throw new Error("ConfirmProvider の外では使えません");
  return ask;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ message: string; opts: ConfirmOptions } | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const ask = useCallback<Ask>((message, opts = {}) => {
    // すでに開いている確認があれば、キャンセル扱いで閉じてから新しいものを出す
    resolver.current?.(false);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      setState({ message, opts });
    });
  }, []);

  // 入力ダイアログ
  const [prompt, setPrompt] = useState<{ message: string; opts: PromptOptions; value: string } | null>(null);
  const promptResolver = useRef<((v: string | null) => void) | null>(null);
  const askPrompt = useCallback<PromptFn>((message, opts = {}) => {
    promptResolver.current?.(null);
    return new Promise<string | null>((resolve) => {
      promptResolver.current = resolve;
      setPrompt({ message, opts, value: opts.defaultValue ?? "" });
    });
  }, []);
  const settlePrompt = (v: string | null) => {
    promptResolver.current?.(v);
    promptResolver.current = null;
    setPrompt(null);
  };

  // お知らせダイアログ
  const [note, setNote] = useState<{ message: string; title: string } | null>(null);
  const noteResolver = useRef<(() => void) | null>(null);
  const notify = useCallback<NotifyFn>((message, title = "お知らせ") => {
    noteResolver.current?.();
    return new Promise<void>((resolve) => {
      noteResolver.current = resolve;
      setNote({ message, title });
    });
  }, []);
  const closeNote = () => {
    noteResolver.current?.();
    noteResolver.current = null;
    setNote(null);
  };

  const settle = (ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setState(null);
  };

  return (
    <ConfirmContext.Provider value={ask}>
      <PromptContext.Provider value={askPrompt}>
      <NotifyContext.Provider value={notify}>
      {children}
      <Dialog open={prompt !== null} onOpenChange={(open) => !open && settlePrompt(null)}>
        <DialogContent hideClose>
          <DialogTitle>{prompt?.opts.title ?? "入力"}</DialogTitle>
          <DialogDescription className="whitespace-pre-line">{prompt?.message}</DialogDescription>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (prompt && (!prompt.opts.required || prompt.value.trim())) settlePrompt(prompt.value);
            }}
          >
            <Input
              autoFocus
              type={prompt?.opts.inputType ?? "text"}
              inputMode={prompt?.opts.inputType === "number" ? "numeric" : undefined}
              value={prompt?.value ?? ""}
              placeholder={prompt?.opts.placeholder}
              autoComplete="off"
              onChange={(e) => setPrompt((p) => (p ? { ...p, value: e.target.value } : p))}
            />
            <div className="flex gap-2">
              <Button type="button" variant="outline" className="flex-1" onClick={() => settlePrompt(null)}>
                やめる
              </Button>
              <Button type="submit" className="flex-1" disabled={!!prompt?.opts.required && !prompt.value.trim()}>
                {prompt?.opts.action ?? "決定"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={note !== null} onOpenChange={(open) => !open && closeNote()}>
        <DialogContent hideClose>
          <DialogTitle>{note?.title}</DialogTitle>
          <DialogDescription className="whitespace-pre-line">{note?.message}</DialogDescription>
          <Button onClick={closeNote}>OK</Button>
        </DialogContent>
      </Dialog>
      <AlertDialog open={state !== null} onOpenChange={(open) => !open && settle(false)}>
        <AlertDialogContent>
          <AlertDialogTitle>{state?.opts.title ?? "確認"}</AlertDialogTitle>
          <AlertDialogDescription>{state?.message}</AlertDialogDescription>
          <div className="flex gap-2">
            <AlertDialogCancel>やめる</AlertDialogCancel>
            <AlertDialogAction variant={state?.opts.destructive ? "destructive" : "default"} onClick={() => settle(true)}>
              {state?.opts.action ?? "実行する"}
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>
      </NotifyContext.Provider>
      </PromptContext.Provider>
    </ConfirmContext.Provider>
  );
}
