import { useEffect, useState } from "react";
import type { ImageStorageInfo } from "@shared/printDesign";
import { api } from "@/lib/api";

let cached: ImageStorageInfo | null = null;

/** 背景画像の保存先(R2か、D1に縮小して保存か)と上限。画面を開くたびには取りに行かない */
export function useImageStorage(): ImageStorageInfo | null {
  const [info, setInfo] = useState<ImageStorageInfo | null>(cached);
  useEffect(() => {
    if (cached) return;
    let alive = true;
    api<ImageStorageInfo>("/print-templates/storage")
      .then((r) => {
        cached = r;
        if (alive) setInfo(r);
      })
      .catch(() => alive && setInfo({ mode: "inline", maxBytes: 900_000 }));
    return () => {
      alive = false;
    };
  }, []);
  return info;
}
