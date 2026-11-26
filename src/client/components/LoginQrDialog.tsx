import { Printer } from "lucide-react";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import type { ReceptionQrIssued } from "@shared/api";
import { ROLE_LABELS, type Role } from "@shared/roles";
import { QrCodeView } from "@/components/QrCodeView";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";

/**
 * 発行直後だけ表示するログインQR。生トークンはサーバーに保存されないため、閉じると再表示できない。
 * 印刷すると、この「ログインカード」だけが出る(本人に渡す用: 役割・表示名・ログインID・QR・使い方)。
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
  const { settings } = useAuth();
  useEffect(() => {
    document.body.classList.add("print-sheet-open");
    return () => document.body.classList.remove("print-sheet-open");
  }, []);
  const roleLabel = role ? ROLE_LABELS[role] : "スタッフ";
  return createPortal(
    <div className="sheet-host fixed inset-0 z-50 flex flex-col items-center overflow-auto bg-black/60 p-4 print:block print:bg-white print:p-0" role="dialog" aria-label={`${nickname} さんのログインQR`}>
      <div className="my-auto flex w-full max-w-sm flex-col gap-3 print:max-w-none print:gap-0">
        <p className="rounded-xl bg-card p-3 text-sm text-muted-foreground print:hidden">
          この画面を閉じると、QRは再表示できません。印刷して本人に渡してください(紛失したときは再発行できます)。
        </p>

        {/* ログインカード(画面でもこのまま見える。印刷では用紙の上部に等倍で出る) */}
        <article className="login-card overflow-hidden rounded-2xl border-2 border-primary bg-white text-black shadow-xl print:mx-auto print:shadow-none">
          <header className="flex items-center justify-between gap-2 bg-primary px-4 py-2.5 text-primary-foreground">
            <span className="truncate text-sm font-bold">{settings.festivalName}</span>
            <span className="shrink-0 rounded-full bg-white px-2.5 py-0.5 text-xs font-extrabold text-primary">{roleLabel}用 ログインカード</span>
          </header>
          <div className="flex flex-col items-center gap-3 px-4 pb-4 pt-4">
            <div className="w-full text-center">
              {shopName && <p className="text-xs font-semibold text-neutral-500">{shopName}</p>}
              <p className="break-words text-2xl font-extrabold leading-tight">{nickname}</p>
              <p className="mt-1.5 text-xs text-neutral-500">ログインID</p>
              <p className="break-all font-mono text-lg font-bold">{loginId || "(QRのみ・IDなし)"}</p>
            </div>
            <div className="rounded-xl border border-neutral-300 bg-white p-2">
              <QrCodeView value={issued.token} size={220} />
            </div>
            <ol className="w-full list-decimal space-y-0.5 pl-5 text-xs leading-relaxed text-neutral-700">
              <li>ログイン画面で「QRでログイン」を押す</li>
              <li>このQRを読み取る(または ID とパスワードを入力)</li>
            </ol>
            <p className="w-full border-t border-dashed border-neutral-400 pt-2 text-center text-[11px] font-semibold text-red-700">
              このQRはパスワードと同じです。他の人に見せない・写真に撮らない・なくさない
            </p>
          </div>
        </article>

        <p className="break-all rounded-lg bg-card p-2 text-center font-mono text-xs print:hidden">{issued.token}</p>
        <div className="flex gap-2 print:hidden">
          <Button variant="secondary" className="flex-1" onClick={() => window.print()}>
            <Printer /> 印刷
          </Button>
          <Button className="flex-1" onClick={onClose}>
            閉じる
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
