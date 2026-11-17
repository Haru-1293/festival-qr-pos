import { Shell } from "@/components/Shell";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/lib/auth";
import { StaffManager } from "./StaffManager";

export function ShopManagerHome() {
  const { me } = useAuth();
  if (!me?.user.shopId) return null;
  return (
    <Shell title={me.user.shopName ?? "店舗"}>
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>店舗責任者メニュー</CardTitle>
            <CardDescription>商品・セット・在庫・売上・返金の画面は次の更新で追加されます。いまは店員の登録ができます。</CardDescription>
          </CardHeader>
        </Card>
        <StaffManager shopId={me.user.shopId} />
      </div>
    </Shell>
  );
}
