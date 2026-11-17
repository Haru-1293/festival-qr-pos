import { useCallback, useState } from "react";
import { errorMessage } from "./api";

/** 送信中・エラー表示の共通処理。二重送信は pending の間だけ弾く */
export function useAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setPending(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(errorMessage(e));
      return undefined;
    } finally {
      setPending(false);
    }
  }, []);

  return { pending, error, setError, run };
}
