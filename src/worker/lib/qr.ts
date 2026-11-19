/** 顧客のスマホ支払QR。`FES1:U:` + 192ビット乱数(Base64URL 32文字) */
export const WALLET_QR_PREFIX = "FES1:U:";
export const WALLET_QR_PATTERN = /^FES1:U:[A-Za-z0-9_-]{32}$/;

/** 物理カードの固定QR。`FES1:C:` + 192ビット乱数(Base64URL 32文字) */
export const CARD_QR_PREFIX = "FES1:C:";
export const CARD_QR_PATTERN = /^FES1:C:[A-Za-z0-9_-]{32}$/;
