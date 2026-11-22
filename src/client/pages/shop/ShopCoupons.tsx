import type { CouponDto, CouponInput, ShopDto } from "@shared/api";
import { useCallback, useEffect, useState } from "react";
import { CouponForm, CouponList } from "@/components/CouponPanel";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";

/** 店舗責任者の店舗限定クーポン(作れる種類・設定は全体管理者と同じ。対象は自店舗だけ) */
export function ShopCoupons({ shopId }: { shopId: string }) {
  const { me } = useAuth();
  const [coupons, setCoupons] = useState<CouponDto[]>([]);
  const shop: ShopDto = { id: shopId, name: me?.user.shopName ?? "自店舗", displayName: me?.user.shopName ?? "自店舗", status: "ACTIVE", sortOrder: 0 };
  const load = useCallback(async () => {
    setCoupons((await api<{ coupons: CouponDto[] }>(`/shop-coupons/${shopId}`)).coupons);
  }, [shopId]);
  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <CouponForm shops={[shop]} fixedShop={shop} create={async (body: CouponInput) => (await api<{ codes: string[] }>(`/shop-coupons/${shopId}`, { body })).codes} onCreated={load} />
      <CouponList
        coupons={coupons}
        shops={[shop]}
        showShops={false}
        title="自店舗のクーポン"
        setStatus={async (id, status) => {
          await api(`/shop-coupons/${shopId}/${id}/status`, { body: { status } });
        }}
        onChanged={load}
      />
    </div>
  );
}
