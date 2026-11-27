import { ImagePlus, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { dataUrlToBlob, imageToDataUrl } from "@/components/print/imageUtil";

/** 画像の状態。url は保存済みの画像URLまたは選んだばかりの data URL。changed=false なら保存時に画像は触らない */
export interface MenuImageState {
  url: string | null;
  changed: boolean;
}
export const imageFrom = (url: string | null | undefined): MenuImageState => ({ url: url ?? null, changed: false });

/** 保存時に呼ぶ。imageKey に入れる値を返す(undefined=変えない、null=外す、文字列=アップロードしたキー) */
export async function resolveImageKey(shopId: string, img: MenuImageState): Promise<string | null | undefined> {
  if (!img.changed) return undefined;
  if (!img.url) return null;
  const blob = dataUrlToBlob(img.url);
  const r = await api<{ key: string }>(`/catalog/${shopId}/menu-images`, { body: blob });
  return r.key;
}

/** メニュー画像の選択・変更・削除。選んだ画像は縮小して手元に持ち、保存ボタンでアップロードする */
export function MenuImagePicker({ value, onChange }: { value: MenuImageState; onChange: (v: MenuImageState) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const pick = async (f: File | undefined) => {
    if (!f) return;
    setError(null);
    try {
      onChange({ url: await imageToDataUrl(f, 700_000), changed: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : "画像を読み込めませんでした");
    }
  };
  return (
    <div className="flex items-center gap-3">
      <div className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border bg-muted">
        {value.url ? <img src={value.url} alt="メニュー画像" className="size-full object-cover" /> : <ImagePlus className="size-6 text-muted-foreground" />}
      </div>
      <div className="flex flex-col items-start gap-1">
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => input.current?.click()}>
            {value.url ? "画像を変更" : "画像を追加"}
          </Button>
          {value.url && (
            <Button type="button" variant="ghost" size="sm" onClick={() => onChange({ url: null, changed: true })}>
              <Trash2 className="!size-4" /> 外す
            </Button>
          )}
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ""; }} />
      </div>
    </div>
  );
}
