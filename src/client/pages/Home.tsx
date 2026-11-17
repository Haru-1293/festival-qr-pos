import { Navigate } from "react-router-dom";
import { ROLE_LABELS } from "@shared/roles";
import { Shell } from "@/components/Shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/lib/auth";
import { formatDateTime } from "@/lib/utils";
import { AdminHome } from "./admin/AdminHome";
import { ShopManagerHome } from "./shop/ShopManagerHome";

function CustomerHome() {
  const { me, money, settings } = useAuth();
  if (!me) return null;
  const w = me.wallet;
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
            {w?.expiresAt && <p className="mt-2 text-xs text-muted-foreground">有効期限: {formatDateTime(w.expiresAt)}</p>}
          </div>
          <CardContent className="text-sm text-muted-foreground">{settings.currency.description}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>支払いQR・履歴</CardTitle>
            <CardDescription>QR決済と利用履歴は次の更新で追加されます。チャージは受付で行えます。</CardDescription>
          </CardHeader>
        </Card>
      </div>
    </Shell>
  );
}

/** 店員・受付担当者のホーム。POS会計・チャージ画面は順次追加するため、いまは案内のみ */
function StaffPlaceholder() {
  const { me } = useAuth();
  if (!me) return null;
  const isReception = me.user.role === "RECEPTION";
  return (
    <Shell title={isReception ? "受付" : "POS"}>
      <Card>
        <CardHeader>
          <CardTitle>
            {ROLE_LABELS[me.user.role]}としてログイン中
            {me.user.shopName && <span className="ml-2 text-sm font-normal text-muted-foreground">{me.user.shopName}</span>}
          </CardTitle>
          <CardDescription>
            {isReception
              ? "チャージ・払戻し・現金の締めの画面は次の更新で追加されます。交代するときは右上からログアウトしてください。"
              : "POS会計の画面は次の更新で追加されます。"}
          </CardDescription>
        </CardHeader>
      </Card>
    </Shell>
  );
}

export function HomePage() {
  const { me, loading } = useAuth();
  if (loading) return <div className="p-8 text-center text-sm text-muted-foreground">読み込み中…</div>;
  if (!me) return <Navigate to="/login" replace />;
  switch (me.user.role) {
    case "ADMIN":
      return <AdminHome />;
    case "SHOP_MANAGER":
      return <ShopManagerHome />;
    case "CLERK":
    case "RECEPTION":
      return <StaffPlaceholder />;
    case "CUSTOMER":
      return <CustomerHome />;
  }
}
