import type { ReceptionQrIssued } from "@shared/api";
import { ROLE_LABELS, type Role } from "@shared/roles";
import { PrintSheet } from "@/components/print/PrintSheet";
import { useAuth } from "@/lib/auth";

/**
 * ログインQR(受付・店員)の表示と印刷。ログインカードとして印刷でき、デザイン(背景画像+位置)を選べる。
 * QRは暗号化して保存されているので、一覧の「QR表示・印刷」から何度でも出せる。
 */
export function LoginQrDialog({
  issued,
  nickname,
  loginId,
  role,
  shopName,
  onClose,
}: {
  issued: ReceptionQrIssued;
  nickname: string;
  loginId?: string | null;
  role?: Role;
  shopName?: string | null;
  onClose: () => void;
}) {
  const { me, settings } = useAuth();
  return (
    <PrintSheet
      kind="LOGIN"
      title={`${nickname} さんのログインQR`}
      canEdit={me?.user.role === "ADMIN"}
      onClose={onClose}
      items={[
        {
          qr: issued.token,
          name: nickname,
          loginId: loginId ?? null,
          role: `${role ? ROLE_LABELS[role] : "スタッフ"}用 ログインカード`,
          festival: settings.festivalName,
          shop: shopName ?? "",
        },
      ]}
      notice={<p className="rounded-xl bg-card p-3 text-sm text-muted-foreground">このQRはパスワードと同じです。一覧の「QR表示・印刷」から、あとで何度でももう一度表示できます(閲覧は記録されます)。</p>}
    />
  );
}
