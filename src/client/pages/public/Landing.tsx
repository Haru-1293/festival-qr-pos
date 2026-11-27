import { QrCode, UtensilsCrossed } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { PublicShopDto } from "@shared/api";
import { ShopMenu } from "@/components/ShopMenu";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { ROLE_HOME } from "@/lib/roleHome";

/** 訪問者向けのトップページ。ログイン不要で、参加店舗とメニューを見られる */
export function LandingPage() {
  const { me, settings } = useAuth();
  const [shops, setShops] = useState<PublicShopDto[] | null>(null);
  useEffect(() => {
    api<{ shops: PublicShopDto[] }>("/public/shops")
      .then((r) => setShops(r.shops))
      .catch(() => setShops([]));
  }, []);
  return (
    <div className="min-h-dvh">
      <div className="bg-primary px-4 pb-8 pt-10 text-center text-primary-foreground">
        <div className="mx-auto mb-3 flex size-16 items-center justify-center rounded-2xl bg-white/20">
          <QrCode className="size-9" />
        </div>
        <h1 className="text-2xl font-extrabold">{settings.festivalName}</h1>
        <p className="mt-1 text-sm opacity-90">QRコードでかんたんキャッシュレス</p>
        <div className="mx-auto mt-5 flex max-w-xs flex-col gap-2">
          {me ? (
            <Button asChild size="lg" variant="secondary">
              <Link to={ROLE_HOME[me.user.role]}>マイページへ</Link>
            </Button>
          ) : (
            <>
              <Button asChild size="lg" variant="secondary">
                <Link to="/login">ログイン</Link>
              </Button>
              <Button asChild size="lg" className="bg-white/15 hover:bg-white/25">
                <Link to="/register">はじめての方はこちら</Link>
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6">
        <section className="flex flex-col gap-3">
          <h2 className="flex items-center gap-2 text-lg font-bold">
            <UtensilsCrossed className="size-5" /> 参加店舗とメニュー
          </h2>
          {shops === null && <p className="text-sm text-muted-foreground">読み込み中…</p>}
          {shops?.length === 0 && <p className="text-sm text-muted-foreground">まだ店舗が登録されていません</p>}
          <div className="grid gap-3 md:grid-cols-2">{shops?.map((s) => <ShopMenu key={s.id} shop={s} />)}</div>
        </section>

        <section className="rounded-2xl bg-card p-4 text-sm text-muted-foreground shadow-sm">
          <p className="mb-1 font-bold text-foreground">ご利用の流れ</p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>アカウントを登録する(またはカードを受け取る)</li>
            <li>受付で現金をチャージする</li>
            <li>お店でスマホのQR(またはカード)を見せて支払う</li>
          </ol>
        </section>

        <footer className="flex flex-wrap justify-center gap-x-4 gap-y-1 border-t border-border pt-4 text-xs text-muted-foreground">
          {settings.legal.TERMS !== null && <Link to="/terms" className="underline">利用規約</Link>}
          {settings.legal.PRIVACY !== null && <Link to="/privacy" className="underline">プライバシーポリシー</Link>}
          <span>スタッフの方:</span>
          <Link to="/clerk/login" className="underline">店員</Link>
          <Link to="/shop/login" className="underline">店舗責任者</Link>
          <Link to="/reception/login" className="underline">受付</Link>
          <Link to="/admin/login" className="underline">運営</Link>
        </footer>
      </div>
    </div>
  );
}
