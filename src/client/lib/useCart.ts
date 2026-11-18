import { useCallback, useEffect, useState } from "react";

export type Cart = Record<string, number>;

const MAX_QTY = 99;

function load(key: string): Cart {
  try {
    const raw = window.localStorage.getItem(key);
    const v = raw ? (JSON.parse(raw) as Cart) : {};
    return Object.fromEntries(Object.entries(v).filter(([, q]) => Number.isInteger(q) && q > 0 && q <= MAX_QTY));
  } catch {
    return {};
  }
}

/**
 * レジのカート。再読み込みや通信断でも消えないよう、端末のブラウザに保存する(保存できない環境でも動く)。
 * 価格は保存しない(数量だけ)。価格は常に、いまの商品一覧とサーバーの見積もりで決まる。
 */
export function useCart(shopId: string) {
  const key = `festival-pos-cart:${shopId}`;
  const [cart, setCart] = useState<Cart>(() => load(key));

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(cart));
    } catch {
      /* 保存できなくても、メモリ上のカートで続けられる */
    }
  }, [key, cart]);

  const add = useCallback((id: string, by = 1) => {
    setCart((c) => {
      const q = Math.min(MAX_QTY, (c[id] ?? 0) + by);
      const next = { ...c };
      if (q <= 0) delete next[id];
      else next[id] = q;
      return next;
    });
  }, []);
  const remove = useCallback((id: string) => {
    setCart((c) => {
      const next = { ...c };
      delete next[id];
      return next;
    });
  }, []);
  const clear = useCallback(() => setCart({}), []);

  return { cart, add, remove, clear };
}
