import { ActiveOrdersCard } from "@/components/ActiveOrdersCard";
import { HistoryCard } from "@/components/HistoryCard";
import { PayQrCard } from "@/components/PayQrCard";
import { Shell } from "@/components/Shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { useAuth } from "@/lib/auth";
import { formatDateTime } from "@/lib/utils";

/** 顧客のマイページ(残高・支払いQR・履歴)。スマホで使う前提の1カラム */
export function CustomerHome() {
  const { me, money, settings } = useAuth();
  if (!me) return null;
  const w = me.wallet;
  const now = Date.now();
  const expired = !!w?.expiresAt && w.expiresAt <= now;
  const daysLeft = w?.expiresAt && !expired ? Math.ceil((w.expiresAt - now) / 86400000) : null;
  return (
    <Shell title="ホーム">
      <div className="flex flex-col gap-4">
        <Card className="overflow-hidden">
          <div className="bg-secondary px-4 py-5">
            <p className="text-sm text-secondary-foreground">{me.user.nickname} さんの残高</p>
            <p className="mt-1 text-4xl font-extrabold tracking-tight">{w ? money(w.balance) : "—"}</p>
            {w?.status === "SUSPENDED" && (
              <Badge variant="warning" className="mt-2">
                利用停止中です。受付にお問い合わせください
              </Badge>
            )}
            {expired && (
              <Badge variant="warning" className="mt-2 h-auto whitespace-normal py-1">
                有効期限が切れたため、お支払いにはご利用できません。残高は受付で払い戻しできます
              </Badge>
            )}
            {w?.expiresAt && !expired && (
              <p className={`mt-2 text-xs ${daysLeft !== null && daysLeft <= 7 ? "font-semibold text-destructive" : "text-muted-foreground"}`}>
                有効期限: {formatDateTime(w.expiresAt)}
                {daysLeft !== null && daysLeft <= 7 && `(あと${daysLeft}日。残高は期限までにお使いください)`}
              </p>
            )}
            {expired && w?.expiresAt && <p className="mt-2 text-xs text-muted-foreground">有効期限: {formatDateTime(w.expiresAt)}</p>}
          </div>
          <CardContent className="text-sm text-muted-foreground">{settings.currency.description}</CardContent>
        </Card>
        <ActiveOrdersCard />
        <PayQrCard disabled={w?.status !== "ACTIVE" || expired} />
        <HistoryCard balance={w?.balance} />
      </div>
    </Shell>
  );
}
