import { useCallback, useEffect, useRef, useState } from "react";
import type { CatalogResponse } from "@shared/api";
import { api } from "./api";

type Full = Extract<CatalogResponse, { changed: true }>;

/**
 * POS 用の商品一覧。数秒おきに店舗の「署名」を確認し、変わっていたら取り直す。
 * 値下げ・売り切れ・価格変更が、画面を開いたままでも反映される(仕様 v0.3 §1.12)。
 * 回線が切れても、最後に取得できた一覧は表示し続ける(`offline` で状態だけ知らせる)。
 */
export function useCatalog(shopId: string | null, intervalMs = 3000) {
  const [catalog, setCatalog] = useState<Full | null>(null);
  const [offline, setOffline] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const sig = useRef<string | undefined>(undefined);
  const busy = useRef(false);

  const refresh = useCallback(async () => {
    if (!shopId || busy.current) return;
    busy.current = true;
    try {
      const q = sig.current ? `?sig=${encodeURIComponent(sig.current)}` : "";
      const r = await api<CatalogResponse>(`/pos/${shopId}/catalog${q}`);
      sig.current = r.signature;
      if (r.changed) {
        setCatalog(r);
        setUpdatedAt(Date.now());
      }
      setOffline(false);
    } catch {
      setOffline(true);
    } finally {
      busy.current = false;
    }
  }, [shopId]);

  useEffect(() => {
    sig.current = undefined;
    setCatalog(null);
    void refresh();
    const t = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, intervalMs);
    const onVisible = () => document.visibilityState === "visible" && void refresh();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    return () => {
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
    };
  }, [refresh, intervalMs]);

  return { catalog, offline, updatedAt, refresh };
}
