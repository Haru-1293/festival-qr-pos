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
