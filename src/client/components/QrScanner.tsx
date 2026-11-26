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
export function QrScanner({ onScan, onClose, accept }: { onScan: (value: string) => void; onClose: () => void; accept?: (value: string) => string | null }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  // 読み取れないQR(種類ちがい)のとき、読み取り画面の上に警告を出す。閉じるまで読み取りを止める
  const [rejected, setRejected] = useState<string | null>(null);
  const pausedRef = useRef(false);
  const ignoreUntil = useRef(0);
  // 呼び出し側が毎回新しい関数を渡しても、カメラを起動し直さないよう ref に持つ
  const onScanRef = useRef(onScan);
  const acceptRef = useRef(accept);
  onScanRef.current = onScan;
  acceptRef.current = accept;

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
        if (pausedRef.current || Date.now() < ignoreUntil.current) {
          timer = window.setTimeout(() => void tick(), 200);
          return;
        }
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
            const msg = acceptRef.current?.(value) ?? null;
            if (msg) {
              pausedRef.current = true;
              setRejected(msg);
              try {
                navigator.vibrate?.(200);
              } catch {
                /* 振動に対応していない端末 */
              }
            } else {
              stopped = true;
              onScanRef.current(value);
              return;
            }
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
  }, []);

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
      {rejected && (
        <ScanAlertPopup
          message={rejected}
          onClose={() => {
            setRejected(null);
            ignoreUntil.current = Date.now() + 1200; // 同じQRをすぐ読み直さない
            pausedRef.current = false;
          }}
        />
      )}
    </div>
  );
}

/**
 * 読み取りの警告ポップアップ。読み取り画面(z-50)よりさらに上に出る。
 * 種類ちがいのQR・使用済みのクーポンなどを、見落とさないよう画面の中央で知らせる。
 */
export function ScanAlertPopup({ message, title = "読み取れません", onClose }: { message: string; title?: string; onClose: () => void }) {
  const ok = useRef<HTMLButtonElement>(null);
  useEffect(() => ok.current?.focus(), []);
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-6" role="alertdialog" aria-modal="true" aria-label={title}>
      <div className="w-full max-w-sm rounded-2xl bg-card p-5 shadow-2xl">
        <p className="text-lg font-extrabold text-destructive">{title}</p>
        <p className="mt-2 whitespace-pre-line text-base font-semibold leading-relaxed">{message}</p>
        <button ref={ok} className="mt-5 h-12 w-full rounded-xl bg-primary text-base font-bold text-primary-foreground" onClick={onClose}>
          OK
        </button>
      </div>
    </div>
  );
}
