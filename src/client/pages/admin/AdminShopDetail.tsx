import { useParams } from "react-router-dom";
import { ShopDetailView } from "@/pages/shop/ShopDetailView";

/** 全体管理者が店舗を選んで見る、店舗別の売上・取引履歴 */
export function AdminShopDetail() {
  const { shopId = "" } = useParams();
  return <ShopDetailView shopId={shopId} backTo="/admin/shops" />;
}
