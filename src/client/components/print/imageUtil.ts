/** 画像を縮小・圧縮して data URL(JPEG)にする。D1の1行に収める(約850KB以下)ため。透明部分は白になる */
export async function imageToDataUrl(file: File, limit = 850_000): Promise<string> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error("PNG・JPEG・WebPの画像を選んでください");
  if (file.size > 25 * 1024 * 1024) throw new Error("画像が大きすぎます(25MBまで)");
  const bmp = await createImageBitmap(file);
  let max = 1800;
  while (max >= 500) {
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("画像を処理できませんでした");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    for (const q of [0.9, 0.8, 0.7, 0.6, 0.5]) {
      const url = canvas.toDataURL("image/jpeg", q);
      if (url.length <= limit) {
        bmp.close();
        return url;
      }
    }
    max = Math.round(max * 0.75);
  }
  bmp.close();
  throw new Error("画像を十分に小さくできませんでした。別の画像を選んでください");
}

/** R2に保存する画像: 縮小・再圧縮せず、そのまま読み込む(上限はサーバーの設定) */
export async function fileToDataUrl(file: File, maxBytes: number): Promise<string> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error("PNG・JPEG・WebPの画像を選んでください");
  if (file.size > maxBytes) throw new Error(`画像が大きすぎます(${Math.floor(maxBytes / 1_000_000)}MBまで)`);
  return await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("画像を読み込めませんでした"));
    r.readAsDataURL(file);
  });
}

/** data URL を Blob にする(アップロード用) */
export function dataUrlToBlob(url: string): Blob {
  const m = /^data:([^;]+);base64,(.*)$/.exec(url);
  if (!m) throw new Error("画像のデータが正しくありません");
  const bin = atob(m[2]!);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: m[1] });
}

/** 画像のURL(保存済み)・data URL のどちらでも、data URL にして返す(XMLに入れるため) */
export async function toDataUrl(src: string): Promise<string> {
  if (src.startsWith("data:")) return src;
  const res = await fetch(src, { credentials: "same-origin" });
  if (!res.ok) throw new Error("背景画像を読み込めませんでした");
  const blob = await res.blob();
  return await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("背景画像を読み込めませんでした"));
    r.readAsDataURL(blob);
  });
}
