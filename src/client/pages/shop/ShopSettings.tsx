import { Copy, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { ShopNameHistoryItem, ShopOptions } from "@shared/api";
import { ErrorText } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/lib/auth";
import { useConfirm } from "@/lib/confirm";
import { formatDateTime } from "@/lib/utils";
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

/** 店舗名の変更(店舗責任者・全体管理者)。変更しても過去の注文・ログは同じ店舗のまま、その時点の名前で見られる */
function ShopNameCard({ shopId }: { shopId: string }) {
  const { refresh, me } = useAuth();
  const confirm = useConfirm();
  const [current, setCurrent] = useState("");
  const [name, setName] = useState("");
  const [history, setHistory] = useState<ShopNameHistoryItem[]>([]);
  const act = useAction();
  const load = () =>
    api<{ displayName: string; history: ShopNameHistoryItem[] }>(`/shops/${shopId}/name`)
      .then((r) => {
        setCurrent(r.displayName);
        setName(r.displayName);
        setHistory(r.history);
      })
      .catch(() => undefined);
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shopId]);
  const next = name.trim();
  const submit = async () => {
    if (!(await confirm(`店舗名を「${current}」から「${next}」に変更しますか?\n過去の注文や履歴は、そのまま同じ店舗として残ります。`))) return;
    await act.run(async () => {
      await api(`/shops/${shopId}/rename`, { body: { displayName: next } });
      await load();
      if (me?.user.shopId === shopId) await refresh();
    });
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>店舗名</CardTitle>
        <CardDescription>お客様の画面・呼び出しボード・レシートに出る名前です。変更しても、過去の注文や監査ログは同じ店舗として引き継がれ、当時の名前で表示されます</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={50} aria-label="店舗名" className="w-full max-w-xs" />
          <Button type="submit" disabled={act.pending || next === "" || next === current}>
            名前を変更
          </Button>
        </form>
        <ErrorText message={act.error} />
        {history.length > 1 && (
          <div className="flex flex-col gap-1">
            <p className="text-xs font-bold text-muted-foreground">店舗名の履歴</p>
            <ul className="flex flex-col gap-0.5 text-sm">
              {history.map((h, i) => (
                <li key={`${h.validFrom}-${i}`} className="flex flex-wrap justify-between gap-2">
                  <span className={i === 0 ? "font-bold" : ""}>{h.displayName}</span>
                  <span className="text-xs text-muted-foreground">
                    {h.validFrom === 0 ? "最初の名前" : `${formatDateTime(h.validFrom)}${h.changedBy ? ` ・ ${h.changedBy}` : ""}`}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
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
      <ShopNameCard shopId={shopId} />
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
                onChange={(v) => update({ ...opts, orderTracking: v, callBoard: v ? opts.callBoard : false })}
              />
              <div className="flex flex-col gap-2">
                <span className="text-sm font-bold">呼び出し番号の付け方</span>
                <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="呼び出し番号の付け方">
                  {([
                    ["AUTO", "自動で番号を振る", "支払いのたびに 1〜99 を順に振ります(お客様のスマホとボードに出ます)"],
                    ["TAG", "番号札を使う", "レジで店員が番号札の文字を入力します(半角の英数字・記号、8文字まで。例: 12、A5、B-3)。使用中の札は入力できません"],
                  ] as const).map(([v, t, d]) => (
                    <button
                      key={v}
                      type="button"
                      role="radio"
                      aria-checked={opts.callMode === v}
                      disabled={!opts.orderTracking}
                      onClick={() => update({ ...opts, callMode: v })}
                      className={`flex flex-col items-start gap-0.5 rounded-xl border-2 px-3 py-2 text-left disabled:opacity-50 ${opts.callMode === v ? "border-primary bg-secondary" : "border-border"}`}
                    >
                      <span className="text-sm font-bold">{t}</span>
                      <span className="text-xs text-muted-foreground">{d}</span>
                    </button>
                  ))}
                </div>
              </div>
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
