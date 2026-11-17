/** 顧客のスマホ支払QR。`FES1:U:` + 192ビット乱数(Base64URL 32文字) */
export const WALLET_QR_PREFIX = "FES1:U:";
export const WALLET_QR_PATTERN = /^FES1:U:[A-Za-z0-9_-]{32}$/;
