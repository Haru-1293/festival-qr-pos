import QRCode from "qrcode";
import { useEffect, useState } from "react";

/** 文字列をQRコード画像として表示する(受付ログインQRの印刷・表示用) */
export function QrCodeView({ value, size = 240 }: { value: string; size?: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(value, { width: size * 2, margin: 2, errorCorrectionLevel: "M" })
      .then((url) => alive && setSrc(url))
      .catch(() => alive && setSrc(null));
    return () => {
      alive = false;
    };
  }, [value, size]);
  if (!src) return <div style={{ width: size, height: size }} className="animate-pulse rounded-lg bg-muted" />;
  return <img src={src} width={size} height={size} alt="QRコード" className="rounded-lg bg-white" />;
}
