import { useCallback, useState } from "react";

/** 端末に覚えておく小さな設定(画面の開閉など)。保存できない環境でも動く */
export function useLocalStorage<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        window.localStorage.setItem(key, JSON.stringify(v));
      } catch {
        /* 保存できなくても今の画面では使える */
      }
    },
    [key],
  );
  return [value, set];
}
