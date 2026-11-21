import jsQR from "jsqr";
import { useEffect, useRef, useState } from "react";

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}
type BarcodeDetectorCtor = new (opts: { formats: string[] }) => BarcodeDetectorLike;

export function scannerSupported(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
}

/**
 * カメラでQRを読み取る。標準の BarcodeDetector を使い、非対応の端末では案内を出す
 * (その場合は呼び出し側の文字入力を使う)。1回読み取ったら onScan を呼んでカメラを止める。
 */
export function QrScanner({ onScan, onClose }: { onScan: (value: string) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let stopped = false;
    let timer: number | undefined;

    async function start() {
      if (!scannerSupported()) {
        setError("この端末ではカメラでの読み取りに対応していません。QRの文字列を入力してください");
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      } catch (e) {
        const name = (e as { name?: string }).name;
        setError(
          name === "NotAllowedError" || name === "SecurityError"
            ? "カメラの使用が許可されていません。ブラウザのアドレス欄の設定から、このサイトのカメラを「許可」にしてください"
            : name === "NotFoundError"
              ? "カメラが見つかりませんでした。QRの文字列を入力してください"
              : "カメラを使えませんでした。他のアプリがカメラを使っていないか確認してください",
        );
        return;
      }
      const video = videoRef.current;
      if (!video || stopped) return;
      video.srcObject = stream;
      await video.play().catch(() => undefined);
      // 標準の BarcodeDetector があればそれを、なければ同梱の jsQR で読む(iPhone の Safari など)
      const Detector = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
      const detector = Detector ? new Detector({ formats: ["qr_code"] }) : null;
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      const tick = async () => {
        if (stopped) return;
        try {
          let value: string | undefined;
          if (detector) {
            value = (await detector.detect(video))[0]?.rawValue;
          } else if (ctx && video.videoWidth > 0) {
            const scale = Math.min(1, 640 / video.videoWidth);
            canvas.width = Math.round(video.videoWidth * scale);
            canvas.height = Math.round(video.videoHeight * scale);
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            value = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" })?.data;
          }
          if (value) {
            stopped = true;
            onScan(value);
            return;
          }
        } catch {
          // 読み取り失敗は無視して次のフレームで再試行する
        }
        timer = window.setTimeout(() => void tick(), 200);
      };
      void tick();
    }
    void start();

    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onScan]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/90 p-4">
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-4">
        {error ? (
          <p className="rounded-lg bg-card p-4 text-sm">{error}</p>
        ) : (
          <video ref={videoRef} playsInline muted className="aspect-square w-full rounded-lg bg-black object-cover" />
        )}
        <button className="h-12 w-full rounded-lg bg-card text-base font-semibold" onClick={onClose}>
          閉じる
        </button>
      </div>
    </div>
  );
}
