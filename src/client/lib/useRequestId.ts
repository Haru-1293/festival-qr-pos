import { useCallback, useRef } from "react";
import { newRequestId } from "./utils";

/**
 * 1つの操作(チャージ・払戻し・訂正など)に対するリクエストID。
 * 通信エラーで結果が分からないときの再送には同じIDを使い、成功したら renew() で次の操作用に作り直す。
 * サーバーは同じIDの再送では新しい取引を作らず、元の結果を返す。
 */
export function useRequestId() {
  const ref = useRef<string | null>(null);
  const get = useCallback(() => (ref.current ??= newRequestId()), []);
  const renew = useCallback(() => {
    ref.current = null;
  }, []);
  return { get, renew };
}
