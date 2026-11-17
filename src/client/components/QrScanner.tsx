import { useEffect, useRef, useState } from "react";

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}
type BarcodeDetectorCtor = new (opts: { formats: string[] }) => BarcodeDetectorLike;

export function scannerSupported(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && "BarcodeDetector" in window;
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
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      } catch {
        setError("カメラを使えませんでした。ブラウザのカメラ許可を確認してください");
        return;
      }
      const video = videoRef.current;
      if (!video || stopped) return;
      video.srcObject = stream;
      await video.play().catch(() => undefined);
      const Detector = (window as unknown as { BarcodeDetector: BarcodeDetectorCtor }).BarcodeDetector;
      const detector = new Detector({ formats: ["qr_code"] });
      const tick = async () => {
        if (stopped) return;
        try {
          const codes = await detector.detect(video);
          if (codes[0]?.rawValue) {
            stopped = true;
            onScan(codes[0].rawValue);
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
