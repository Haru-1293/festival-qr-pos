import { Copy, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { ShopOptions } from "@shared/api";
import { ErrorText } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { useAction } from "@/lib/useAction";

function Row({ id, title, desc, checked, onChange, disabled }: { id: string; title: string; desc: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <label htmlFor={id} className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-bold">{title}</span>
        <span className="text-xs text-muted-foreground">{desc}</span>
      </label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}

/** 店舗のオプション設定。注文ステータス(調理中・提供可能)と、お客様の呼び出しボード */
export function ShopSettings({ shopId }: { shopId: string }) {
  const [opts, setOpts] = useState<ShopOptions | null>(null);
  const [copied, setCopied] = useState(false);
  const save = useAction();
  useEffect(() => {
    api<{ options: ShopOptions }>(`/shops/${shopId}/options`).then((r) => setOpts(r.options)).catch(() => undefined);
  }, [shopId]);
  const update = (next: ShopOptions) => {
    const prev = opts;
    setOpts(next);
    void save.run(async () => {
      try {
        await api(`/shops/${shopId}/options`, { method: "PUT", body: next });
      } catch (e) {
        setOpts(prev);
        throw e;
      }
    });
  };
  const boardUrl = `${window.location.origin}/board/${shopId}`;
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>注文ステータスと呼び出し</CardTitle>
          <CardDescription>使うかどうかは店舗ごとに選べます。いつでもオン・オフを切り替えられます</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {opts === null ? (
            <p className="text-sm text-muted-foreground">読み込み中…</p>
          ) : (
            <>
              <Row
                id="opt-tracking"
                title="注文ステータスを使う"
                desc="支払いが済むたびに「調理中」の注文として並び、できあがったら「提供可能」にできます。お客様には呼び出し番号が表示されます"
                checked={opts.orderTracking}
                onChange={(v) => update({ orderTracking: v, callBoard: v ? opts.callBoard : false })}
              />
              <Row
                id="opt-board"
                title="呼び出しボードを使う"
                desc="店頭のモニターに「できあがりの番号」を大きく表示します(ログイン不要の画面)"
                checked={opts.callBoard}
                disabled={!opts.orderTracking}
                onChange={(v) => update({ ...opts, callBoard: v })}
              />
            </>
          )}
          <ErrorText message={save.error} />
        </CardContent>
      </Card>
      {opts?.callBoard && (
        <Card>
          <CardHeader>
            <CardTitle>呼び出しボードの画面</CardTitle>
            <CardDescription>店頭のモニターやタブレットでこのアドレスを開いてください。ログインは要りません</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="break-all rounded-lg bg-muted px-3 py-2 font-mono text-xs">{boardUrl}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  void navigator.clipboard?.writeText(boardUrl).then(() => {
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 2000);
                  });
                }}
              >
                <Copy /> {copied ? "コピーしました" : "アドレスをコピー"}
              </Button>
              <Button asChild variant="outline">
                <Link to={`/board/${shopId}`} target="_blank" rel="noreferrer">
                  <ExternalLink /> 開く
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
