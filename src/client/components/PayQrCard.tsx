import { QrCode, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { WalletQrResponse } from "@shared/api";
import { QrCodeView } from "@/components/QrCodeView";
import { ErrorText } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction } from "@/lib/useAction";

/**
 * お客様の「提示用QR」。受付(チャージ・払戻し)や店舗の支払いで、スタッフに読み取ってもらう。
 * 有効期間は設定値(既定5分)。新しく作ると前のQRは使えなくなり、読み取られたQRは1回で使えなくなる。
 */
export function PayQrCard({ disabled }: { disabled: boolean }) {
  const { refresh } = useAuth();
  const [qr, setQr] = useState<{ data: WalletQrResponse; shownAt: number } | null>(null);
  const [now, setNow] = useState(Date.now());
  const { pending, error, run } = useAction();

  // 残り時間は、受け取った時点からの経過で数える(端末の時計がずれていても正しく表示するため)
  useEffect(() => {
    if (!qr) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [qr]);

  // QRを表示している間は、受付で残高が変わったことに気づけるよう残高を定期的に更新する
  useEffect(() => {
    if (!qr) return;
    const t = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(t);
  }, [qr, refresh]);

  const remaining = qr ? Math.max(0, qr.data.ttlSeconds - Math.floor((now - qr.shownAt) / 1000)) : 0;
  const expired = qr !== null && remaining === 0;
  const mmss = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`;

  const create = () =>
    void run(async () => {
      const data = await api<WalletQrResponse>("/wallet/qr", { body: {} });
      setQr({ data, shownAt: Date.now() });
      setNow(Date.now());
    });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <QrCode className="size-5" /> 提示用QR
        </CardTitle>
        <CardDescription>チャージ・払い戻し・お支払いのときに、スタッフに読み取ってもらってください。</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col items-center gap-3">
        {qr && !expired ? (
          <>
            <QrCodeView value={qr.data.token} size={240} />
            <p className="text-sm text-muted-foreground">
              有効時間 <span className={`font-bold tabular-nums ${remaining <= 30 ? "text-destructive" : "text-foreground"}`}>{mmss}</span>
            </p>
            <p className="text-center text-xs text-muted-foreground">読み取られたQRは使えなくなります。もう一度必要なときは作り直してください。</p>
          </>
        ) : (
          expired && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800">有効期限が切れました。作り直してください</p>
        )}
        <ErrorText message={error} />
        <Button size="lg" className="w-full" onClick={create} disabled={pending || disabled} variant={qr && !expired ? "outline" : "default"}>
          {qr ? <RefreshCw /> : <QrCode />}
          {pending ? "作成中…" : qr ? "QRを作り直す" : "QRを表示する"}
        </Button>
        {disabled && <p className="text-xs text-muted-foreground">ご利用が停止されているため表示できません。受付にお問い合わせください。</p>}
      </CardContent>
    </Card>
  );
}
