import { Printer } from "lucide-react";
import type { ReceptionQrIssued } from "@shared/api";
import { QrCodeView } from "@/components/QrCodeView";
import { Button } from "@/components/ui/button";

/** 発行直後だけ表示するログインQR。生トークンはサーバーに保存されないため、閉じると再表示できない */
export function LoginQrDialog({ issued, nickname, onClose }: { issued: ReceptionQrIssued; nickname: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 print:static print:bg-white print:p-0">
      <div className="w-full max-w-sm rounded-2xl bg-card p-5 shadow-xl print:max-w-none print:shadow-none">
        <h2 className="text-lg font-bold">{nickname} さんのログインQR</h2>
        <p className="mt-1 text-sm text-muted-foreground print:hidden">
          この画面を閉じると再表示できません。印刷して本人に渡してください(紛失時は再発行できます)。
        </p>
        <div className="my-4 flex justify-center">
          <QrCodeView value={issued.token} size={260} />
        </div>
        <p className="break-all rounded-lg bg-muted p-2 text-center font-mono text-xs print:hidden">{issued.token}</p>
        <div className="mt-4 flex gap-2 print:hidden">
          <Button variant="outline" className="flex-1" onClick={() => window.print()}>
            <Printer /> 印刷
          </Button>
          <Button className="flex-1" onClick={onClose}>
            閉じる
          </Button>
        </div>
      </div>
    </div>
  );
}
