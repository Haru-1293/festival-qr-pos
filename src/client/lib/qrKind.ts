/** QRの種類(文字列の頭で見分ける)。スタッフのログインQR(店員)とカードのQRは同じ `FES1:C:` で始まる */
export type QrKind = "WALLET" | "CARD_OR_CLERK" | "RECEPTION" | "COUPON" | "UNKNOWN";

export function qrKind(value: string): QrKind {
  const v = value.trim();
  if (v.startsWith("FES1:U:")) return "WALLET";
  if (v.startsWith("FES1:C:")) return "CARD_OR_CLERK";
  if (v.startsWith("FES1:R:")) return "RECEPTION";
  if (v.startsWith("FES1:K:")) return "COUPON";
  return "UNKNOWN";
}

const KIND_NAME: Record<QrKind, string> = {
  WALLET: "お客様のスマホの支払いQR",
  CARD_OR_CLERK: "カード(またはスタッフ)のQR",
  RECEPTION: "受付のログインQR",
  COUPON: "クーポンのQR",
  UNKNOWN: "このシステムのものではないQR",
};

/**
 * 「この場面で読み取れるQR」を指定して、読み取れないQRのときの案内文を返す関数を作る(QrScanner の accept に渡す)。
 * 読み取れるなら null。
 */
export function expectQr(expected: QrKind[], what: string): (value: string) => string | null {
  return (value) => {
    const k = qrKind(value);
    if (expected.includes(k)) return null;
    if (expected.length === 1 && expected[0] === "COUPON") return "クーポン以外のQRコードが読み込まれました。クーポンのQRを読み取ってください";
    return `${k === "UNKNOWN" ? "このシステムのQRコードではありません" : `${KIND_NAME[k]}が読み込まれました`}。${what}を読み取ってください`;
  };
}
