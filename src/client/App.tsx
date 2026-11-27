import {
  Ban,
  BarChart3,
  Banknote,
  Boxes,
  History,
  Home,
  UserCog,
  Calculator,
  ChefHat,
  CreditCard,
  HandCoins,
  Layers,
  Package,
  ScanSearch,
  Percent,
  FileText,
  ScrollText,
  Settings,
  Store,
  Tag,
  Ticket,
  Undo2,
  Users,
  UsersRound,
  Wallet,
} from "lucide-react";
import { lazy, Suspense, useState, type ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { ConsoleLayout, Page, type NavItem } from "@/components/layout/ConsoleLayout";
import { RoleGate } from "@/components/layout/RoleGate";
import { AuthProvider, useAuth } from "@/lib/auth";
import { ConfirmProvider } from "@/lib/confirm";
import { useOnline } from "@/lib/useOnline";
import { PortalLoginPage, RegisterPage, SetupPage } from "@/pages/AuthPages";
import { LandingPage } from "@/pages/public/Landing";

const AdminCash = lazy(() => import("@/pages/admin/AdminCash").then((m) => ({ default: m.AdminCash })));
const AdminRefunds = lazy(() => import("@/pages/admin/AdminRefunds").then((m) => ({ default: m.AdminRefunds })));
const AdminLegal = lazy(() => import("@/pages/admin/AdminLegal").then((m) => ({ default: m.AdminLegal })));
const LegalPage = lazy(() => import("@/pages/public/LegalPage").then((m) => ({ default: m.LegalPage })));
const AdminSales = lazy(() => import("@/pages/admin/AdminSales").then((m) => ({ default: m.AdminSales })));
const AdminSettings = lazy(() => import("@/pages/admin/AdminSettings").then((m) => ({ default: m.AdminSettings })));
const AdminShopDetail = lazy(() => import("@/pages/admin/AdminShopDetail").then((m) => ({ default: m.AdminShopDetail })));
const AdminShops = lazy(() => import("@/pages/admin/AdminShops").then((m) => ({ default: m.AdminShops })));
const AdminUsers = lazy(() => import("@/pages/admin/AdminUsers").then((m) => ({ default: m.AdminUsers })));
const AuditLog = lazy(() => import("@/pages/admin/AuditLog").then((m) => ({ default: m.AuditLog })));
const CardManager = lazy(() => import("@/pages/admin/CardManager").then((m) => ({ default: m.CardManager })));
const DiscountManager = lazy(() => import("@/pages/admin/DiscountManager").then((m) => ({ default: m.DiscountManager })));
const CallBoardPage = lazy(() => import("@/pages/display/CallBoard").then((m) => ({ default: m.CallBoardPage })));
const CustomerHistory = lazy(() => import("@/pages/my/CustomerHome").then((m) => ({ default: m.CustomerHistory })));
const CustomerShops = lazy(() => import("@/pages/my/CustomerShops").then((m) => ({ default: m.CustomerShops })));
const CustomerAccount = lazy(() => import("@/pages/my/CustomerHome").then((m) => ({ default: m.CustomerAccount })));
const CustomerHome = lazy(() => import("@/pages/my/CustomerHome").then((m) => ({ default: m.CustomerHome })));
const BalanceInquiry = lazy(() => import("@/pages/balance/BalanceInquiry").then((m) => ({ default: m.BalanceInquiry })));
const PosCatalog = lazy(() => import("@/pages/pos/PosCatalog").then((m) => ({ default: m.PosCatalog })));
const CashPanel = lazy(() => import("@/pages/reception/CashPanel").then((m) => ({ default: m.CashPanel })));
const ChargePanel = lazy(() => import("@/pages/reception/ChargePanel").then((m) => ({ default: m.ChargePanel })));
const OrderCancel = lazy(() => import("@/pages/shop/OrderCancel").then((m) => ({ default: m.OrderCancel })));
const OrdersBoard = lazy(() => import("@/pages/shop/OrdersBoard").then((m) => ({ default: m.OrdersBoard })));
const PriceCutManager = lazy(() => import("@/pages/shop/PriceCutManager").then((m) => ({ default: m.PriceCutManager })));
const ProductManager = lazy(() => import("@/pages/shop/ProductManager").then((m) => ({ default: m.ProductManager })));
const RefundManager = lazy(() => import("@/pages/shop/RefundManager").then((m) => ({ default: m.RefundManager })));
const SetManager = lazy(() => import("@/pages/shop/SetManager").then((m) => ({ default: m.SetManager })));
const ShopCoupons = lazy(() => import("@/pages/shop/ShopCoupons").then((m) => ({ default: m.ShopCoupons })));
const ShopDetailView = lazy(() => import("@/pages/shop/ShopDetailView").then((m) => ({ default: m.ShopDetailView })));
const ShopSettings = lazy(() => import("@/pages/shop/ShopSettings").then((m) => ({ default: m.ShopSettings })));
const StaffManager = lazy(() => import("@/pages/shop/StaffManager").then((m) => ({ default: m.StaffManager })));
const StockView = lazy(() => import("@/pages/shop/StockView").then((m) => ({ default: m.StockView })));

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

const CUSTOMER_NAV: NavItem[] = [
  { to: "/my", label: "ホーム", icon: Home, end: true },
  { to: "/my/shops", label: "店舗・メニュー", icon: Store },
  { to: "/my/history", label: "利用履歴", icon: History },
  { to: "/my/account", label: "アカウント", icon: UserCog },
];
const ADMIN_NAV: NavItem[] = [
  { to: "/admin", label: "売上", icon: BarChart3, end: true },
  { to: "/admin/shops", label: "店舗", icon: Store },
  { to: "/admin/users", label: "スタッフ・利用者", icon: Users },
  { to: "/admin/cards", label: "カード", icon: CreditCard },
  { to: "/admin/refunds", label: "返金", icon: Undo2 },
  { to: "/admin/discounts", label: "割引", icon: Percent },
  { to: "/admin/balance", label: "残高照会", icon: ScanSearch },
  { to: "/admin/cash", label: "現金", icon: Banknote },
  { to: "/admin/audit", label: "監査ログ", icon: ScrollText },
  { to: "/admin/legal", label: "規約", icon: FileText },
  { to: "/admin/settings", label: "設定", icon: Settings },
];
const SHOP_NAV: NavItem[] = [
  { to: "/shop", label: "売上", icon: BarChart3, end: true },
  { to: "/shop/register", label: "レジ", icon: Calculator },
  { to: "/shop/orders", label: "注文ステータス", icon: ChefHat },
  { to: "/shop/cancel", label: "注文取消し", icon: Ban },
  { to: "/shop/products", label: "商品", icon: Package },
  { to: "/shop/sets", label: "セット", icon: Layers },
  { to: "/shop/price-cuts", label: "値下げ", icon: Tag },
  { to: "/shop/coupons", label: "クーポン", icon: Ticket },
  { to: "/shop/refunds", label: "返金", icon: Undo2 },
  { to: "/shop/balance", label: "残高照会", icon: ScanSearch },
  { to: "/shop/staff", label: "スタッフ", icon: UsersRound },
  { to: "/shop/settings", label: "店舗設定", icon: Settings },
];
const CLERK_NAV: NavItem[] = [
  { to: "/clerk", label: "レジ", icon: Calculator, end: true },
  { to: "/clerk/orders", label: "注文ステータス", icon: ChefHat },
  { to: "/clerk/cancel", label: "注文取消し", icon: Ban },
  { to: "/clerk/stock", label: "在庫", icon: Boxes },
  { to: "/clerk/balance", label: "残高照会", icon: ScanSearch },
];
const RECEPTION_NAV: NavItem[] = [
  { to: "/reception", label: "チャージ・払い戻し", icon: HandCoins, end: true },
  { to: "/reception/balance", label: "残高照会", icon: ScanSearch },
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
  const onBalance = pathname.startsWith("/reception/balance");
  return (
    <Page width="md">
      <div className={onCash || onBalance ? "hidden" : ""}>
        <ChargePanel onChanged={() => setRefreshKey((k) => k + 1)} />
      </div>
      {onBalance && <BalanceInquiry />}
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
          <Suspense fallback={<div className="p-8 text-center text-sm text-muted-foreground">読み込み中…</div>}>
            <Routes>
              {/* 訪問者・お客様 */}
              <Route path="/" element={<LandingPage />} />
              <Route path="/login" element={<PortalLoginPage portal="customer" />} />
              <Route path="/register" element={<RegisterPage />} />
              <Route path="/terms" element={<LegalPage kind="TERMS" />} />
              <Route path="/privacy" element={<LegalPage kind="PRIVACY" />} />
              <Route path="/setup" element={<SetupPage />} />
              <Route path="/board/:shopId" element={<CallBoardPage />} />
              <Route
                path="/my"
                element={
                  <RoleGate roles={["CUSTOMER"]} loginPath="/login">
                    <ConsoleLayout nav={CUSTOMER_NAV} brand="マイページ" />
                  </RoleGate>
                }
              >
                <Route index element={<CustomerHome />} />
                <Route path="shops" element={<CustomerShops />} />
                <Route path="history" element={<CustomerHistory />} />
                <Route path="account" element={<CustomerAccount />} />
              </Route>

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
                <Route
                  path="shops/:shopId"
                  element={
                    <Page width="lg">
                      <AdminShopDetail />
                    </Page>
                  }
                />
                <Route
                  path="shops"
                  element={
                    <Page>
                      <AdminShops />
                    </Page>
                  }
                />
                <Route
                  path="users"
                  element={
                    <Page width="lg">
                      <AdminUsers />
                    </Page>
                  }
                />
                <Route
                  path="cards"
                  element={
                    <Page>
                      <CardManager />
                    </Page>
                  }
                />
                <Route
                  path="refunds"
                  element={
                    <Page>
                      <AdminRefunds />
                    </Page>
                  }
                />
                <Route
                  path="discounts"
                  element={
                    <Page>
                      <DiscountManager />
                    </Page>
                  }
                />
                <Route
                  path="balance"
                  element={
                    <Page>
                      <BalanceInquiry />
                    </Page>
                  }
                />
                <Route
                  path="cash"
                  element={
                    <Page>
                      <AdminCash />
                    </Page>
                  }
                />
                <Route
                  path="audit"
                  element={
                    <Page width="lg">
                      <AuditLog />
                    </Page>
                  }
                />
                <Route
                  path="legal"
                  element={
                    <Page>
                      <AdminLegal />
                    </Page>
                  }
                />
                <Route
                  path="settings"
                  element={
                    <Page>
                      <AdminSettings />
                    </Page>
                  }
                />
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
                <Route
                  index
                  element={
                    <WithShop>
                      {(id) => (
                        <Page width="lg">
                          <ShopDetailView shopId={id} />
                        </Page>
                      )}
                    </WithShop>
                  }
                />
                <Route
                  path="coupons"
                  element={
                    <WithShop>
                      {(id) => (
                        <Page width="lg">
                          <ShopCoupons shopId={id} />
                        </Page>
                      )}
                    </WithShop>
                  }
                />
                <Route path="register" element={<WithShop>{(id) => <PosCatalog shopId={id} />}</WithShop>} />
                <Route path="orders" element={<WithShop>{(id) => <OrdersBoard shopId={id} />}</WithShop>} />
                <Route path="cancel" element={<WithShop>{(id) => <OrderCancel shopId={id} />}</WithShop>} />
                <Route
                  path="balance"
                  element={
                    <Page>
                      <BalanceInquiry />
                    </Page>
                  }
                />
                <Route
                  path="products"
                  element={
                    <WithShop>
                      {(id) => (
                        <Page>
                          <ProductManager shopId={id} />
                        </Page>
                      )}
                    </WithShop>
                  }
                />
                <Route
                  path="sets"
                  element={
                    <WithShop>
                      {(id) => (
                        <Page>
                          <SetManager shopId={id} />
                        </Page>
                      )}
                    </WithShop>
                  }
                />
                <Route
                  path="price-cuts"
                  element={
                    <WithShop>
                      {(id) => (
                        <Page>
                          <PriceCutManager shopId={id} />
                        </Page>
                      )}
                    </WithShop>
                  }
                />
                <Route
                  path="refunds"
                  element={
                    <WithShop>
                      {(id) => (
                        <Page>
                          <RefundManager shopId={id} />
                        </Page>
                      )}
                    </WithShop>
                  }
                />
                <Route
                  path="staff"
                  element={
                    <WithShop>
                      {(id) => (
                        <Page>
                          <StaffManager shopId={id} />
                        </Page>
                      )}
                    </WithShop>
                  }
                />
                <Route
                  path="settings"
                  element={
                    <WithShop>
                      {(id) => (
                        <Page>
                          <ShopSettings shopId={id} />
                        </Page>
                      )}
                    </WithShop>
                  }
                />
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
                <Route path="cancel" element={<WithShop>{(id) => <OrderCancel shopId={id} />}</WithShop>} />
                <Route
                  path="balance"
                  element={
                    <Page>
                      <BalanceInquiry />
                    </Page>
                  }
                />
                <Route
                  path="stock"
                  element={
                    <WithShop>
                      {(id) => (
                        <Page>
                          <StockView shopId={id} />
                        </Page>
                      )}
                    </WithShop>
                  }
                />
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
                <Route index element={<ReceptionPages />} />
                <Route path="*" element={<ReceptionPages />} />
              </Route>

              {/* 旧アドレス */}
              <Route path="/qr-login" element={<Navigate to="/clerk/login" replace />} />
              <Route path="/reception-login" element={<Navigate to="/reception/login" replace />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
      </ConfirmProvider>
    </AuthProvider>
  );
}
