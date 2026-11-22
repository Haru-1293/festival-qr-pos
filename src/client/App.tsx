import { BarChart3, Banknote, Boxes, Calculator, ChefHat, CreditCard, HandCoins, Layers, Package, Percent, ScrollText, Settings, Store, Tag, Undo2, Users, UsersRound, Wallet } from "lucide-react";
import type { ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { ConsoleLayout, Page, type NavItem } from "@/components/layout/ConsoleLayout";
import { RoleGate } from "@/components/layout/RoleGate";
import { AuthProvider, useAuth } from "@/lib/auth";
import { ConfirmProvider } from "@/lib/confirm";
import { useOnline } from "@/lib/useOnline";
import { AdminCash } from "@/pages/admin/AdminCash";
import { AdminRefunds } from "@/pages/admin/AdminRefunds";
import { AdminSales } from "@/pages/admin/AdminSales";
import { AdminSettings } from "@/pages/admin/AdminSettings";
import { AdminShops } from "@/pages/admin/AdminShops";
import { AdminUsers } from "@/pages/admin/AdminUsers";
import { AuditLog } from "@/pages/admin/AuditLog";
import { CardManager } from "@/pages/admin/CardManager";
import { DiscountManager } from "@/pages/admin/DiscountManager";
import { PortalLoginPage, RegisterPage, SetupPage } from "@/pages/AuthPages";
import { CallBoardPage } from "@/pages/display/CallBoard";
import { CustomerHome } from "@/pages/my/CustomerHome";
import { PosCatalog } from "@/pages/pos/PosCatalog";
import { LandingPage } from "@/pages/public/Landing";
import { CashPanel } from "@/pages/reception/CashPanel";
import { ChargePanel } from "@/pages/reception/ChargePanel";
import { OrdersBoard } from "@/pages/shop/OrdersBoard";
import { PriceCutManager } from "@/pages/shop/PriceCutManager";
import { ProductManager } from "@/pages/shop/ProductManager";
import { RefundManager } from "@/pages/shop/RefundManager";
import { SetManager } from "@/pages/shop/SetManager";
import { ShopSales } from "@/pages/shop/ShopSales";
import { ShopSettings } from "@/pages/shop/ShopSettings";
import { StaffManager } from "@/pages/shop/StaffManager";
import { StockView } from "@/pages/shop/StockView";
import { useState } from "react";

/** 端末が回線に届いていないときの表示(ログイン画面を含むすべての画面の上に出る) */
function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <div role="status" className="sticky top-0 z-30 bg-amber-400 px-4 py-2 text-center text-sm font-bold text-black">
      通信できません。画面とカートはそのまま使えますが、決済・チャージは電波が戻るまでできません
    </div>
  );
}

const ADMIN_NAV: NavItem[] = [
  { to: "/admin", label: "売上", icon: BarChart3, end: true },
  { to: "/admin/shops", label: "店舗", icon: Store },
  { to: "/admin/users", label: "スタッフ・利用者", icon: Users },
  { to: "/admin/cards", label: "カード", icon: CreditCard },
  { to: "/admin/refunds", label: "返金", icon: Undo2 },
  { to: "/admin/discounts", label: "割引", icon: Percent },
  { to: "/admin/cash", label: "現金", icon: Banknote },
  { to: "/admin/audit", label: "監査ログ", icon: ScrollText },
  { to: "/admin/settings", label: "設定", icon: Settings },
];
const SHOP_NAV: NavItem[] = [
  { to: "/shop", label: "売上", icon: BarChart3, end: true },
  { to: "/shop/register", label: "レジ", icon: Calculator },
  { to: "/shop/orders", label: "注文ステータス", icon: ChefHat },
  { to: "/shop/products", label: "商品", icon: Package },
  { to: "/shop/sets", label: "セット", icon: Layers },
  { to: "/shop/price-cuts", label: "値下げ", icon: Tag },
  { to: "/shop/refunds", label: "返金", icon: Undo2 },
  { to: "/shop/staff", label: "スタッフ", icon: UsersRound },
  { to: "/shop/settings", label: "店舗設定", icon: Settings },
];
const CLERK_NAV: NavItem[] = [
  { to: "/clerk", label: "レジ", icon: Calculator, end: true },
  { to: "/clerk/orders", label: "注文ステータス", icon: ChefHat },
  { to: "/clerk/stock", label: "在庫", icon: Boxes },
];
const RECEPTION_NAV: NavItem[] = [
  { to: "/reception", label: "チャージ・払い戻し", icon: HandCoins, end: true },
  { to: "/reception/cash", label: "現金", icon: Wallet },
];

/** 自店舗のIDを渡して中身を出す(店舗責任者・店員のページ用) */
function WithShop({ children }: { children: (shopId: string) => ReactNode }) {
  const { me } = useAuth();
  if (!me?.user.shopId) return <p className="p-6 text-center text-sm text-muted-foreground">店舗が割り当てられていません。運営にお問い合わせください</p>;
  return <>{children(me.user.shopId)}</>;
}

/** 受付の画面。お客様の対応中の状態を失わないよう、チャージ・払い戻しの画面は切り替えても保持する */
function ReceptionPages() {
  const { pathname } = useLocation();
  const [refreshKey, setRefreshKey] = useState(0);
  const onCash = pathname.startsWith("/reception/cash");
  return (
    <Page width="md">
      <div className={onCash ? "hidden" : ""}>
        <ChargePanel onChanged={() => setRefreshKey((k) => k + 1)} />
      </div>
      {onCash && <CashPanel refreshKey={refreshKey} onChanged={() => setRefreshKey((k) => k + 1)} />}
    </Page>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <ConfirmProvider>
        <BrowserRouter>
          <OfflineBanner />
          <Routes>
            {/* 訪問者・お客様 */}
            <Route path="/" element={<LandingPage />} />
            <Route path="/login" element={<PortalLoginPage portal="customer" />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route path="/setup" element={<SetupPage />} />
            <Route path="/board/:shopId" element={<CallBoardPage />} />
            <Route
              path="/my"
              element={
                <RoleGate roles={["CUSTOMER"]} loginPath="/login">
                  <CustomerHome />
                </RoleGate>
              }
            />

            {/* 全体管理者 */}
            <Route path="/admin/login" element={<PortalLoginPage portal="admin" />} />
            <Route
              path="/admin"
              element={
                <RoleGate roles={["ADMIN"]} loginPath="/admin/login">
                  <ConsoleLayout nav={ADMIN_NAV} brand="全体管理" />
                </RoleGate>
              }
            >
              <Route index element={<AdminSales />} />
              <Route path="shops" element={<Page><AdminShops /></Page>} />
              <Route path="users" element={<Page width="lg"><AdminUsers /></Page>} />
              <Route path="cards" element={<Page><CardManager /></Page>} />
              <Route path="refunds" element={<Page><AdminRefunds /></Page>} />
              <Route path="discounts" element={<Page><DiscountManager /></Page>} />
              <Route path="cash" element={<Page><AdminCash /></Page>} />
              <Route path="audit" element={<Page width="lg"><AuditLog /></Page>} />
              <Route path="settings" element={<Page><AdminSettings /></Page>} />
            </Route>

            {/* 店舗責任者(レジも使える) */}
            <Route path="/shop/login" element={<PortalLoginPage portal="shop" />} />
            <Route
              path="/shop"
              element={
                <RoleGate roles={["SHOP_MANAGER"]} loginPath="/shop/login">
                  <ConsoleLayout nav={SHOP_NAV} brand="店舗管理" />
                </RoleGate>
              }
            >
              <Route index element={<WithShop>{(id) => <ShopSales shopId={id} />}</WithShop>} />
              <Route path="register" element={<WithShop>{(id) => <PosCatalog shopId={id} />}</WithShop>} />
              <Route path="orders" element={<WithShop>{(id) => <OrdersBoard shopId={id} />}</WithShop>} />
              <Route path="products" element={<WithShop>{(id) => <Page><ProductManager shopId={id} /></Page>}</WithShop>} />
              <Route path="sets" element={<WithShop>{(id) => <Page><SetManager shopId={id} /></Page>}</WithShop>} />
              <Route path="price-cuts" element={<WithShop>{(id) => <Page><PriceCutManager shopId={id} /></Page>}</WithShop>} />
              <Route path="refunds" element={<WithShop>{(id) => <Page><RefundManager shopId={id} /></Page>}</WithShop>} />
              <Route path="staff" element={<WithShop>{(id) => <Page><StaffManager shopId={id} /></Page>}</WithShop>} />
              <Route path="settings" element={<WithShop>{(id) => <Page><ShopSettings shopId={id} /></Page>}</WithShop>} />
            </Route>

            {/* 店員 */}
            <Route path="/clerk/login" element={<PortalLoginPage portal="clerk" />} />
            <Route
              path="/clerk"
              element={
                <RoleGate roles={["CLERK"]} loginPath="/clerk/login">
                  <ConsoleLayout nav={CLERK_NAV} brand="レジ" />
                </RoleGate>
              }
            >
              <Route index element={<WithShop>{(id) => <PosCatalog shopId={id} />}</WithShop>} />
              <Route path="orders" element={<WithShop>{(id) => <OrdersBoard shopId={id} />}</WithShop>} />
              <Route path="stock" element={<WithShop>{(id) => <Page><StockView shopId={id} /></Page>}</WithShop>} />
            </Route>

            {/* 受付 */}
            <Route path="/reception/login" element={<PortalLoginPage portal="reception" />} />
            <Route
              path="/reception"
              element={
                <RoleGate roles={["RECEPTION"]} loginPath="/reception/login">
                  <ConsoleLayout nav={RECEPTION_NAV} brand="受付" />
                </RoleGate>
              }
            >
              <Route path="*" element={<ReceptionPages />} />
            </Route>

            {/* 旧アドレス */}
            <Route path="/qr-login" element={<Navigate to="/clerk/login" replace />} />
            <Route path="/reception-login" element={<Navigate to="/reception/login" replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </ConfirmProvider>
    </AuthProvider>
  );
}
