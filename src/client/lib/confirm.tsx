import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
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

const ConfirmContext = createContext<Ask | null>(null);

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

  const settle = (ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setState(null);
  };

  return (
    <ConfirmContext.Provider value={ask}>
      {children}
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
    </ConfirmContext.Provider>
  );
}
