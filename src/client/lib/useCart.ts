import { useCallback, useEffect, useState } from "react";
import type { CartItemInput } from "@shared/api";

/** カートの1行。単品(productId)か、内訳を選んだセット(setId + picks)。数量以外の価格情報は持たない */
export interface CartLine {
  key: string;
  productId?: string;
  setId?: string;
  picks?: Record<string, string[]>;
  quantity: number;
}
export type Cart = CartLine[];

const MAX_QTY = 99;

/** 同じ商品・同じ選び方なら同じキーにして、数量をまとめる */
export function cartKey(i: { productId?: string; setId?: string; picks?: Record<string, string[]> }): string {
  if (i.setId) {
    const p = Object.keys(i.picks ?? {})
      .sort()
      .map((k) => `${k}=${[...(i.picks![k] ?? [])].sort().join(",")}`)
      .join(";");
    return `s:${i.setId}:${p}`;
  }
  return `p:${i.productId}`;
}

export const toCartItems = (cart: Cart): CartItemInput[] =>
  cart.map((l) => (l.setId ? { setId: l.setId, picks: l.picks, quantity: l.quantity } : { productId: l.productId, quantity: l.quantity }));

function load(key: string): Cart {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const v = JSON.parse(raw) as unknown;
    // 旧形式(商品ID → 数量)からの移行
    const lines: CartLine[] = Array.isArray(v)
      ? (v as CartLine[])
      : Object.entries(v as Record<string, number>).map(([id, q]) => ({ key: `p:${id}`, productId: id, quantity: q }));
    return lines.filter((l) => l && typeof l.key === "string" && Number.isInteger(l.quantity) && l.quantity > 0 && l.quantity <= MAX_QTY && (l.productId || l.setId));
  } catch {
    return [];
  }
}

/**
 * レジのカート。再読み込みや通信断でも消えないよう、端末のブラウザに保存する(保存できない環境でも動く)。
 * 価格は保存しない(数量と選んだ内訳だけ)。価格は常に、いまの商品一覧とサーバーの見積もりで決まる。
 */
export function useCart(shopId: string) {
  const storageKey = `festival-pos-cart:${shopId}`;
  const [cart, setCart] = useState<Cart>(() => load(storageKey));

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(cart));
    } catch {
      /* 保存できなくても、メモリ上のカートで続けられる */
    }
  }, [storageKey, cart]);

  const add = useCallback((item: { productId?: string; setId?: string; picks?: Record<string, string[]> }, by = 1) => {
    const key = cartKey(item);
    setCart((c) => {
      const cur = c.find((l) => l.key === key);
      if (!cur) return by > 0 ? [...c, { key, ...item, quantity: Math.min(MAX_QTY, by) }] : c;
      const q = Math.min(MAX_QTY, cur.quantity + by);
      return q <= 0 ? c.filter((l) => l.key !== key) : c.map((l) => (l.key === key ? { ...l, quantity: q } : l));
    });
  }, []);
  const change = useCallback((key: string, by: number) => {
    setCart((c) =>
      c.flatMap((l) => {
        if (l.key !== key) return [l];
        const q = Math.min(MAX_QTY, l.quantity + by);
        return q <= 0 ? [] : [{ ...l, quantity: q }];
      }),
    );
  }, []);
  const remove = useCallback((key: string) => setCart((c) => c.filter((l) => l.key !== key)), []);
  const clear = useCallback(() => setCart([]), []);

  return { cart, add, change, remove, clear };
}
