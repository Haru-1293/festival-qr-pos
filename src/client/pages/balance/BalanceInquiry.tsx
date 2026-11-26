import { ScanLine, Search } from "lucide-react";
import { useCallback, useState } from "react";
import type { BalanceInquiry as BalanceResult, CardStatus } from "@shared/api";
import { QrScanner, scannerSupported } from "@/components/QrScanner";
import { ErrorText } from "@/components/Shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { expectQr } from "@/lib/qrKind";
import { useAction } from "@/lib/useAction";
import { formatDateTime } from "@/lib/utils";

const STATUS_LABEL: Record<CardStatus, string> = { ISSUED: "未有効", ACTIVE: "利用可能", SUSPENDED: "一時停止中", EXPIRED: "期限切れ", DELETED: "削除済み" };

/** カードのQRを読み取って、残高を確認する(店員・店舗責任者・全体管理者)。読み取るだけで何も変わらない */
export function BalanceInquiry() {
  const { money } = useAuth();
  const [scanning, setScanning] = useState(false);
  const [token, setToken] = useState("");
  const [result, setResult] = useState<BalanceResult | null>(null);
  const look = useAction();

  const inquire = useCallback(
    (value: string) => {
      setResult(null);
      void look.run(async () => {
        setResult(await api<BalanceResult>("/balance/inquiry", { body: { token: value.trim() } }));
        setToken("");
      });
    },
    [look],
  );

  const status = result ? (result.expired && result.status !== "DELETED" ? "EXPIRED" : result.status) : null;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>カードの残高を調べる</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {scanning && (
            <QrScanner
              accept={expectQr(["CARD_OR_CLERK"], "お客様のカード")}
              onScan={(v) => {
                setScanning(false);
                inquire(v);
              }}
              onClose={() => setScanning(false)}
            />
          )}
          <p className="text-sm text-muted-foreground">お客様のカードのQRを読み取ると、残高が表示されます。読み取っても、カードの残高や状態は変わりません。</p>
          <Button size="lg" className="h-16 text-lg" onClick={() => setScanning(true)} disabled={look.pending || !scannerSupported()}>
            <ScanLine className="!size-6" /> カードを読み取る
          </Button>
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">{scannerSupported() ? "読み取れないとき(文字列を入力)" : "カメラが使えない端末です(文字列を入力)"}</summary>
            <form
              className="mt-2 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                inquire(token);
              }}
            >
              <Input value={token} onChange={(e) => setToken(e.target.value)} placeholder="FES1:C:…" autoCapitalize="none" autoCorrect="off" />
              <Button type="submit" variant="outline" disabled={look.pending || !token.trim()}>
                <Search /> 照会
              </Button>
            </form>
          </details>
          <ErrorText message={look.error} />
        </CardContent>
      </Card>

      {result && status && (
        <Card className="overflow-hidden">
          <div className="bg-secondary px-4 py-4">
            <div className="flex items-center justify-between gap-2">
              <p className="truncate text-base font-bold">
                {result.nickname ?? "(未設定)"}
                <span className="ml-2 text-xs font-medium text-muted-foreground">カード {result.displayNo}</span>
              </p>
              <Badge variant={status === "ACTIVE" ? "default" : "warning"}>{STATUS_LABEL[status]}</Badge>
            </div>
            <p className="mt-1 text-sm text-secondary-foreground">現在の残高</p>
            <p className="text-4xl font-extrabold tracking-tight">{money(result.balance)}</p>
          </div>
          <CardContent className="flex flex-col gap-2 pt-4 text-sm">
            <Line label="有効期限" value={result.expiresAt ? formatDateTime(result.expiresAt) : "なし"} />
            <Line label="最後に使った日時" value={result.lastUsedAt ? formatDateTime(result.lastUsedAt) : "まだ使っていません"} />
            {status !== "ACTIVE" && <p className="rounded-lg bg-amber-50 px-3 py-2 font-medium text-amber-900">このカードは今は支払いに使えません。受付にご案内ください。</p>}
            <Button variant="outline" onClick={() => setResult(null)}>
              閉じる
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border pb-2 last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-semibold">{value}</span>
    </div>
  );
}
